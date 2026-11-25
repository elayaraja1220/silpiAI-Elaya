// Step 7: the audit trail (append-only, written with the change it describes) and the administrator's finance view (every figure checked against the books).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { NextRequest } from "next/server";

import { useFixedMetering } from "./fixtures/fixed-pricing";

const dir = mkdtempSync(path.join(tmpdir(), "silpi-finance-"));
const ADMIN = "test-admin-token-0123456789abcdef";
const admin = { authorization: `Bearer ${ADMIN}` };
let seq = 0;
const k = (p = "k") => `${p}-${++seq}-${Math.random().toString(36).slice(2, 8)}`;

const mods = async () => ({
  a: await import("@/server/audit"),
  f: await import("@/server/finance"),
  p: await import("@/server/payments/service"),
  s: await import("@/server/subscriptions"),
  c: await import("@/server/credits"),
  t: await import("@/server/tenancy"),
  g: await import("@/server/ai/gateway"),
  cat: await import("@/server/ai/catalog"),
  db: await import("@/lib/business/db"),
});
const newOrg = async () => (await mods()).t.createOrganization({ name: `Fin Org ${++seq}`, type: "business" }).id;
function req(url: string, init: { method?: string; body?: object; headers?: Record<string, string> } = {}): NextRequest {
  const headers: Record<string, string> = { host: "localhost:3000", origin: "http://localhost:3000", "x-forwarded-for": `10.8.0.${++seq % 250}`, ...(init.headers ?? {}) };
  if (init.body) headers["content-type"] = "application/json";
  return new NextRequest(`http://localhost:3000${url}`, { method: init.method ?? "GET", headers, body: init.body ? JSON.stringify(init.body) : undefined });
}
const send = (route: { PUT?: (r: NextRequest) => Promise<Response>; POST?: (r: NextRequest) => Promise<Response>; DELETE?: (r: NextRequest) => Promise<Response> }, method: "PUT" | "POST" | "DELETE", url: string, body?: object, headers: Record<string, string> = admin) =>
  route[method]!(req(url, { method, body, headers }));
const T0 = Date.parse("2026-12-10T12:00:00.000Z");

before(async () => {
  process.env.SILPI_DB_PATH = path.join(dir, "finance.db");
  process.env.SILPI_ADMIN_TOKEN = ADMIN;
  delete process.env.ANTHROPIC_API_KEY;
  await useFixedMetering();
});
after(() => {
  const cached = globalThis as unknown as { silpiDb?: { close(): void } };
  cached.silpiDb?.close();
  delete cached.silpiDb;
  rmSync(dir, { recursive: true, force: true });
});

// =================================================================================================
describe("1. the audit log itself", () => {
  it("cannot be changed or deleted, even by direct SQL", async () => {
    const { a, db } = await mods();
    a.recordAudit({ actor: "admin", action: "test.entry", entityType: "test", entityId: "1" });
    const d = db.getDb();
    assert.throws(() => d.prepare("UPDATE audit_logs SET actor = 'someone else'").run(), /append-only/);
    assert.throws(() => d.prepare("DELETE FROM audit_logs").run(), /append-only/);
  });
  it("never records a secret, cuts long text, and bounds the size of an entry", async () => {
    const { a } = await mods();
    a.recordAudit({ actor: "admin", action: "test.secrets", entityType: "test", detail: { email: "a@b.example", password: "hunter2", apiKey: "sk-123", nested: { SILPI_ADMIN_TOKEN: "t", authorization: "Bearer x", ok: 1 }, long: "x".repeat(1000), list: Array.from({ length: 50 }, (_, i) => i) } });
    const e = a.listAudit({ action: "test.secrets" })[0]!;
    const text = JSON.stringify(e);
    for (const secret of ["hunter2", "sk-123", "Bearer x"]) assert.ok(!text.includes(secret), `${secret} must not be stored`);
    assert.deepEqual([e.detail.password, e.detail.apiKey, (e.detail.nested as Record<string, unknown>).SILPI_ADMIN_TOKEN, (e.detail.nested as Record<string, unknown>).ok, e.detail.email], ["[hidden]", "[hidden]", "[hidden]", 1, "a@b.example"]);
    assert.ok((e.detail.long as string).length <= 303);
    assert.equal((e.detail.list as unknown[]).length, 20);
    a.recordAudit({ actor: "admin", action: "test.huge", entityType: "test", detail: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, "y".repeat(290)])) });
    const huge = a.listAudit({ action: "test.huge" })[0]!;
    assert.equal(huge.detail.truncated, true);
    assert.ok(JSON.stringify(huge.detail).length < 2200);
  });
  it("filters by action prefix (with % and _ taken literally), organization and actor, and pages backwards", async () => {
    const { a } = await mods();
    const org = await newOrg();
    for (let i = 0; i < 5; i++) a.recordAudit({ actor: i % 2 ? "admin" : "system", action: `page.thing_${i}`, entityType: "page", entityId: i, orgId: org });
    assert.equal(a.listAudit({ action: "page." }).length, 5);
    assert.equal(a.listAudit({ action: "page.thing_1" }).length, 1);
    assert.equal(a.listAudit({ action: "pa%" }).length, 0, "a percent sign is not a wildcard");
    assert.equal(a.listAudit({ action: "page.thing_" }).length, 5);
    assert.equal(a.listAudit({ action: "page.thing\\_" }).length, 0);
    assert.deepEqual(a.listAudit({ orgId: org }).map((e) => e.entityId), ["4", "3", "2", "1", "0"], "newest first");
    assert.equal(a.listAudit({ orgId: org, actor: "system" }).length, 3);
    const first = a.listAudit({ orgId: org, limit: 2 });
    const next = a.listAudit({ orgId: org, limit: 2, before: first[1]!.id });
    assert.deepEqual([...first, ...next].map((e) => e.entityId), ["4", "3", "2", "1"]);
    assert.equal(a.listAudit({ orgId: org, limit: 9999 }).length, 5, "the limit is capped, not an error");
  });
  it("an entry written inside a transaction disappears with it if the change is undone", async () => {
    const { a, db } = await mods();
    assert.throws(() => db.transaction((tx) => { a.recordAuditIn(tx, { actor: "admin", action: "test.rolled_back", entityType: "test" }); throw new Error("the change failed"); }), /the change failed/);
    assert.equal(a.listAudit({ action: "test.rolled_back" }).length, 0);
  });
});

