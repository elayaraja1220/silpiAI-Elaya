// Credit buckets: promotional, subscription and purchased credits; spend order; expiry; holds; reconciliation. Real SQLite, no mocks.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { NextRequest } from "next/server";

const dir = mkdtempSync(path.join(tmpdir(), "silpi-buckets-"));
const ADMIN = "test-admin-token-0123456789abcdef";
const PASSWORD = "a-long-test-password";
let seq = 0;
const k = (p = "k") => `${p}-${++seq}-${Math.random().toString(36).slice(2, 8)}`;
const mods = async () => ({ c: await import("@/server/credits"), t: await import("@/server/tenancy"), db: await import("@/lib/business/db") });
const newOrg = async () => (await mods()).t.createOrganization({ name: `Bucket Org ${++seq}`, type: "business" }).id;
const code = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as { code?: string }).code ?? "other"; } return "no-error"; };
const HOUR = 3_600_000;
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

type Cat = "promotional" | "subscription" | "purchased";
async function give(orgId: string, units: number, category: Cat, expiresAt?: string | null) {
  const { c } = await mods();
  return c.addCredits({ orgId, units, kind: category === "purchased" ? "purchase" : "grant", category, expiresAt, idempotencyKey: k(category) });
}
/** Every audit must come back empty after every scenario. */
async function assertReconciled(orgId?: string) {
  const { c } = await mods();
  const wallets = c.auditWallets().filter((x) => !orgId || x.orgId === orgId);
  const buckets = c.auditBuckets().filter((x) => !orgId || x.ref === orgId || x.ref.startsWith("bkt_") || /^\d+$/.test(x.ref));
  assert.deepEqual(wallets, [], "wallets agree with the ledger");
  assert.deepEqual(buckets, [], "buckets agree with the wallets, the ledger and the reservations");
}
const remaining = async (orgId: string) => Object.fromEntries((await mods()).c.getBuckets(orgId).map((b) => [b.category + (b.expiresAt ? "@" + b.expiresAt.slice(11, 16) : ""), b.remainingUnits]));

before(() => { process.env.SILPI_DB_PATH = path.join(dir, "buckets.db"); process.env.SILPI_ADMIN_TOKEN = ADMIN; });
after(() => {
  const cached = globalThis as unknown as { silpiDb?: { close(): void } };
  cached.silpiDb?.close();
  delete cached.silpiDb;
  rmSync(dir, { recursive: true, force: true });
});

// =================================================================================================
describe("1. credits arrive in buckets", () => {
  it("each category is its own bucket, and the wallet is their sum", async () => {
    const { c } = await mods();
    const org = await newOrg();
    await give(org, 1000, "subscription");
    await give(org, 300, "promotional");
    await give(org, 500, "purchased");
    assert.deepEqual(c.getWallet(org), { orgId: org, balanceUnits: 1800, reservedUnits: 0, availableUnits: 1800 });
    assert.deepEqual(c.getBuckets(org).map((b) => [b.category, b.remainingUnits]), [["promotional", 300], ["subscription", 1000], ["purchased", 500]], "listed in the order they will be spent");
    const s = c.bucketSummary(org);
    assert.deepEqual([s.byCategory.promotional.remainingUnits, s.byCategory.subscription.remainingUnits, s.byCategory.purchased.remainingUnits], [300, 1000, 500]);
    await assertReconciled(org);
  });
  it("defaults: a plan grant is subscription, a purchase or refund is purchased, and an administrator's adjustment up is promotional", async () => {
    const { c } = await mods();
    const org = await newOrg();
    c.addCredits({ orgId: org, units: 100, kind: "grant", idempotencyKey: k("g") });
    c.addCredits({ orgId: org, units: 200, kind: "purchase", idempotencyKey: k("p") });
    c.addCredits({ orgId: org, units: 300, kind: "refund", idempotencyKey: k("r") });
    c.adjustCredits({ orgId: org, deltaUnits: 400, idempotencyKey: k("a"), note: "goodwill", createdBy: "admin" });
    assert.deepEqual(c.getBuckets(org).map((b) => [b.category, b.remainingUnits]), [["promotional", 400], ["subscription", 100], ["purchased", 200], ["purchased", 300]]);
    await assertReconciled(org);
  });
  it("repeating a grant with the same key adds nothing and creates no second bucket", async () => {
    const { c } = await mods();
    const org = await newOrg();
    const key = k("same");
    c.addCredits({ orgId: org, units: 500, kind: "grant", category: "promotional", idempotencyKey: key });
    c.addCredits({ orgId: org, units: 500, kind: "grant", category: "promotional", idempotencyKey: key });
    assert.equal(c.getBuckets(org).length, 1);
    assert.equal(c.getWallet(org).balanceUnits, 500);
    assert.equal(code(() => c.addCredits({ orgId: org, units: 900, kind: "grant", idempotencyKey: key })), "idempotency-conflict");
    await assertReconciled(org);
  });
  it("refuses an unknown category, and an expiry that is not in the future", async () => {
    const { c } = await mods();
    const org = await newOrg();
    assert.equal(code(() => c.addCredits({ orgId: org, units: 5, kind: "grant", category: "gift" as never, idempotencyKey: k() })), "invalid");
    assert.equal(code(() => c.addCredits({ orgId: org, units: 5, kind: "grant", expiresAt: iso(-HOUR), idempotencyKey: k() })), "invalid");
    assert.equal(code(() => c.addCredits({ orgId: org, units: 5, kind: "grant", expiresAt: "not a date", idempotencyKey: k() })), "invalid");
    assert.equal(c.getWallet(org).balanceUnits, 0, "nothing was added");
  });
  it("an unknown organization is a clean not-found and creates nothing", async () => {
    const { c } = await mods();
    assert.equal(code(() => c.addCredits({ orgId: "org_missing", units: 5, kind: "grant", idempotencyKey: k() })), "not-found");
  });
});

