// Step 9: rate limits and named administrator accounts with roles. Real SQLite, the real routes.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { NextRequest } from "next/server";

import { createSession, resetLoginAttempts } from "@/lib/admin-auth";
import { checkRate, rateLimited, RATES, resetRates } from "@/server/rate-limit";

const dir = mkdtempSync(path.join(tmpdir(), "silpi-security-"));
const ADMIN = "test-admin-token-0123456789abcdef";
const PASSWORD = "a-long-test-password";
const GOOD = "a-correct-horse-battery";
const admin = { authorization: `Bearer ${ADMIN}` };
let seq = 0;

type Init = { method?: string; body?: object; headers?: Record<string, string>; cookie?: string; ip?: string };
function req(url: string, init: Init = {}): NextRequest {
  const headers: Record<string, string> = { host: "localhost:3000", origin: "http://localhost:3000", "x-forwarded-for": init.ip ?? `10.5.${(++seq >> 8) & 255}.${seq & 255}`, ...(init.headers ?? {}) };
  if (init.cookie) headers.cookie = init.cookie;
  if (init.body) headers["content-type"] = "application/json";
  return new NextRequest(`http://localhost:3000${url}`, { method: init.method ?? "GET", headers, body: init.body ? JSON.stringify(init.body) : undefined });
}
const mods = async () => ({
  a: await import("@/server/audit"),
  acc: await import("@/server/admin-accounts"),
  session: await import("@/app/api/admin/session/route"),
  admins: await import("@/app/api/admin/admins/route"),
  audit: await import("@/app/api/admin/audit/route"),
  coupons: await import("@/app/api/admin/coupons/route"),
  db: await import("@/lib/business/db"),
});

before(() => {
  process.env.SILPI_DB_PATH = path.join(dir, "security.db");
  process.env.SILPI_ADMIN_TOKEN = ADMIN;
  delete process.env.ANTHROPIC_API_KEY;
});
beforeEach(() => { resetRates(); resetLoginAttempts(); });
after(() => {
  const cached = globalThis as unknown as { silpiDb?: { close(): void } };
  cached.silpiDb?.close();
  delete cached.silpiDb;
  rmSync(dir, { recursive: true, force: true });
});

// =================================================================================================
describe("1. the rate limiter", () => {
  const rule = { name: "t", limit: 3, windowMs: 10_000 };
  it("lets a limit's worth through, then refuses with how long to wait, without counting the refused", () => {
    const t = 1_000_000;
    assert.deepEqual([checkRate(rule, "a", t).ok, checkRate(rule, "a", t + 1000).ok, checkRate(rule, "a", t + 2000).remaining], [true, true, 0]);
    const no = checkRate(rule, "a", t + 3000);
    assert.deepEqual([no.ok, no.retryAfterSeconds], [false, 7], "the oldest request leaves the window at t+10s");
    checkRate(rule, "a", t + 4000);
    checkRate(rule, "a", t + 5000);
    assert.equal(checkRate(rule, "a", t + 10_001).ok, true, "refused requests were not counted, so waiting is enough");
  });
  it("counts each key and each rule on its own", () => {
    const t = 5_000_000;
    for (let i = 0; i < 3; i++) checkRate(rule, "x", t);
    assert.equal(checkRate(rule, "x", t).ok, false);
    assert.equal(checkRate(rule, "y", t).ok, true, "another key");
    assert.equal(checkRate({ ...rule, name: "other" }, "x", t).ok, true, "another rule");
  });
  it("answers 429 with Retry-After and a plain message", async () => {
    for (let i = 0; i < RATES.billingWrite.limit; i++) assert.equal(rateLimited(RATES.billingWrite, "org1"), null);
    const res = rateLimited(RATES.billingWrite, "org1")!;
    assert.equal(res.status, 429);
    assert.ok(Number(res.headers.get("Retry-After")) >= 1);
    const body = await res.json();
    assert.deepEqual([body.success, body.code], [false, "rate-limited"]);
    assert.match(body.error, /Try again in \d+ seconds?/);
  });
  it("does not grow without bound when it is flooded with different keys", () => {
    const t = 9_000_000;
    for (let i = 0; i < 25_000; i++) checkRate(rule, `flood-${i}`, t);
    assert.equal(checkRate(rule, "after-the-flood", t).ok, true, "still working, and the memory was cleared");
  });
});