// =================================================================================================
describe("2. what gets recorded", () => {
  it("every administrator change is recorded after it succeeds, with the organization where there is one, and nothing is recorded when it fails", async () => {
    const { a } = await mods();
    const org = await newOrg();
    const markups = await import("@/app/api/admin/ai/markups/route");
    const models = await import("@/app/api/admin/ai/models/route");
    const settings = await import("@/app/api/admin/ai/settings/route");
    const limits = await import("@/app/api/admin/ai/limits/route");
    const coupons = await import("@/app/api/admin/coupons/route");
    const credits = await import("@/app/api/admin/credits/route");
    const plans = await import("@/app/api/admin/plans/route");
    const planPrices = await import("@/app/api/admin/plans/prices/route");
    const packs = await import("@/app/api/admin/credit-packages/route");
    const packPrices = await import("@/app/api/admin/credit-packages/prices/route");
    const processRoute = await import("@/app/api/admin/billing/process/route");
    const users = await import("@/app/api/admin/users/route");

    const ok = async (r: Promise<Response>) => { const res = await r; assert.equal(res.status, 200, await res.clone().text()); return res.json(); };
    await ok(send(limits, "PUT", "/api/admin/ai/limits", { orgId: org, dailyCapUnits: 50_000 }));
    const rule = await ok(send(markups, "PUT", "/api/admin/ai/markups", { provider: "anthropic", markupBasisPoints: 20_000 }));
    await ok(send(markups, "DELETE", `/api/admin/ai/markups?id=${rule.rule.id}`));
    await ok(send(models, "PUT", "/api/admin/ai/models", { id: "audit-model", provider: "gemini", providerModel: "gem-x", label: "Audit model", tier: "fast" }));
    await ok(send(settings, "PUT", "/api/admin/ai/settings", { rounding: "up" }));
    await ok(send(coupons, "PUT", "/api/admin/coupons", { code: "AUDIT10", percentBasisPoints: 1000, duration: "once" }));
    await ok(send(credits, "POST", "/api/admin/credits", { orgId: org, action: "grant", units: 5000, idempotencyKey: k("g"), note: "goodwill" }));
    await ok(send(credits, "POST", "/api/admin/credits", { orgId: org, action: "adjust", deltaUnits: -1000, idempotencyKey: k("a"), note: "correction" }));
    await ok(send(plans, "PUT", "/api/admin/plans", { id: "starter", description: "For an individual developer." }));
    await ok(send(planPrices, "PUT", "/api/admin/plans/prices", { planId: "starter", currency: "EUR", period: "monthly", amountMinor: 550 }));
    await ok(send(packs, "PUT", "/api/admin/credit-packages", { id: "pkg_audit", name: "Audit pack", credits: 10 }));
    await ok(send(packPrices, "PUT", "/api/admin/credit-packages/prices", { packageId: "pkg_audit", currency: "USD", amountMinor: 100 }));
    await ok(send(processRoute, "POST", "/api/admin/billing/process", {}));
    await ok(send(users, "POST", "/api/admin/users", { email: "audit@owner.example", name: "Audit Owner", password: "a-long-test-password", newOrg: { name: "Audit Org", type: "business" } }));

    const actions = new Set(a.listAudit({ limit: 500 }).map((e) => e.action));
    for (const want of ["ai.daily_cap_set", "markup_rule.saved", "markup_rule.deleted", "model.saved", "ai.charging_settings_changed", "coupon.saved", "credits.granted", "credits.adjusted", "plan.updated", "plan.price_set", "credit_package.saved", "credit_package.price_set", "billing.process_run", "user.created"]) assert.ok(actions.has(want), `${want} was recorded`);
    const granted = a.listAudit({ action: "credits.granted" })[0]!;
    assert.deepEqual([granted.actor, granted.orgId, granted.entityId, granted.detail.units, granted.detail.note], ["admin", org, org, 5000, "goodwill"]);
    assert.equal(a.listAudit({ action: "user.created" })[0]!.detail.email, "audit@owner.example");

    // A rejected change leaves no entry.
    const before = a.listAudit({ limit: 500 }).length;
    assert.equal((await send(plans, "PUT", "/api/admin/plans", { id: "no-such-plan", name: "x" })).status, 400);
    assert.equal((await send(credits, "POST", "/api/admin/credits", { orgId: org, action: "grant", units: -5, idempotencyKey: k("g") })).status, 400);
    assert.equal((await send(coupons, "PUT", "/api/admin/coupons", { code: "!!", duration: "once" })).status, 400);
    assert.equal((await send(plans, "PUT", "/api/admin/plans", { id: "starter", name: "Starter" }, {})).status, 401, "and no sign-in means no change and no entry");
    assert.equal(a.listAudit({ limit: 500 }).length, before);
  });
  it("administrator sign-in is recorded, a wrong token is not a sign-in", async () => {
    const { a } = await mods();
    const session = await import("@/app/api/admin/session/route");
    const before = a.listAudit({ action: "admin.signed_in" }).length;
    assert.equal((await session.POST(req("/api/admin/session", { method: "POST", body: { token: "wrong-token-wrong-token" } }))).status, 401);
    assert.equal(a.listAudit({ action: "admin.signed_in" }).length, before);
    assert.equal((await session.POST(req("/api/admin/session", { method: "POST", body: { token: ADMIN } }))).status, 200);
    const e = a.listAudit({ action: "admin.signed_in" });
    assert.equal(e.length, before + 1);
    assert.ok(!JSON.stringify(e[0]).includes(ADMIN), "the token is never written down");
  });
  it("payments and refunds are recorded in the same transaction as the money moving", async () => {
    const { a, p, s, db } = await mods();
    const org = await newOrg();
    const { invoice } = s.startSubscription({ orgId: org, planId: "pro", currency: "USD", now: T0 }) as { invoice: { id: string } };
    const paid = p.recordManualPayment({ invoiceId: invoice.id, reference: "UPI-AUDIT-1", now: T0 });
    const e = a.listAudit({ action: "payment.succeeded", orgId: org })[0]!;
    assert.deepEqual([e.actor, e.entityId, e.detail.amountMinor, e.detail.currency, e.detail.reference], ["admin", paid.payment.id, 1900, "USD", "UPI-AUDIT-1"]);
    assert.equal(e.at, new Date(T0).toISOString(), "stamped with the payment's own time");
    await p.refundPayment({ paymentId: paid.payment.id, amountMinor: 500, reason: "goodwill", requestedBy: "admin" });
    const r = a.listAudit({ action: "refund.succeeded", orgId: org })[0]!;
    assert.deepEqual([r.actor, r.detail.amountMinor, r.detail.reason, r.detail.creditsReversedUnits], ["admin", 500, "goodwill", Math.floor((700_000 * 500) / 1900)]);
    // A provider's duplicate payment is flagged and recorded under the provider.
    db.transaction((tx) => p.applySuccessfulPayment(tx, { provider: "testpay", providerPaymentId: "pay_dup_1", target: { kind: "invoice", invoiceId: invoice.id }, at: new Date(T0).toISOString() }));
    const dup = a.listAudit({ action: "payment.duplicate_flagged", orgId: org })[0]!;
    assert.deepEqual([dup.actor, dup.detail.reference], ["provider:testpay", "pay_dup_1"]);
    // And a payment whose transaction fails leaves no entry behind.
    const org2 = await newOrg();
    const second = s.startSubscription({ orgId: org2, planId: "pro", currency: "USD", now: T0 }) as { invoice: { id: string } };
    assert.throws(() => db.transaction((tx) => { p.applySuccessfulPayment(tx, { provider: "testpay", providerPaymentId: "pay_undone", target: { kind: "invoice", invoiceId: second.invoice.id }, at: new Date(T0).toISOString() }); throw new Error("undone"); }), /undone/);
    assert.equal(a.listAudit({ orgId: org2 }).length, 0);
  });
  it("the audit and finance routes need the administrator token", async () => {
    const audit = await import("@/app/api/admin/audit/route");
    const finance = await import("@/app/api/admin/finance/route");
    assert.equal((await audit.GET(req("/api/admin/audit"))).status, 401);
    assert.equal((await finance.GET(req("/api/admin/finance"))).status, 401);
    const body = await (await audit.GET(req("/api/admin/audit?limit=3&action=payment.", { headers: admin }))).json();
    assert.ok(body.entries.length >= 1 && body.entries.length <= 3 && body.entries.every((e: { action: string }) => e.action.startsWith("payment.")));
  });
});