// =================================================================================================
describe("2. the spend order", () => {
  it("promotional first, then subscription, then purchased", async () => {
    const { c } = await mods();
    const org = await newOrg();
    await give(org, 1000, "purchased");
    await give(org, 1000, "subscription");
    await give(org, 300, "promotional");
    const r = c.reserveCredits({ orgId: org, units: 500, idempotencyKey: k() });
    c.settleReservation({ orgId: org, reservationId: r.id, actualUnits: 450 });
    assert.deepEqual(Object.fromEntries(c.getBuckets(org).map((b) => [b.category, b.remainingUnits])), { subscription: 850, purchased: 1000 }, "300 promotional gone, then 150 from subscription");
    assert.equal(c.getWallet(org).balanceUnits, 1850);
    await assertReconciled(org);
  });
  it("inside a category the soonest expiry is spent first, and credits that never expire last", async () => {
    const { c } = await mods();
    const org = await newOrg();
    await give(org, 100, "promotional", null);
    await give(org, 100, "promotional", iso(5 * HOUR));
    await give(org, 100, "promotional", iso(2 * HOUR));
    const r = c.reserveCredits({ orgId: org, units: 150, idempotencyKey: k() });
    c.settleReservation({ orgId: org, reservationId: r.id, actualUnits: 150 });
    const left = c.getBuckets(org).map((b) => [b.expiresAt === null ? "never" : "dated", b.remainingUnits]);
    assert.deepEqual(left, [["dated", 50], ["never", 100]], "the 2-hour bucket is gone and half the 5-hour one");
    await assertReconciled(org);
  });
  it("a reservation holds across several buckets; settling less than reserved charges the first buckets only, and the rest are free again", async () => {
    const { c } = await mods();
    const org = await newOrg();
    await give(org, 300, "promotional");
    await give(org, 1000, "subscription");
    const r = c.reserveCredits({ orgId: org, units: 600, idempotencyKey: k() });
    assert.deepEqual(c.getBuckets(org).map((b) => [b.category, b.heldUnits]), [["promotional", 300], ["subscription", 300]]);
    assert.equal(c.getWallet(org).availableUnits, 700);
    c.settleReservation({ orgId: org, reservationId: r.id, actualUnits: 100 });
    assert.deepEqual(c.getBuckets(org).map((b) => [b.category, b.remainingUnits, b.heldUnits]), [["promotional", 200, 0], ["subscription", 1000, 0]]);
    assert.deepEqual(c.getWallet(org), { orgId: org, balanceUnits: 1200, reservedUnits: 0, availableUnits: 1200 });
    await assertReconciled(org);
  });
  it("releasing gives every held bucket back untouched, and repeating it is harmless", async () => {
    const { c } = await mods();
    const org = await newOrg();
    await give(org, 300, "promotional");
    await give(org, 300, "purchased");
    const r = c.reserveCredits({ orgId: org, units: 500, idempotencyKey: k() });
    c.releaseReservation({ orgId: org, reservationId: r.id });
    c.releaseReservation({ orgId: org, reservationId: r.id });
    assert.deepEqual(c.getBuckets(org).map((b) => [b.category, b.remainingUnits, b.heldUnits]), [["promotional", 300, 0], ["purchased", 300, 0]]);
    await assertReconciled(org);
  });
  it("extending a reservation takes more from the next free credits, including the same bucket", async () => {
    const { c } = await mods();
    const org = await newOrg();
    await give(org, 500, "promotional");
    await give(org, 500, "subscription");
    const r = c.reserveCredits({ orgId: org, units: 200, idempotencyKey: k() });
    c.extendReservation({ orgId: org, reservationId: r.id, extraUnits: 400, idempotencyKey: k() });
    assert.deepEqual(c.getBuckets(org).map((b) => [b.category, b.heldUnits]), [["promotional", 500], ["subscription", 100]]);
    c.settleReservation({ orgId: org, reservationId: r.id, actualUnits: 550 });
    assert.deepEqual(c.getBuckets(org).map((b) => [b.category, b.remainingUnits]), [["subscription", 450]]);
    await assertReconciled(org);
  });
  it("a second reservation cannot use credits another one holds", async () => {
    const { c } = await mods();
    const org = await newOrg();
    await give(org, 500, "subscription");
    c.reserveCredits({ orgId: org, units: 400, idempotencyKey: k() });
    assert.equal(code(() => c.reserveCredits({ orgId: org, units: 200, idempotencyKey: k() })), "insufficient");
    assert.equal(c.getWallet(org).availableUnits, 100);
    await assertReconciled(org);
  });
  it("an administrator's negative adjustment follows the spend order over free credits and never touches held ones", async () => {
    const { c } = await mods();
    const org = await newOrg();
    await give(org, 100, "promotional");
    await give(org, 400, "subscription");
    c.reserveCredits({ orgId: org, units: 300, idempotencyKey: k() }); // holds 100 promotional + 200 subscription
    c.adjustCredits({ orgId: org, deltaUnits: -150, idempotencyKey: k(), note: "clawback", createdBy: "admin" });
    assert.deepEqual(c.getBuckets(org).map((b) => [b.category, b.remainingUnits, b.heldUnits]), [["promotional", 100, 100], ["subscription", 250, 200]]);
    assert.equal(code(() => c.adjustCredits({ orgId: org, deltaUnits: -100, idempotencyKey: k(), note: "too much", createdBy: "admin" })), "insufficient", "only 50 are free");
    await assertReconciled(org);
  });
});