// =================================================================================================
describe("2. the limits on real routes", () => {
  async function customer(name: string) {
    const users = await import("@/app/api/admin/users/route");
    const login = await import("@/app/api/auth/login/route");
    const email = `owner@${name}.example`;
    const made = await users.POST(req("/api/admin/users", { method: "POST", headers: admin, body: { email, name: email, password: PASSWORD, newOrg: { name, type: "agency" } } }));
    assert.equal(made.status, 200, await made.clone().text());
    const res = await login.POST(req("/api/auth/login", { method: "POST", body: { email, password: PASSWORD } }));
    return `silpi_session=${/silpi_session=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")![1]}`;
  }
  it("AI chat: one organization hitting its limit is refused while another carries on", async () => {
    const chat = await import("@/app/api/workspace/ai/chat/route");
    const a = await customer("rate-a");
    const b = await customer("rate-b");
    const send = (cookie: string) => chat.POST(req("/api/workspace/ai/chat", { method: "POST", cookie, headers: { "idempotency-key": `rate-${++seq}-${Math.random().toString(36).slice(2)}` }, body: { model: "silpi-demo", messages: [{ role: "user", content: "hi" }], maxOutputTokens: 50 } }));
    for (let i = 0; i < RATES.aiChat.limit; i++) assert.equal((await send(a)).status, 200, `request ${i + 1}`);
    const refused = await send(a);
    assert.equal(refused.status, 429);
    assert.ok(refused.headers.get("Retry-After"));
    assert.equal((await send(b)).status, 200, "another organization is not affected");
  });
  it("billing changes: limited per organization, and reading is not limited", async () => {
    const cancel = await import("@/app/api/workspace/billing/cancel/route");
    const billing = await import("@/app/api/workspace/billing/route");
    const cookie = await customer("rate-billing");
    const post = () => cancel.POST(req("/api/workspace/billing/cancel", { method: "POST", cookie, body: { action: "keep" } }));
    for (let i = 0; i < RATES.billingWrite.limit; i++) assert.notEqual((await post()).status, 429);
    assert.equal((await post()).status, 429);
    assert.equal((await billing.GET(req("/api/workspace/billing", { cookie }))).status, 200, "looking at the page still works");
  });
  it("the webhook address is limited per provider and client, so a flood cannot starve a real provider's notices from elsewhere", async () => {
    const hook = await import("@/app/api/webhooks/[provider]/route");
    const ctx = { params: Promise.resolve({ provider: "nobody" }) };
    const post = (ip: string) => hook.POST(req("/api/webhooks/nobody", { method: "POST", ip, body: { x: 1 } }), ctx);
    for (let i = 0; i < RATES.webhook.limit; i++) assert.equal((await post("203.0.113.9")).status, 404);
    assert.equal((await post("203.0.113.9")).status, 429);
    assert.equal((await post("198.51.100.4")).status, 404, "another address is unaffected");
  });
  it("administrator changes are limited per client; looking is not", async () => {
    const { coupons, audit } = await mods();
    const put = () => coupons.PUT(req("/api/admin/coupons", { method: "PUT", ip: "192.0.2.77", headers: admin, body: { code: "!!" } }));
    for (let i = 0; i < RATES.adminWrite.limit; i++) assert.equal((await put()).status, 400);
    assert.equal((await put()).status, 429);
    assert.equal((await audit.GET(req("/api/admin/audit", { ip: "192.0.2.77", headers: admin }))).status, 200);
  });
});

