// Step 7: the administrator's finance view. A small known business is built through the real services, then every figure is checked against the books.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { NextRequest } from "next/server";

import { useFixedMetering } from "./fixtures/fixed-pricing";

const dir = mkdtempSync(path.join(tmpdir(), "silpi-finance-view-"));
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
const send = (route: { PUT?: (r: NextRequest) => Promise<Response>; POST?: (r: NextRequest) => Promise<Response>; DELETE?: (r: NextRequest) => Promise<Response> }, method: "PUT" | "POST" | "DELETE", url: string, body?: object, headers = admin) =>
  route[method]!(req(url, { method, body, headers }));
const T0 = Date.now();

before(async () => {
  process.env.SILPI_DB_PATH = path.join(dir, "finance-view.db");
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
describe("3. the finance view", () => {
  // A small, known business, built through the real services.
  const ids: Record<string, string> = {};
  before(async () => {
    const { s, p, c } = await mods();
    const pay = (org: string, invoiceId: string, ref: string) => p.recordManualPayment({ invoiceId, reference: ref, now: T0 });
    ids.pro = await newOrg(); ids.creator = await newOrg(); ids.annual = await newOrg(); ids.unpaid = await newOrg(); ids.free = await newOrg();
    pay(ids.pro!, (s.startSubscription({ orgId: ids.pro!, planId: "pro", currency: "USD", now: T0 }).invoice!).id, "FIN-PRO");
    const creator = s.startSubscription({ orgId: ids.creator!, planId: "creator", currency: "USD", now: T0 });
    pay(ids.creator!, creator.invoice!.id, "FIN-CREATOR");
    s.cancelSubscription({ orgId: ids.creator!, now: T0 });
    const annual = s.startSubscription({ orgId: ids.annual!, planId: "starter", period: "annual", currency: "INR", now: T0 });
    ids.annualTotal = String(annual.invoice!.totalPaise);
    pay(ids.annual!, annual.invoice!.id, "FIN-ANNUAL");
    s.startSubscription({ orgId: ids.unpaid!, planId: "pro", currency: "USD", now: T0 }); // an open invoice, never paid
    s.startSubscription({ orgId: ids.free!, planId: "free", now: T0 });
    // A top-up of $3 from the Pro customer, then $1 of it refunded.
    const order = p.createTopupOrder({ orgId: ids.pro!, packageId: "pkg_100", currency: "USD", now: T0 });
    const topPay = p.recordManualPayment({ topupId: order.topup.id, reference: "FIN-TOPUP", now: T0 });
    await p.refundPayment({ paymentId: topPay.payment.id, amountMinor: 100, reason: "partial", requestedBy: "admin" });
    void c;
  });

  it("revenue is cash received less refunds, per currency, never mixed", async () => {
    const { f } = await mods();
    const r = f.financeOverview(T0 + 60_000).revenue;
    assert.deepEqual(r.thisMonth.received, { USD: 1900 + 1200 + 300, INR: Number(ids.annualTotal) });
    assert.deepEqual(r.thisMonth.refunded, { USD: 100 });
    assert.deepEqual(r.thisMonth.net, { USD: 3300, INR: Number(ids.annualTotal) });
    assert.deepEqual(r.allTime.net, r.thisMonth.net);
    assert.deepEqual(r.lastMonth, { received: {}, refunded: {}, net: {} });
    assert.deepEqual(r.topupsThisMonth, { orders: 1, value: { USD: 300 } });
    // Next month the same money is "last month".
    const d = new Date(T0);
    const later = f.financeOverview(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 5)).revenue;
    assert.deepEqual([later.thisMonth.net, later.lastMonth.net.USD], [{}, 3300]);
  });
  it("monthly recurring revenue counts paying subscribers only: yearly as a twelfth, unpaid, free and cancelling handled", async () => {
    const { f, s } = await mods();
    const sub = f.financeOverview(T0 + 60_000).subscriptions;
    const annualUnit = s.getBilling(ids.annual!).running!.unitAmountMinor!;
    assert.equal(annualUnit, 499_000, "Starter at 10 x its monthly price, before GST");
    assert.deepEqual(sub.mrr, { USD: 1900 + 1200, INR: Math.floor(annualUnit / 12) });
    assert.deepEqual(sub.mrrAtRisk, { USD: 1200 }, "the cancelling subscriber's money is shown as at risk");
    assert.deepEqual([sub.activePaid, sub.cancelling, sub.pastDue, sub.inTrial], [3, 1, 0, 0]);
    assert.deepEqual(sub.openInvoices, { count: 1, value: { USD: 1900 } });
  });
  it("counts customers by plan and leaves the agency's own organization out of everything", async () => {
    const { f, db } = await mods();
    const by = Object.fromEntries(f.financeOverview(T0 + 60_000).subscriptions.byPlan.map((x) => [x.planId, x.count]));
    assert.deepEqual([by.pro, by.creator, by.starter, by.free], [1, 1, 1, 1], "the organization with only an open invoice is still on nothing paid, and not counted as Pro");
    const internal = db.getDb().prepare("SELECT id FROM organizations WHERE type = 'internal' LIMIT 1").get() as { id: string };
    assert.ok(internal, "the agency organization exists");
  });
  it("credits owed to customers match the wallets, in credits and in what they would be worth", async () => {
    const { f, db } = await mods();
    const fin = f.financeOverview(T0 + 60_000);
    const sum = (db.getDb().prepare("SELECT COALESCE(SUM(w.balance_units), 0) AS n FROM credit_wallets w JOIN organizations o ON o.id = w.org_id WHERE o.type != 'internal'").get() as { n: number }).n;
    assert.equal(fin.credits.outstandingUnits, sum);
    assert.equal(fin.credits.byCategory.reduce((n, c) => n + c.units, 0), sum, "the kinds add up to the whole");
    assert.equal(fin.credits.outstandingValueMicroUsd, Math.round((sum * 1_000_000) / fin.unitsPerUsd));
    assert.ok(fin.credits.grantedThisMonthUnits > 0);
  });
  it("AI cost against what customers were billed agrees with the request log, by provider and by model", async () => {
    const { f, g, cat, c, db } = await mods();
    cat.saveModel({ id: "fin-model", provider: "fake", providerModel: "fin-v1", label: "fin", tier: "balanced", inputUsdMicroPerMtok: 1_000_000, outputUsdMicroPerMtok: 5_000_000, maxOutputTokens: 4096, priority: 1, enabled: true });
    for (const m of cat.listModels({ enabledOnly: true })) if (m.id !== "fin-model" && m.provider !== "echo") cat.saveModel({ id: m.id, enabled: false });
    const org = ids.pro!;
    c.addCredits({ orgId: org, units: 2_000_000, kind: "grant", idempotencyKey: k("fund") });
    let n = 0;
    const adapter = { id: "fake", isConfigured: () => true, async complete() { n++; if (n === 3) throw new (await import("@/server/ai/providers")).ProviderError("bad", false, 400); return { text: "ok", inputTokens: 1000 * n, outputTokens: 200, providerRequestId: null }; } };
    const { createBreaker } = await import("@/server/ai/circuit");
    for (let i = 0; i < 3; i++) { try { await g.complete({ orgId: org, model: "balanced", messages: [{ role: "user", content: "hi" }], maxOutputTokens: 100, idempotencyKey: k("ai") }, { providers: { fake: adapter }, sleep: async () => {}, breaker: createBreaker() }); } catch { /* the third fails on purpose */ } }
    const fin = f.financeOverview(Date.now());
    const truth = db.getDb().prepare("SELECT COUNT(*) AS n, SUM(status = 'failed') AS failed, SUM(provider_cost_micro_usd) AS cost, SUM(charged_units) AS charged FROM ai_requests WHERE org_id = ?").get(org) as { n: number; failed: number; cost: number; charged: number };
    assert.ok(truth.cost > 0 && truth.charged > 0 && truth.failed === 1, JSON.stringify(truth));
    assert.deepEqual([fin.ai.thisMonth.requests, fin.ai.thisMonth.failed, fin.ai.thisMonth.providerCostMicroUsd, fin.ai.thisMonth.chargedUnits], [truth.n, truth.failed, truth.cost, truth.charged]);
    assert.equal(fin.ai.thisMonth.billedMicroUsd, Math.round((truth.charged * 1_000_000) / fin.unitsPerUsd));
    assert.ok(fin.ai.thisMonth.billedMicroUsd >= fin.ai.thisMonth.providerCostMicroUsd, "billed at least the cost");
    assert.deepEqual(fin.ai.byProvider.map((x) => [x.key, x.requests, x.providerCostMicroUsd]), [["fake", 2, truth.cost], ["unknown", 1, 0]], "the failed request reached no model: it is listed apart, at no cost");
    assert.deepEqual(fin.ai.byModel.find((x) => x.key === "fin-model")?.chargedUnits, truth.charged);
    const today = fin.ai.daily.at(-1)!;
    assert.deepEqual([fin.ai.daily.length, today.requests, today.providerCostMicroUsd], [14, truth.n, truth.cost]);
    assert.equal(fin.ai.daily.slice(0, -1).reduce((x, d) => x + d.requests, 0), 0);
  });
  it("the health checks are all zero on a healthy system, and show a problem when there is one", async () => {
    const { f, p, db } = await mods();
    const clean = f.financeOverview(Date.now()).health;
    assert.deepEqual([clean.walletMismatches, clean.bucketMismatches, clean.duplicatePaymentsToRefund, clean.failedNoticesLast7Days, clean.stuckAiRequests], [0, 0, 0, 0, 0]);
    // A second payment for something already paid waits to be refunded...
    const target = db.getDb().prepare("SELECT id FROM subscription_invoices WHERE org_id = ? AND status = 'paid'").get(ids.pro) as { id: string };
    db.transaction((tx) => p.applySuccessfulPayment(tx, { provider: "testpay", providerPaymentId: "fin_dup", target: { kind: "invoice", invoiceId: target.id }, at: new Date().toISOString() }));
    assert.equal(f.financeOverview(Date.now()).health.duplicatePaymentsToRefund, 1);
    const dup = db.getDb().prepare("SELECT id FROM billing_payments WHERE provider_payment_id = 'fin_dup'").get() as { id: string };
    await p.refundPayment({ paymentId: dup.id, reason: "paid twice", requestedBy: "admin" });
    assert.equal(f.financeOverview(Date.now()).health.duplicatePaymentsToRefund, 0, "refunded, so no longer waiting");
    // ...and a mismatch between a wallet and its ledger is reported (done on a throwaway copy of the data, then undone).
    db.getDb().exec("PRAGMA foreign_keys = OFF");
    const org = ids.free!;
    const before = (db.getDb().prepare("SELECT balance_units AS n FROM credit_wallets WHERE org_id = ?").get(org) as { n: number }).n;
    db.getDb().prepare("UPDATE credit_wallets SET balance_units = balance_units + 7 WHERE org_id = ?").run(org);
    assert.ok(f.financeOverview(Date.now()).health.walletMismatches >= 1);
    db.getDb().prepare("UPDATE credit_wallets SET balance_units = ? WHERE org_id = ?").run(before, org);
    db.getDb().exec("PRAGMA foreign_keys = ON");
    assert.equal(f.financeOverview(Date.now()).health.walletMismatches, 0);
  });
  it("money recorded against the agency's own organization is not customer revenue", async () => {
    const { f, db } = await mods();
    const d = db.getDb();
    const internal = (d.prepare("SELECT id FROM organizations WHERE type = 'internal' LIMIT 1").get() as { id: string }).id;
    const before = f.financeOverview(T0 + 60_000).revenue.thisMonth.received;
    const at = new Date(T0).toISOString();
    d.prepare("INSERT INTO topups (id, number, org_id, package_id, credit_units, currency, subtotal_minor, gst_basis_points, gst_minor, total_minor, status, created_by, created_at, paid_at) VALUES ('top_internal', 'TOP-INTERNAL', ?, 'pkg_100', 100000, 'USD', 99999, 0, 0, 99999, 'paid', 'test', ?, ?)").run(internal, at, at);
    d.prepare("INSERT INTO billing_payments (id, org_id, provider, provider_payment_id, purpose, topup_id, currency, amount_minor, status, created_at, updated_at, paid_at) VALUES ('pay_internal', ?, 'manual', 'INTERNAL-1', 'topup', 'top_internal', 'USD', 99999, 'succeeded', ?, ?, ?)").run(internal, at, at, at);
    assert.deepEqual(f.financeOverview(T0 + 60_000).revenue.thisMonth.received, before, "unchanged");
  });
  it("a free trial counts as a trial, not as recurring revenue", async () => {
    const { f, s } = await mods();
    const before = f.financeOverview(T0 + 60_000).subscriptions;
    s.updatePlan("starter", { trialDays: 7, trialCreditUnits: 5000 });
    try {
      const org = await newOrg();
      s.startSubscription({ orgId: org, planId: "starter", currency: "USD", now: T0 });
      const after = f.financeOverview(T0 + 60_000).subscriptions;
      assert.deepEqual([after.inTrial, after.mrr], [before.inTrial + 1, before.mrr], "one more trial, no more recurring revenue");
    } finally { s.updatePlan("starter", { trialDays: null, trialCreditUnits: 0 }); }
  });
  it("a subscriber who has not paid the renewal is past due and no longer counted as recurring revenue", async () => {
    const { f, s } = await mods();
    const later = T0 + 32 * 86_400_000;
    s.processSubscriptions({ now: later });
    const sub = f.financeOverview(later).subscriptions;
    assert.equal(sub.pastDue, 2, "the two monthly subscribers who did not pay (the third was cancelled and has ended, the yearly one is not due)");
    assert.equal(sub.endedThisMonth, 1, "the cancelled one ended at the end of its period");
    assert.deepEqual(sub.mrr, { INR: Math.floor(499_000 / 12) }, "only the yearly subscriber, still inside the year they paid for, is recurring");
  });
  it("the route returns it", async () => {
    const finance = await import("@/app/api/admin/finance/route");
    const body = await (await finance.GET(req("/api/admin/finance", { headers: admin }))).json();
    assert.equal(body.success, true);
    assert.ok(body.finance.revenue && body.finance.subscriptions && body.finance.credits && body.finance.ai && body.finance.health);
  });
});