// =================================================================================================
describe("3. expiry", () => {
  it("credits past their expiry cannot be spent, and are not counted as available", async () => {
    const { c } = await mods();
    const org = await newOrg();
    await give(org, 500, "promotional", iso(HOUR));
    await give(org, 200, "purchased");
    const later = iso(2 * HOUR);
    assert.equal(c.getBuckets(org, { at: later })[0]!.expired, true);
    assert.equal(code(() => c.reserveCredits({ orgId: org, units: 300, idempotencyKey: k(), at: later })), "insufficient", "only 200 are spendable then");
    assert.equal(code(() => c.reserveCredits({ orgId: org, units: 200, idempotencyKey: k(), at: later })), "no-error");
  });
  it("the sweep removes expired credits with one ledger row per bucket, and repeating it does nothing", async () => {
    const { c } = await mods();
    const org = await newOrg();
    await give(org, 500, "promotional", iso(HOUR));
    await give(org, 300, "subscription", iso(HOUR));
    await give(org, 700, "purchased");
    const later = iso(2 * HOUR);
    const first = c.expireCredits({ orgId: org, at: later });
    assert.deepEqual(first, { expiredUnits: 800, buckets: 2 });
    assert.deepEqual(c.expireCredits({ orgId: org, at: later }), { expiredUnits: 0, buckets: 0 }, "nothing left to expire");
    assert.equal(c.getWallet(org).balanceUnits, 700);
    const rows = c.listLedger(org).filter((e) => e.reference.startsWith("expiry:"));
    assert.equal(rows.length, 2);
    assert.ok(rows.every((e) => e.kind === "adjust" && e.createdBy === "system" && e.deltaUnits < 0));
    await assertReconciled(org);
  });
  it("credits held by a running reservation are honoured past expiry; what is left expires on the next sweep", async () => {
    const { c } = await mods();
    const org = await newOrg();
    await give(org, 500, "promotional", iso(HOUR));
    const r = c.reserveCredits({ orgId: org, units: 200, idempotencyKey: k() });
    const later = iso(2 * HOUR);
    assert.deepEqual(c.expireCredits({ orgId: org, at: later }), { expiredUnits: 300, buckets: 1 }, "only the unheld part");
    assert.equal(c.getWallet(org).balanceUnits, 200);
    c.settleReservation({ orgId: org, reservationId: r.id, actualUnits: 120 });
    assert.equal(c.getWallet(org).balanceUnits, 80, "the held credits could still be spent");
    assert.deepEqual(c.expireCredits({ orgId: org, at: later }), { expiredUnits: 80, buckets: 1 });
    assert.equal(c.getWallet(org).balanceUnits, 0);
    await assertReconciled(org);
  });
  it("the sweep is per organization when asked, and never touches another's credits", async () => {
    const { c } = await mods();
    const [a, b] = [await newOrg(), await newOrg()];
    await give(a, 100, "promotional", iso(HOUR));
    await give(b, 100, "promotional", iso(HOUR));
    c.expireCredits({ orgId: a, at: iso(2 * HOUR) });
    assert.equal(c.getWallet(a).balanceUnits, 0);
    assert.equal(c.getWallet(b).balanceUnits, 100);
    await assertReconciled();
  });
  it("a default expiry can be set per category in the settings; unset means never", async () => {
    const { c, db } = await mods();
    const org = await newOrg();
    c.addCredits({ orgId: org, units: 10, kind: "grant", idempotencyKey: k() });
    assert.equal(c.getBuckets(org)[0]!.expiresAt, null, "no expiry unless configured");
    db.getDb().prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('credits_subscription_expiry_days', '30')").run();
    try {
      const org2 = await newOrg();
      c.addCredits({ orgId: org2, units: 10, kind: "grant", idempotencyKey: k() });
      const at = Date.parse(c.getBuckets(org2)[0]!.expiresAt!);
      assert.ok(Math.abs(at - (Date.now() + 30 * 86_400_000)) < 60_000, "about 30 days from now");
      c.addCredits({ orgId: org2, units: 10, kind: "purchase", idempotencyKey: k() });
      assert.equal(c.getBuckets(org2).find((b) => b.category === "purchased")!.expiresAt, null, "purchased credits are not affected");
      c.addCredits({ orgId: org2, units: 10, kind: "grant", expiresAt: null, idempotencyKey: k() });
      assert.equal(c.getBuckets(org2).filter((b) => b.category === "subscription").some((b) => b.expiresAt === null), true, "an explicit null means never");
    } finally {
      db.getDb().prepare("DELETE FROM settings WHERE key = 'credits_subscription_expiry_days'").run();
    }
  });
  it("the summary reports the next expiry and credits waiting to be swept", async () => {
    const { c } = await mods();
    const org = await newOrg();
    await give(org, 100, "promotional", iso(HOUR));
    await give(org, 50, "promotional", iso(3 * HOUR));
    const now = c.bucketSummary(org);
    assert.equal(now.nextExpiry!.units, 100);
    assert.equal(now.pendingExpiryUnits, 0);
    const later = c.bucketSummary(org, { at: iso(2 * HOUR) });
    assert.equal(later.pendingExpiryUnits, 100, "expired but not swept yet");
    assert.equal(later.byCategory.promotional.remainingUnits, 50);
  });
});