// =================================================================================================
describe("3. named administrator accounts", () => {
  const cookieOf = (res: Response) => `silpi_admin=${/silpi_admin=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")![1]}`;
  const signIn = async (email: string, password: string, ip?: string) => (await mods()).session.POST(req("/api/admin/session", { method: "POST", ip, body: { email, password } }));
  const create = async (email: string, role: string, password = GOOD) => {
    const { admins } = await mods();
    const res = await admins.POST(req("/api/admin/admins", { method: "POST", headers: admin, body: { email, name: `Person ${email}`, password, role } }));
    assert.equal(res.status, 200, await res.clone().text());
    return (await res.json()).account as { id: string; email: string; role: string; status: string };
  };

  it("the token can create the first account; checks the details; never returns a password", async () => {
    const { admins } = await mods();
    const post = (body: object) => admins.POST(req("/api/admin/admins", { method: "POST", headers: admin, body }));
    assert.equal((await post({ email: "nope", name: "X", password: GOOD })).status, 400);
    assert.equal((await post({ email: "short@x.example", name: "X", password: "short-pass" })).status, 400, "under 12 characters");
    assert.equal((await post({ email: "r@x.example", name: "X", password: GOOD, role: "owner" })).status, 400);
    assert.equal((await post({ email: "r@x.example", name: "", password: GOOD })).status, 400);
    const owner = await create("boss@x.example", "admin");
    assert.equal((await post({ email: "BOSS@x.example", name: "Again", password: GOOD })).status, 400, "the email is already used, whatever its case");
    const listed = await (await admins.GET(req("/api/admin/admins", { headers: admin }))).text();
    assert.ok(listed.includes(owner.id) && !/password|scrypt/i.test(listed), "no hash or password in the answer");
    assert.equal((await admins.GET(req("/api/admin/admins"))).status, 401);
  });
  it("signs in with email and password, and says the same thing for a wrong password and an unknown email", async () => {
    const { session } = await mods();
    await create("ops@x.example", "admin");
    const wrong = await signIn("ops@x.example", "not-the-password-at-all");
    const unknown = await signIn("nobody@x.example", GOOD);
    assert.deepEqual([wrong.status, unknown.status], [401, 401]);
    assert.equal((await wrong.json()).error, (await unknown.json()).error);
    const ok = await signIn("OPS@x.example", GOOD);
    assert.equal(ok.status, 200);
    assert.ok(/HttpOnly/i.test(ok.headers.get("set-cookie") ?? "") && /SameSite=strict/i.test(ok.headers.get("set-cookie") ?? ""));
    const me = await (await session.GET(req("/api/admin/session", { cookie: cookieOf(ok) }))).json();
    assert.deepEqual([me.authenticated, me.identity.role, me.identity.actor], [true, "admin", "admin:ops@x.example"]);
    const anon = await (await session.GET(req("/api/admin/session"))).json();
    assert.deepEqual([anon.authenticated, anon.identity], [false, undefined]);
  });
  it("what an account does is recorded under its name; the token is recorded as admin; failed sign-ins leave no email or password", async () => {
    const { a, coupons } = await mods();
    await create("named@x.example", "admin");
    const cookie = cookieOf(await signIn("named@x.example", GOOD));
    assert.equal((await coupons.PUT(req("/api/admin/coupons", { method: "PUT", cookie, body: { code: "BYNAME", percentBasisPoints: 500, duration: "once" } }))).status, 200);
    assert.equal((await coupons.PUT(req("/api/admin/coupons", { method: "PUT", headers: admin, body: { code: "BYTOKEN", percentBasisPoints: 500, duration: "once" } }))).status, 200);
    const by = (code: string) => a.listAudit({ action: "coupon.saved" }).find((e) => e.entityId === code)!.actor;
    assert.deepEqual([by("BYNAME"), by("BYTOKEN")], ["admin:named@x.example", "admin"]);
    assert.equal(a.listAudit({ action: "admin.signed_in", actor: "admin:named@x.example" }).length, 1);
    await signIn("named@x.example", "wrong-wrong-wrong-wrong");
    const failed = a.listAudit({ action: "admin.sign_in_failed" })[0]!;
    assert.equal(failed.actor, "anonymous");
    assert.ok(!JSON.stringify(failed).includes("named@x.example") && !JSON.stringify(failed).includes("wrong-wrong"), "neither the email nor the attempted password is written down");
  });
  it("a payment recorded or refunded by an account is recorded under its name", async () => {
    const { a } = await mods();
    const record = await import("@/app/api/admin/payments/record/route");
    const refund = await import("@/app/api/admin/payments/refund/route");
    const t = await import("@/server/tenancy");
    const p = await import("@/server/payments/service");
    await create("cash@x.example", "admin");
    const cookie = cookieOf(await signIn("cash@x.example", GOOD));
    const org = t.createOrganization({ name: "Pay Org", type: "business" }).id;
    const order = p.createTopupOrder({ orgId: org, packageId: "pkg_100", currency: "USD" });
    const rec = await record.POST(req("/api/admin/payments/record", { method: "POST", cookie, body: { topupId: order.topup.id, reference: "SEC-REF-1" } }));
    assert.equal(rec.status, 200, await rec.clone().text());
    assert.equal(a.listAudit({ action: "payment.succeeded", orgId: org })[0]!.actor, "admin:cash@x.example");
    const paymentId = (await rec.json()).payment.id;
    assert.equal((await refund.POST(req("/api/admin/payments/refund", { method: "POST", cookie, body: { paymentId, amountMinor: 100, reason: "named refund" } }))).status, 200);
    assert.equal(a.listAudit({ action: "refund.succeeded", orgId: org })[0]!.actor, "admin:cash@x.example");
  });
  it("a viewer can look at everything and change nothing, and cannot manage accounts", async () => {
    const { coupons, audit, admins } = await mods();
    await create("viewer@x.example", "viewer");
    const cookie = cookieOf(await signIn("viewer@x.example", GOOD));
    assert.equal((await audit.GET(req("/api/admin/audit", { cookie }))).status, 200);
    assert.equal((await (await import("@/app/api/admin/finance/route")).GET(req("/api/admin/finance", { cookie }))).status, 200);
    const write = await coupons.PUT(req("/api/admin/coupons", { method: "PUT", cookie, body: { code: "VIEWER1", percentBasisPoints: 500, duration: "once" } }));
    assert.equal(write.status, 403);
    assert.match((await write.json()).error, /look at everything but not change/);
    assert.equal((await admins.GET(req("/api/admin/admins", { cookie }))).status, 403);
    assert.equal((await admins.POST(req("/api/admin/admins", { method: "POST", cookie, body: { email: "z@x.example", name: "Z", password: GOOD } }))).status, 403);
    assert.equal((await (await import("@/server/audit")).listAudit({ action: "coupon.saved" })).some((e) => e.entityId === "VIEWER1"), false);
  });
  it("disabling an account, or changing its role, takes effect on its very next request", async () => {
    const { coupons, audit, admins } = await mods();
    const acct = await create("temp@x.example", "admin");
    const cookie = cookieOf(await signIn("temp@x.example", GOOD));
    assert.equal((await audit.GET(req("/api/admin/audit", { cookie }))).status, 200);
    const update = (body: object) => admins.PUT(req("/api/admin/admins", { method: "PUT", headers: admin, body: { id: acct.id, ...body } }));
    assert.equal((await update({ role: "viewer" })).status, 200);
    assert.equal((await coupons.PUT(req("/api/admin/coupons", { method: "PUT", cookie, body: { code: "TEMPONE", percentBasisPoints: 500, duration: "once" } }))).status, 403, "demoted: can no longer change anything");
    assert.equal((await audit.GET(req("/api/admin/audit", { cookie }))).status, 200, "but can still look");
    assert.equal((await update({ status: "disabled" })).status, 200);
    assert.equal((await audit.GET(req("/api/admin/audit", { cookie }))).status, 401, "disabled: the old session is dead");
    assert.equal((await signIn("temp@x.example", GOOD)).status, 401, "and signing in again fails");
    assert.equal((await update({ status: "active", role: "admin", password: "a-brand-new-password-1" })).status, 200);
    assert.equal((await signIn("temp@x.example", GOOD)).status, 401, "the old password is gone");
    assert.equal((await signIn("temp@x.example", "a-brand-new-password-1")).status, 200);
  });
  it("the last active administrator account cannot be demoted or disabled, but any can once another exists", async () => {
    const { acc, db } = await mods();
    db.getDb().prepare("DELETE FROM admin_accounts").run();
    const only = await create("only@x.example", "admin");
    await assert.rejects(() => acc.updateAdminAccount(only.id, { role: "viewer" }), /only active administrator/);
    await assert.rejects(() => acc.updateAdminAccount(only.id, { status: "disabled" }), /only active administrator/);
    const second = await create("second@x.example", "admin");
    assert.equal((await acc.updateAdminAccount(only.id, { status: "disabled" })).status, "disabled");
    await assert.rejects(() => acc.updateAdminAccount(second.id, { role: "viewer" }), /only active administrator/);
    await assert.rejects(() => acc.updateAdminAccount("adm_missing", { name: "x" }), /does not exist/);
    assert.equal((await acc.updateAdminAccount(second.id, { name: "Renamed" })).name, "Renamed");
  });
  it("a session cannot be forged, moved to another account, or outlive its time", async () => {
    const { audit } = await mods();
    const a1 = await create("one@x.example", "viewer");
    const a2 = await create("two@x.example", "admin");
    const good = cookieOf(await signIn("one@x.example", GOOD)).replace("silpi_admin=", "");
    const parts = good.split(".");
    const swapped = [parts[0], parts[1], a2.id, parts[3]].join(".");
    assert.notEqual(a1.id, a2.id);
    assert.equal((await audit.GET(req("/api/admin/audit", { cookie: `silpi_admin=${swapped}` }))).status, 401, "swapping in another account's id breaks the signature");
    assert.equal((await audit.GET(req("/api/admin/audit", { cookie: `silpi_admin=${good}x` }))).status, 401);
    assert.equal((await audit.GET(req("/api/admin/audit", { cookie: "silpi_admin=1.2.3.4" }))).status, 401);
    const old = createSession(Date.now() - 9 * 3_600_000, a2.id);
    assert.equal((await audit.GET(req("/api/admin/audit", { cookie: `silpi_admin=${old.value}` }))).status, 401, "expired after 8 hours");
    const ghost = createSession(Date.now(), "adm_does-not-exist");
    assert.equal((await audit.GET(req("/api/admin/audit", { cookie: `silpi_admin=${ghost.value}` }))).status, 401, "a correctly signed session for an account that does not exist is refused");
  });
  it("a browser change needs the same site; the token header does not (it is for scripts)", async () => {
    const { coupons } = await mods();
    await create("site@x.example", "admin");
    const cookie = cookieOf(await signIn("site@x.example", GOOD));
    const foreign = await coupons.PUT(req("/api/admin/coupons", { method: "PUT", cookie, headers: { origin: "https://evil.example" }, body: { code: "EVIL", percentBasisPoints: 500, duration: "once" } }));
    assert.equal(foreign.status, 403);
  });
  it("repeated wrong passwords for one account are stopped even when they come from many addresses", async () => {
    await create("target@x.example", "admin");
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await signIn("target@x.example", `wrong-password-${i}-xx`, `203.0.113.${i + 1}`)).status;
    assert.equal(last, 429);
    assert.equal((await signIn("target@x.example", GOOD, "203.0.113.200")).status, 429, "even the right password waits");
    resetLoginAttempts();
    assert.equal((await signIn("target@x.example", GOOD, "203.0.113.201")).status, 200);
  });
  it("without the administrator token set, nothing signs in (the token is also the signing secret)", async () => {
    const { session } = await mods();
    const saved = process.env.SILPI_ADMIN_TOKEN;
    delete process.env.SILPI_ADMIN_TOKEN;
    try {
      assert.equal((await session.POST(req("/api/admin/session", { method: "POST", body: { email: "one@x.example", password: GOOD } }))).status, 503);
    } finally { process.env.SILPI_ADMIN_TOKEN = saved; }
  });
});

// =================================================================================================
describe("4. recording a payment by the number the customer quotes", () => {
  it("finds an invoice or an order by its printed number, whatever the case or spaces, and nothing else", async () => {
    const p = await import("@/server/payments/service");
    const t = await import("@/server/tenancy");
    const s = await import("@/server/subscriptions");
    const org = t.createOrganization({ name: "Number Org", type: "business" }).id;
    const order = p.createTopupOrder({ orgId: org, packageId: "pkg_100", currency: "USD" });
    const invoice = s.startSubscription({ orgId: org, planId: "pro", currency: "USD" }).invoice!;
    assert.deepEqual(p.findByNumber(`  ${order.topup.number.toLowerCase()} `), { topupId: order.topup.id });
    assert.deepEqual(p.findByNumber(invoice.number), { invoiceId: invoice.id });
    for (const bad of ["", "TOP-2026-99999", "INV-2026-99999", "pay_123", "TOP-26-1", "DROP TABLE", 42, null, undefined]) assert.equal(p.findByNumber(bad), null, String(bad));
  });
  it("the admin route takes a number, refuses one that does not exist, and still takes an id", async () => {
    const record = await import("@/app/api/admin/payments/record/route");
    const p = await import("@/server/payments/service");
    const t = await import("@/server/tenancy");
    const c = await import("@/server/credits");
    const org = t.createOrganization({ name: "Number Org 2", type: "business" }).id;
    const first = p.createTopupOrder({ orgId: org, packageId: "pkg_100", currency: "USD" });
    const second = p.createTopupOrder({ orgId: org, packageId: "pkg_100", currency: "USD" });
    const post = (body: object) => record.POST(req("/api/admin/payments/record", { method: "POST", headers: admin, body }));
    const before = c.getWallet(org).balanceUnits;
    const bad = await post({ number: "TOP-2026-98765", reference: "NUM-REF-0" });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /No invoice or credit-pack order has that number/);
    assert.equal(c.getWallet(org).balanceUnits, before, "nothing was applied");
    assert.equal((await post({ number: first.topup.number, reference: "NUM-REF-1", amountMinor: 300 })).status, 200);
    assert.equal(c.getWallet(org).balanceUnits, before + 100_000);
    assert.equal((await post({ topupId: second.topup.id, reference: "NUM-REF-2" })).status, 200, "the id still works");
  });
});