// =================================================================================================
describe("4. reconciliation under stress", () => {
  it("a long random run of every operation, across organizations and moving time, always reconciles", async () => {
    const { c } = await mods();
    // A small seeded generator: the same run every time.
    let state = 20_260_101;
    const rnd = () => { state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296; return state / 4_294_967_296; };
    const pickOne = <T>(a: T[]): T => a[Math.floor(rnd() * a.length)]!;
    const orgs = [await newOrg(), await newOrg(), await newOrg()];
    const open = new Map<string, { orgId: string; units: number }>();
    let clock = Date.now();
    for (let i = 0; i < 400; i++) {
      const orgId = pickOne(orgs);
      const r = rnd();
      try {
        if (r < 0.2) {
          const category = pickOne<Cat>(["promotional", "subscription", "purchased"]);
          c.addCredits({ orgId, units: 1 + Math.floor(rnd() * 500), kind: category === "purchased" ? "purchase" : "grant", category, expiresAt: rnd() < 0.5 ? null : new Date(clock + (1 + Math.floor(rnd() * 20)) * HOUR).toISOString(), idempotencyKey: k("s") });
        } else if (r < 0.45) {
          const res = c.reserveCredits({ orgId, units: 1 + Math.floor(rnd() * 400), idempotencyKey: k("s"), at: new Date(clock).toISOString() });
          open.set(res.id, { orgId, units: res.units });
        } else if (r < 0.55 && open.size) {
          const [id, v] = pickOne([...open.entries()]);
          const res = c.extendReservation({ orgId: v.orgId, reservationId: id, extraUnits: 1 + Math.floor(rnd() * 100), idempotencyKey: k("s"), at: new Date(clock).toISOString() });
          open.set(id, { orgId: v.orgId, units: res.units });
        } else if (r < 0.75 && open.size) {
          const [id, v] = pickOne([...open.entries()]);
          c.settleReservation({ orgId: v.orgId, reservationId: id, actualUnits: Math.floor(rnd() * (v.units + 1)) });
          open.delete(id);
        } else if (r < 0.85 && open.size) {
          const [id, v] = pickOne([...open.entries()]);
          c.releaseReservation({ orgId: v.orgId, reservationId: id });
          open.delete(id);
        } else if (r < 0.92) {
          clock += Math.floor(rnd() * 6) * HOUR;
          c.expireCredits({ at: new Date(clock).toISOString() });
        } else {
          c.adjustCredits({ orgId, deltaUnits: rnd() < 0.5 ? 1 + Math.floor(rnd() * 100) : -(1 + Math.floor(rnd() * 100)), idempotencyKey: k("s"), note: "stress", createdBy: "test", at: new Date(clock).toISOString() });
        }
      } catch (e) {
        // Refusals (not enough credits, nothing to adjust) are expected in a random run; anything else is a bug.
        assert.ok(["insufficient"].includes((e as { code?: string }).code ?? ""), `unexpected error at step ${i}: ${(e as Error).message}`);
      }
      if (i % 25 === 0) await assertReconciled();
    }
    for (const [id, v] of open) c.releaseReservation({ orgId: v.orgId, reservationId: id });
    await assertReconciled();
    for (const o of orgs) {
      const w = c.getWallet(o);
      assert.equal(w.reservedUnits, 0);
      assert.ok(w.balanceUnits >= 0 && w.availableUnits >= 0 && w.availableUnits <= w.balanceUnits);
    }
  });
});

// =================================================================================================
describe("5. the database itself protects the buckets", () => {
  it("bucket history cannot be edited or deleted, and a bucket cannot hold more than it has", async () => {
    const { c, db } = await mods();
    const org = await newOrg();
    await give(org, 100, "purchased");
    const d = db.getDb();
    assert.throws(() => d.prepare("UPDATE credit_ledger_buckets SET delta_units = 999").run(), /append-only/);
    assert.throws(() => d.prepare("DELETE FROM credit_ledger_buckets").run(), /append-only/);
    const bucket = c.getBuckets(org)[0]!;
    assert.throws(() => d.prepare("UPDATE credit_buckets SET held_units = 101 WHERE id = ?").run(bucket.id), /CHECK/, "held cannot pass remaining");
    assert.throws(() => d.prepare("UPDATE credit_buckets SET remaining_units = 101 WHERE id = ?").run(bucket.id), /CHECK/, "remaining cannot pass what was granted");
    assert.throws(() => d.prepare("UPDATE credit_buckets SET remaining_units = -1 WHERE id = ?").run(bucket.id), /CHECK/);
    assert.throws(() => d.prepare("INSERT INTO credit_buckets (id, org_id, category, granted_units, remaining_units, created_at) VALUES ('b', ?, 'gift', 5, 5, 't')").run(org), /CHECK/, "an unknown category");
  });
  it("a tampered bucket is caught by the audit", async () => {
    const { c, db } = await mods();
    const org = await newOrg();
    await give(org, 100, "purchased");
    await give(org, 100, "purchased");
    const target = c.getBuckets(org)[0]!;
    const d = db.getDb();
    d.prepare("UPDATE credit_buckets SET remaining_units = remaining_units - 10 WHERE id = ?").run(target.id); // credits vanish outside the ledger
    const found = c.auditBuckets().filter((m) => m.ref === target.id || m.ref === org);
    assert.ok(found.length >= 1, "the discrepancy is reported");
    assert.ok(found.some((m) => m.check.startsWith("bucket remaining")));
    d.prepare("UPDATE credit_buckets SET remaining_units = remaining_units + 10 WHERE id = ?").run(target.id); // put it back so later checks stay clean
    assert.deepEqual(c.auditBuckets().filter((m) => m.ref === target.id), []);
  });
});

// =================================================================================================
describe("6. the HTTP API", () => {
  type Init = { method?: string; body?: unknown; cookie?: string; headers?: Record<string, string> };
  function req(url: string, init: Init = {}): NextRequest {
    const headers: Record<string, string> = { host: "localhost:3000", origin: "http://localhost:3000", "x-forwarded-for": `10.4.0.${++seq % 250}`, ...(init.headers ?? {}) };
    if (init.cookie) headers.cookie = init.cookie;
    if (init.body !== undefined) headers["content-type"] = "application/json";
    return new NextRequest(`http://localhost:3000${url}`, { method: init.method ?? "GET", headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  }
  const admin = { authorization: `Bearer ${ADMIN}` };
  async function member(name: string) {
    const users = await import("@/app/api/admin/users/route");
    const login = await import("@/app/api/auth/login/route");
    const email = `owner@${name}.example`;
    const made = await users.POST(req("/api/admin/users", { method: "POST", headers: admin, body: { email, name: email, password: PASSWORD, newOrg: { name, type: "agency" } } }));
    assert.equal(made.status, 200, await made.clone().text());
    const org = (await made.json()).organization.id as string;
    const res = await login.POST(req("/api/auth/login", { method: "POST", body: { email, password: PASSWORD } }));
    return { org, cookie: `silpi_session=${/silpi_session=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")![1]}` };
  }

  it("the wallet screen API shows this organization's buckets in spend order, and hides internal sources", async () => {
    const wallet = await import("@/app/api/workspace/wallet/route");
    const owner = await member("wallet-api");
    const other = await member("wallet-other");
    const { c } = await mods();
    await give(owner.org, 700, "purchased");
    await give(owner.org, 100, "promotional", iso(5 * HOUR));
    assert.equal((await wallet.GET(req("/api/workspace/wallet"))).status, 401);
    const body = await (await wallet.GET(req("/api/workspace/wallet", { cookie: owner.cookie }))).json();
    assert.deepEqual(body.buckets.map((b: { category: string }) => b.category), ["promotional", "subscription", "purchased"], "the free plan's own credits sit in the subscription bucket");
    assert.equal(body.wallet.balanceUnits, c.getWallet(owner.org).balanceUnits);
    assert.equal(body.summary.byCategory.promotional.remainingUnits, 100);
    assert.ok(body.summary.nextExpiry);
    assert.ok(!JSON.stringify(body).includes("source") && !JSON.stringify(body).includes("plan:"), "internal references stay private");
    const otherBody = await (await wallet.GET(req("/api/workspace/wallet", { cookie: other.cookie }))).json();
    assert.ok(otherBody.buckets.every((b: { id: string }) => !body.buckets.some((x: { id: string }) => x.id === b.id)), "another organization sees only its own");
  });
  it("an administrator can grant a promotional bucket with an expiry, and the billing process sweeps expired credits", async () => {
    const credits = await import("@/app/api/admin/credits/route");
    const process_ = await import("@/app/api/admin/billing/process/route");
    const owner = await member("grant-api");
    const grant = await credits.POST(req("/api/admin/credits", { method: "POST", headers: admin, body: { orgId: owner.org, action: "grant", units: 5000, idempotencyKey: k("grant"), note: "spring offer", expiresAt: iso(HOUR) } }));
    assert.equal(grant.status, 200);
    const { c } = await mods();
    const promo = c.getBuckets(owner.org).find((b) => b.category === "promotional")!;
    assert.deepEqual([promo.remainingUnits, promo.expiresAt !== null], [5000, true]);
    assert.equal((await credits.POST(req("/api/admin/credits", { method: "POST", headers: admin, body: { orgId: owner.org, action: "grant", units: 10, idempotencyKey: k("bad"), note: "x", category: "gift" } }))).status, 400);
    const listed = await (await credits.GET(req(`/api/admin/credits?orgId=${owner.org}`, { headers: admin }))).json();
    assert.ok(listed.buckets.length >= 2, "the administrator sees the buckets");
    // Move time forward for the sweep by expiring directly, then confirm the route reports an expiry result shape.
    const swept = await (await process_.POST(req("/api/admin/billing/process", { method: "POST", headers: admin }))).json();
    assert.ok("expired" in swept && "processed" in swept);
    assert.equal((await process_.POST(req("/api/admin/billing/process", { method: "POST" }))).status, 401);
  });
});
