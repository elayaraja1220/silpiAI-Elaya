// The six-plan catalogue in use: prices locked at sale, billing in each currency, coupons, free trials, and the one-credit-is-one-cent definition.
// Real SQLite, the real seeded catalogue. The AI provider (for the one gateway test) is a fake.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { NextRequest } from "next/server";

const dir = mkdtempSync(path.join(tmpdir(), "silpi-plans-"));
const ADMIN = "test-admin-token-0123456789abcdef";
const PASSWORD = "a-long-test-password";
const DAY = 86_400_000;
const T0 = Date.parse("2026-12-01T10:00:00.000Z");
let seq = 0;
const k = (p = "k") => `${p}-${++seq}-${Math.random().toString(36).slice(2, 8)}`;

const mods = async () => ({ s: await import("@/server/subscriptions"), co: await import("@/server/coupons"), c: await import("@/server/credits"), t: await import("@/server/tenancy"), db: await import("@/lib/business/db") });
const newOrg = async () => (await mods()).t.createOrganization({ name: `Plans Org ${++seq}`, type: "business" }).id;
const fails = async (fn: () => unknown, pattern: RegExp) => { try { await fn(); } catch (e) { assert.match((e as Error).message, pattern); return; } assert.fail(`expected an error matching ${pattern}`); };
/** Everything an invoice says, for assertions. */
const money = (i: { currency: string; listPriceMinor: number; discountMinor: number; gstPaise: number; totalPaise: number }) => ({ currency: i.currency, subtotal: i.listPriceMinor, discount: i.discountMinor, gst: i.gstPaise, total: i.totalPaise });

before(() => { process.env.SILPI_DB_PATH = path.join(dir, "plans.db"); process.env.SILPI_ADMIN_TOKEN = ADMIN; delete process.env.ANTHROPIC_API_KEY; });
after(() => {
  const cached = globalThis as unknown as { silpiDb?: { close(): void } };
  cached.silpiDb?.close();
  delete cached.silpiDb;
  rmSync(dir, { recursive: true, force: true });
});

// =================================================================================================
describe("1. a subscription keeps the price and the allowance it was sold at", () => {
  it("changing a plan's price or credits does not touch an existing customer's renewal, but the next customer gets the new figures", async () => {
    const { s, c } = await mods();
    const a = await newOrg();
    const { invoice, subscription } = s.startSubscription({ orgId: a, planId: "pro", currency: "INR", now: T0 });
    assert.deepEqual(money(invoice!), { currency: "INR", subtotal: 149_900, discount: 0, gst: 26_982, total: 176_882 });
    assert.deepEqual([subscription.currency, subscription.unitAmountMinor, subscription.allowanceMonthlyUnits], ["INR", 149_900, 700_000], "locked when sold");
    s.markInvoicePaid({ invoiceId: invoice!.id, providerRef: "UPI-LOCK-1", now: T0 });
    assert.equal(c.getWallet(a).balanceUnits, 700_000);

    try {
      s.setPlanPrice({ planId: "pro", currency: "INR", period: "monthly", amountMinor: 199_900 }); // the administrator raises the list price
      s.updatePlan("pro", { monthlyCreditUnits: 100_000 }); // and cuts the allowance
      s.processSubscriptions({ now: T0 + 25 * DAY });
      const renewal = s.listInvoices(a).find((i) => i.status === "open")!;
      assert.equal(renewal.subtotalPaise, 149_900, "the renewal is at the price it was sold at");
      s.markInvoicePaid({ invoiceId: renewal.id, providerRef: "UPI-LOCK-2", now: T0 + 25 * DAY });
      assert.equal(c.getWallet(a).balanceUnits, 1_400_000, "and gets the allowance it was sold with");

      const b = await newOrg();
      const fresh = s.startSubscription({ orgId: b, planId: "pro", currency: "INR", now: T0 });
      assert.equal(fresh.invoice!.subtotalPaise, 199_900, "a new customer pays the new price");
      s.markInvoicePaid({ invoiceId: fresh.invoice!.id, providerRef: "UPI-LOCK-3", now: T0 });
      assert.equal(c.getWallet(b).balanceUnits, 100_000, "and gets the new allowance");
    } finally {
      s.setPlanPrice({ planId: "pro", currency: "INR", period: "monthly", amountMinor: 149_900 });
      s.updatePlan("pro", { monthlyCreditUnits: 700_000 });
    }
    assert.deepEqual((await mods()).c.auditWallets(), []);
  });
  it("existing subscriptions were locked to their price by the migration itself", async () => {
    const { db } = await mods();
    const unlocked = db.getDb().prepare("SELECT COUNT(*) AS n FROM subscriptions WHERE unit_amount_minor IS NULL AND plan_id != 'enterprise'").get() as { n: number };
    assert.equal(unlocked.n, 0, "every subscription carries the amount it is billed at");
  });
});

// =================================================================================================
describe("2. billing in each currency", () => {
  it("an invoice is in the currency chosen; only rupee invoices carry GST", async () => {
    const { s } = await mods();
    const at = async (currency: string, period: "monthly" | "annual" = "monthly") => money((s.startSubscription({ orgId: await newOrg(), planId: "pro", currency, period, now: T0 }).invoice)!);
    assert.deepEqual(await at("USD"), { currency: "USD", subtotal: 1900, discount: 0, gst: 0, total: 1900 });
    assert.deepEqual(await at("GBP"), { currency: "GBP", subtotal: 1500, discount: 0, gst: 0, total: 1500 });
    assert.deepEqual(await at("INR"), { currency: "INR", subtotal: 149_900, discount: 0, gst: 26_982, total: 176_882 });
    assert.deepEqual(await at("USD", "annual"), { currency: "USD", subtotal: 19_000, discount: 0, gst: 0, total: 19_000 }, "two months free");
  });
  it("the default is rupees, so earlier callers are unaffected", async () => {
    const { s } = await mods();
    assert.equal(s.startSubscription({ orgId: await newOrg(), planId: "starter", now: T0 }).invoice!.currency, "INR");
  });
  it("a currency a plan is not sold in is refused until the administrator adds a price; an unknown currency never works", async () => {
    const { s } = await mods();
    await fails(() => s.startSubscription({ orgId: undefined as never, planId: "pro", currency: "EUR" }), /./);
    const org = await newOrg();
    await fails(() => s.startSubscription({ orgId: org, planId: "pro", currency: "EUR", now: T0 }), /not sold monthly in EUR/);
    await fails(() => s.startSubscription({ orgId: org, planId: "pro", currency: "XYZ", now: T0 }), /currency must be/);
    s.setPlanPrice({ planId: "pro", currency: "EUR", period: "monthly", amountMinor: 1800 });
    try {
      assert.deepEqual(money(s.startSubscription({ orgId: org, planId: "pro", currency: "EUR", now: T0 }).invoice!), { currency: "EUR", subtotal: 1800, discount: 0, gst: 0, total: 1800 });
    } finally {
      s.setPlanPrice({ planId: "pro", currency: "EUR", period: "monthly", amountMinor: null });
    }
  });
  it("an organization on Free picks its billing currency when it upgrades, and then stays in it", async () => {
    const { s } = await mods();
    const org = await newOrg();
    s.startSubscription({ orgId: org, planId: "free", now: T0 });
    const up = s.changePlan({ orgId: org, planId: "pro", currency: "USD", now: T0 });
    assert.deepEqual(money(up.invoice!), { currency: "USD", subtotal: 1900, discount: 0, gst: 0, total: 1900 });
    s.markInvoicePaid({ invoiceId: up.invoice!.id, providerRef: "CARD-CUR-1", now: T0 });
    await fails(() => s.changePlan({ orgId: org, planId: "professional", currency: "INR", now: T0 }), /billed in USD/);
    const next = s.changePlan({ orgId: org, planId: "professional", now: T0 });
    assert.deepEqual(money(next.invoice!), { currency: "USD", subtotal: 4900, discount: 0, gst: 0, total: 4900 }, "the upgrade is in the same currency");
  });
  it("a scheduled downgrade starts the lower plan in the same currency", async () => {
    const { s, db } = await mods();
    const org = await newOrg();
    const first = s.startSubscription({ orgId: org, planId: "professional", currency: "GBP", now: T0 });
    s.markInvoicePaid({ invoiceId: first.invoice!.id, providerRef: "CARD-DN-1", now: T0 });
    const change = s.changePlan({ orgId: org, planId: "starter", now: T0 + 2 * DAY });
    assert.equal(change.kind, "scheduled");
    s.processSubscriptions({ now: T0 + 33 * DAY });
    const waiting = db.getDb().prepare("SELECT plan_id, currency, unit_amount_minor, status FROM subscriptions WHERE org_id = ? AND status = 'pending_payment'").get(org) as { plan_id: string; currency: string; unit_amount_minor: number; status: string };
    assert.deepEqual({ ...waiting }, { plan_id: "starter", currency: "GBP", unit_amount_minor: 500, status: "pending_payment" });
  });
  it("Free is free in every currency", async () => {
    const { s } = await mods();
    for (const currency of ["USD", "GBP", "INR", "EUR", "JPY"]) assert.equal(s.priceOf((await mods()).db.getDb(), "free", currency, "monthly"), 0, currency);
  });
});

// =================================================================================================
describe("3. a credit is worth one cent", () => {
  it("the settings and every model carry the new definition, with the old markup kept in the price history", async () => {
    const cat = await import("@/server/ai/catalog");
    const { db } = await mods();
    assert.equal(cat.getUnitsPerUsd(), 100_000, "100 credits (100,000 units) per dollar of charge");
    for (const m of cat.listModels().filter((x) => x.provider !== "echo")) assert.deepEqual([m.markupBasisPoints, m.priceVersion], [25_000, 2], m.id);
    assert.equal((db.getDb().prepare("SELECT value FROM settings WHERE key = 'credit_definition'").get() as { value: string }).value, "1 credit = USD 0.01 of customer-facing AI usage value");
  });
  it("through the real gateway, $0.40 of provider cost is charged as exactly 100 credits", async () => {
    const g = await import("@/server/ai/gateway");
    const prov = await import("@/server/ai/providers");
    const { c } = await mods();
    const org = await newOrg();
    c.addCredits({ orgId: org, units: 1_000_000, kind: "grant", idempotencyKey: k("fund") });
    // The balanced model is $2 per million input tokens: 200,000 input tokens = $0.40 of provider cost.
    const adapter: import("@/server/ai/providers").ProviderAdapter = { id: "anthropic", isConfigured: () => true, complete: async () => ({ text: "ok", inputTokens: 200_000, outputTokens: 0, providerRequestId: null }) };
    const r = await g.complete({ orgId: org, model: "sonnet-5-5", messages: [{ role: "user", content: "hello" }], maxOutputTokens: 100, idempotencyKey: k("req") }, { providers: { anthropic: adapter, echo: prov.echoAdapter }, sleep: async () => {} });
    assert.equal(r.chargedUnits, 100_000, "100 credits");
    assert.equal(c.getWallet(org).balanceUnits, 900_000);
    assert.deepEqual(c.auditWallets(), []);
    assert.deepEqual(c.auditBuckets(), []);
  });
});

// =================================================================================================
describe("4. coupons", () => {
  const code = () => `SAVE-${++seq}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  /** One renewal cycle: raise the renewal invoice a few days before the end, then pay it. Returns the invoice. */
  async function renew(orgId: string, daysFromStart: number) {
    const { s } = await mods();
    s.processSubscriptions({ now: T0 + daysFromStart * DAY });
    const inv = s.listInvoices(orgId).find((i) => i.status === "open")!;
    s.markInvoicePaid({ invoiceId: inv.id, providerRef: `PAY-${inv.number}`, now: T0 + daysFromStart * DAY });
    return inv;
  }

  it("a percentage coupon for one invoice: the first invoice is discounted, the renewal is not", async () => {
    const { s, co } = await mods();
    const cp = code();
    co.saveCoupon({ code: cp, percentBasisPoints: 2000, duration: "once" });
    const org = await newOrg();
    const first = s.startSubscription({ orgId: org, planId: "pro", currency: "USD", couponCode: cp, now: T0 }).invoice!;
    assert.deepEqual(money(first), { currency: "USD", subtotal: 1900, discount: 380, gst: 0, total: 1520 });
    assert.equal(first.couponCode, cp);
    s.markInvoicePaid({ invoiceId: first.id, providerRef: "PAY-C1", now: T0 });
    const renewal = await renew(org, 25);
    assert.deepEqual(money(renewal), { currency: "USD", subtotal: 1900, discount: 0, gst: 0, total: 1900 });
  });
  it("a repeating coupon covers that many months, and a forever coupon every invoice", async () => {
    const { s, co } = await mods();
    const twice = code();
    const always = code();
    co.saveCoupon({ code: twice, percentBasisPoints: 5000, duration: "repeating", durationMonths: 2 });
    co.saveCoupon({ code: always, percentBasisPoints: 1000, duration: "forever" });
    const a = await newOrg();
    const b = await newOrg();
    const ia = s.startSubscription({ orgId: a, planId: "pro", currency: "USD", couponCode: twice, now: T0 }).invoice!;
    const ib = s.startSubscription({ orgId: b, planId: "pro", currency: "USD", couponCode: always, now: T0 }).invoice!;
    s.markInvoicePaid({ invoiceId: ia.id, providerRef: "PAY-R1", now: T0 });
    s.markInvoicePaid({ invoiceId: ib.id, providerRef: "PAY-F1", now: T0 });
    const seen = { twice: [ia.discountMinor], always: [ib.discountMinor] };
    for (const day of [25, 55, 85]) { // three renewals
      const forA = await renew(a, day);
      const forB = await renew(b, day);
      seen.twice.push(forA.discountMinor);
      seen.always.push(forB.discountMinor);
    }
    assert.deepEqual(seen.twice, [950, 950, 0, 0], "50% off the first two months, then full price");
    assert.deepEqual(seen.always, [190, 190, 190, 190], "10% off every month");
  });
  it("on a yearly plan a 'repeating 12 months' coupon covers exactly the first year's invoice", async () => {
    const { s, co } = await mods();
    const cp = code();
    co.saveCoupon({ code: cp, percentBasisPoints: 2500, duration: "repeating", durationMonths: 12 });
    const org = await newOrg();
    const first = s.startSubscription({ orgId: org, planId: "pro", period: "annual", currency: "USD", couponCode: cp, now: T0 }).invoice!;
    assert.deepEqual(money(first), { currency: "USD", subtotal: 19_000, discount: 4750, gst: 0, total: 14_250 });
  });
  it("a fixed coupon takes a set amount off, only in its own currency", async () => {
    const { s, co } = await mods();
    const cp = code();
    co.saveCoupon({ code: cp, fixedAmountMinor: 500, fixedCurrency: "USD", duration: "once" });
    const org = await newOrg();
    await fails(() => s.startSubscription({ orgId: org, planId: "pro", currency: "INR", couponCode: cp, now: T0 }), /only valid for payments in USD/);
    assert.deepEqual(money(s.startSubscription({ orgId: org, planId: "pro", currency: "USD", couponCode: cp, now: T0 }).invoice!), { currency: "USD", subtotal: 1900, discount: 500, gst: 0, total: 1400 });
  });
  it("a fixed coupon larger than the price cannot make an invoice negative", async () => {
    const { s, co } = await mods();
    const cp = code();
    co.saveCoupon({ code: cp, fixedAmountMinor: 100_000, fixedCurrency: "USD", duration: "once" });
    assert.deepEqual(money(s.startSubscription({ orgId: await newOrg(), planId: "starter", currency: "USD", couponCode: cp, now: T0 }).invoice!), { currency: "USD", subtotal: 600, discount: 600, gst: 0, total: 0 });
  });
  it("on a rupee invoice the GST is charged on the discounted amount", async () => {
    const { s, co } = await mods();
    const cp = code();
    co.saveCoupon({ code: cp, percentBasisPoints: 1000, duration: "once" });
    const inv = s.startSubscription({ orgId: await newOrg(), planId: "pro", currency: "INR", couponCode: cp, now: T0 }).invoice!;
    // 149,900 - 14,990 = 134,910 taxable; 18% = 24,283.8 -> 24,284; total 159,194
    assert.deepEqual(money(inv), { currency: "INR", subtotal: 149_900, discount: 14_990, gst: 24_284, total: 159_194 });
  });
  it("is not case sensitive, and an unknown code is refused", async () => {
    const { s, co } = await mods();
    const cp = code();
    co.saveCoupon({ code: cp, percentBasisPoints: 1000, duration: "once" });
    assert.equal(s.startSubscription({ orgId: await newOrg(), planId: "pro", currency: "USD", couponCode: cp.toLowerCase(), now: T0 }).invoice!.discountMinor, 190);
    await fails(() => s.startSubscription({ orgId: undefined as never, planId: "pro" }), /./);
    await fails(() => s.startSubscription({ orgId: (undefined as unknown as string), planId: "pro", couponCode: "NOPE" }), /./);
    const org = await newOrg();
    await fails(() => s.startSubscription({ orgId: org, planId: "pro", currency: "USD", couponCode: "DOES-NOT-EXIST", now: T0 }), /not recognised/);
    assert.equal(s.getBilling(org).running, null, "the failed attempt left no subscription behind");
  });
  it("is refused when it is off, not yet valid, expired, used up, for another plan, or already used by this organization", async () => {
    const { s, co } = await mods();
    const off = code(), early = code(), late = code(), one = code(), studio = code(), mine = code();
    co.saveCoupon({ code: off, percentBasisPoints: 1000, duration: "once", active: false });
    co.saveCoupon({ code: early, percentBasisPoints: 1000, duration: "once", validFrom: new Date(T0 + 30 * DAY).toISOString() });
    co.saveCoupon({ code: late, percentBasisPoints: 1000, duration: "once", validUntil: new Date(T0 - DAY).toISOString() });
    co.saveCoupon({ code: one, percentBasisPoints: 1000, duration: "once", maxRedemptions: 1 });
    co.saveCoupon({ code: studio, percentBasisPoints: 1000, duration: "once", planIds: ["studio"] });
    co.saveCoupon({ code: mine, percentBasisPoints: 1000, duration: "once" });
    const org = await newOrg();
    const start = (couponCode: string, planId = "pro", orgId = org) => () => s.startSubscription({ orgId, planId, currency: "USD", couponCode, now: T0 });
    await fails(start(off), /not available/);
    await fails(start(early), /not valid yet/);
    await fails(start(late), /expired/);
    await fails(start(studio), /does not apply to this plan/);
    s.startSubscription({ orgId: await newOrg(), planId: "pro", currency: "USD", couponCode: one, now: T0 });
    await fails(start(one), /reached its limit/);
    // Used once by this organization, then asked for again on an upgrade:
    const first = s.startSubscription({ orgId: org, planId: "starter", currency: "USD", couponCode: mine, now: T0 });
    s.markInvoicePaid({ invoiceId: first.invoice!.id, providerRef: "PAY-ONCE", now: T0 });
    await fails(() => s.changePlan({ orgId: org, planId: "pro", couponCode: mine, now: T0 }), /already used/);
  });
  it("a coupon is for a paid plan: not Free, and not a scheduled downgrade", async () => {
    const { s, co } = await mods();
    const cp = code();
    co.saveCoupon({ code: cp, percentBasisPoints: 1000, duration: "once" });
    await fails(() => s.startSubscription({ orgId: undefined as never, planId: "free", couponCode: cp }), /./);
    await fails(() => s.startSubscription({ orgId: (() => { throw new Error("skip"); })(), planId: "free" }), /skip/);
    const org = await newOrg();
    await fails(() => s.startSubscription({ orgId: org, planId: "free", couponCode: cp, now: T0 }), /paid plan/);
    const pro = s.startSubscription({ orgId: org, planId: "professional", currency: "USD", now: T0 });
    s.markInvoicePaid({ invoiceId: pro.invoice!.id, providerRef: "PAY-DN", now: T0 });
    await fails(() => s.changePlan({ orgId: org, planId: "starter", couponCode: cp, now: T0 }), /scheduled downgrade/);
  });
  it("a request that was replaced before it was paid gives its coupon back", async () => {
    const { s, co } = await mods();
    const cp = code();
    co.saveCoupon({ code: cp, percentBasisPoints: 1000, duration: "once", maxRedemptions: 1 });
    const org = await newOrg();
    s.startSubscription({ orgId: org, planId: "free", now: T0 });
    s.changePlan({ orgId: org, planId: "pro", currency: "USD", couponCode: cp, now: T0 });
    assert.equal(co.getCouponByCode(cp)!.redemptions, 1);
    s.changePlan({ orgId: org, planId: "studio", now: T0 }); // a newer choice replaces the unpaid one
    assert.equal(co.getCouponByCode(cp)!.redemptions, 0, "the unpaid attempt no longer holds the coupon");
    assert.equal(s.changePlan({ orgId: org, planId: "pro", currency: "USD", couponCode: cp, now: T0 }).invoice!.discountMinor, 190, "and it can be used again");
  });
  it("once organizations have used a coupon its discount cannot change, though it can be switched off", async () => {
    const { s, co } = await mods();
    const cp = code();
    co.saveCoupon({ code: cp, percentBasisPoints: 1000, duration: "once" });
    s.startSubscription({ orgId: await newOrg(), planId: "pro", currency: "USD", couponCode: cp, now: T0 });
    await fails(() => co.saveCoupon({ code: cp, percentBasisPoints: 9000, duration: "once" }), /cannot change/);
    await fails(() => co.saveCoupon({ code: cp, percentBasisPoints: 1000, duration: "forever" }), /cannot change/);
    assert.equal(co.saveCoupon({ code: cp, percentBasisPoints: 1000, duration: "once", active: false }).active, false);
    assert.equal(co.saveCoupon({ code: cp, percentBasisPoints: 1000, duration: "once", active: false, maxRedemptions: 50 }).maxRedemptions, 50);
    assert.equal(co.getCouponByCode(cp)!.redemptions, 1);
  });
  it("refuses a badly made coupon", async () => {
    const { co } = await mods();
    const base = { code: code(), duration: "once" };
    await fails(() => co.saveCoupon({ ...base, percentBasisPoints: 1000, fixedAmountMinor: 5, fixedCurrency: "USD" }), /either percentBasisPoints or fixedAmountMinor/);
    await fails(() => co.saveCoupon({ ...base }), /either percentBasisPoints or fixedAmountMinor/);
    await fails(() => co.saveCoupon({ ...base, percentBasisPoints: 0 }), /from 1 to 10000/);
    await fails(() => co.saveCoupon({ ...base, percentBasisPoints: 10_001 }), /from 1 to 10000/);
    await fails(() => co.saveCoupon({ ...base, fixedAmountMinor: 500 }), /fixedCurrency/);
    await fails(() => co.saveCoupon({ ...base, fixedAmountMinor: 0, fixedCurrency: "USD" }), /at least 1/);
    await fails(() => co.saveCoupon({ ...base, percentBasisPoints: 1000, duration: "repeating" }), /durationMonths/);
    await fails(() => co.saveCoupon({ ...base, percentBasisPoints: 1000, durationMonths: 3 }), /only applies to a repeating/);
    await fails(() => co.saveCoupon({ ...base, percentBasisPoints: 1000, duration: "monthly" }), /duration must be/);
    await fails(() => co.saveCoupon({ code: "no", percentBasisPoints: 1000 }), /3 to 40/);
    await fails(() => co.saveCoupon({ ...base, percentBasisPoints: 1000, validFrom: "2026-12-10T00:00:00Z", validUntil: "2026-12-01T00:00:00Z" }), /after validFrom/);
    await fails(() => co.saveCoupon({ ...base, percentBasisPoints: 1000, validUntil: "not a date" }), /valid date/);
    await fails(() => co.saveCoupon({ ...base, percentBasisPoints: 1000, maxRedemptions: 0 }), /1 or more/);
    await fails(() => co.saveCoupon({ ...base, percentBasisPoints: 1000, planIds: ["no-such-plan"] }), /does not exist/);
    await fails(() => co.saveCoupon({ ...base, percentBasisPoints: 1000, planIds: [] }), /at least one plan/);
  });
});

// =================================================================================================
describe("5. free trials", () => {
  async function withTrial<T>(planId: string, days: number, credits: number, fn: () => Promise<T>): Promise<T> {
    const { s } = await mods();
    s.updatePlan(planId, { trialDays: days, trialCreditUnits: credits });
    try { return await fn(); } finally { s.updatePlan(planId, { trialDays: null, trialCreditUnits: 0 }); }
  }
  it("a plan with trial days starts active at once, with its trial credits and no invoice", async () => {
    await withTrial("creator", 14, 50_000, async () => {
      const { s, c } = await mods();
      const org = await newOrg();
      const started = s.startSubscription({ orgId: org, planId: "creator", currency: "USD", now: T0 });
      assert.equal(started.invoice, null);
      assert.deepEqual([started.subscription.status, started.subscription.trialEndsAt, started.subscription.currentPeriodEnd], ["active", new Date(T0 + 14 * DAY).toISOString(), new Date(T0 + 14 * DAY).toISOString()]);
      assert.equal(c.getWallet(org).balanceUnits, 50_000, "the trial credits, not the full allowance");
      assert.equal(s.getBilling(org).plan!.id, "creator");
      assert.equal(s.listInvoices(org).length, 0);
    });
  });
  it("the first invoice appears in the week before the trial ends, and paying it before the end continues from the end of the trial", async () => {
    await withTrial("creator", 14, 50_000, async () => {
      const { s, c } = await mods();
      const org = await newOrg();
      s.startSubscription({ orgId: org, planId: "creator", currency: "USD", now: T0 });
      s.processSubscriptions({ now: T0 + 5 * DAY });
      assert.equal(s.listInvoices(org).length, 0, "too early");
      s.processSubscriptions({ now: T0 + 8 * DAY });
      const inv = s.listInvoices(org).find((i) => i.status === "open")!;
      assert.deepEqual(money(inv), { currency: "USD", subtotal: 1200, discount: 0, gst: 0, total: 1200 });
      assert.equal(inv.periodStart, new Date(T0 + 14 * DAY).toISOString(), "the paid month begins when the trial ends");
      const paid = s.markInvoicePaid({ invoiceId: inv.id, providerRef: "CARD-TRIAL-1", now: T0 + 9 * DAY });
      assert.equal(paid.subscription.currentPeriodStart, new Date(T0 + 14 * DAY).toISOString());
      assert.equal(c.getWallet(org).balanceUnits, 50_000 + 400_000, "the full allowance arrives when the paid month begins");
      assert.deepEqual(c.auditBuckets(), []);
    });
  });
  it("unpaid at the end of the trial it is past due, then back to Free after the grace days", async () => {
    await withTrial("creator", 7, 10_000, async () => {
      const { s } = await mods();
      const org = await newOrg();
      s.startSubscription({ orgId: org, planId: "creator", currency: "USD", now: T0 });
      s.processSubscriptions({ now: T0 + 8 * DAY });
      assert.equal(s.getBilling(org).running!.status, "past_due");
      s.processSubscriptions({ now: T0 + 8 * DAY + 8 * DAY });
      assert.equal(s.getBilling(org).plan!.id, "free");
    });
  });
  it("an organization has one trial: after it, a trial plan starts pending payment", async () => {
    await withTrial("creator", 7, 10_000, async () => {
      const { s } = await mods();
      const org = await newOrg();
      s.startSubscription({ orgId: org, planId: "creator", currency: "USD", now: T0 });
      s.processSubscriptions({ now: T0 + 8 * DAY });
      s.processSubscriptions({ now: T0 + 17 * DAY });
      assert.equal(s.getBilling(org).plan!.id, "free");
      const again = s.changePlan({ orgId: org, planId: "creator", now: T0 + 18 * DAY });
      assert.ok(again.invoice, "an invoice, not a second trial");
      assert.equal(s.getBilling(org).pending!.status, "pending_payment");
    });
  });
  it("cancelling during the trial means no invoice is ever raised", async () => {
    await withTrial("creator", 7, 10_000, async () => {
      const { s } = await mods();
      const org = await newOrg();
      s.startSubscription({ orgId: org, planId: "creator", currency: "USD", now: T0 });
      s.cancelSubscription({ orgId: org, now: T0 + DAY });
      s.processSubscriptions({ now: T0 + 3 * DAY });
      s.processSubscriptions({ now: T0 + 8 * DAY });
      assert.equal(s.listInvoices(org).length, 0);
      assert.equal(s.getBilling(org).plan!.id, "free");
    });
  });
  it("a coupon used at the start of a trial discounts the first invoice", async () => {
    await withTrial("creator", 14, 0, async () => {
      const { s, co } = await mods();
      const cp = `TRIAL-${++seq}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
      co.saveCoupon({ code: cp, percentBasisPoints: 5000, duration: "once" });
      const org = await newOrg();
      s.startSubscription({ orgId: org, planId: "creator", currency: "USD", couponCode: cp, now: T0 });
      s.processSubscriptions({ now: T0 + 9 * DAY });
      assert.deepEqual(money(s.listInvoices(org)[0]!), { currency: "USD", subtotal: 1200, discount: 600, gst: 0, total: 600 });
    });
  });
  it("trial days must be a sensible number, and Free has no trial", async () => {
    const { s } = await mods();
    await fails(() => s.updatePlan("creator", { trialDays: 0 }), /from 1 to 365/);
    await fails(() => s.updatePlan("creator", { trialDays: 400 }), /from 1 to 365/);
    await fails(() => s.updatePlan("creator", { trialCreditUnits: -1 }), /whole number/);
    await fails(() => s.updatePlan("free", { trialDays: 7 }), /no trial/);
  });
});

// =================================================================================================
describe("6. the HTTP API", () => {
  type Init = { method?: string; body?: unknown; cookie?: string; headers?: Record<string, string> };
  function req(url: string, init: Init = {}): NextRequest {
    const headers: Record<string, string> = { host: "localhost:3000", origin: "http://localhost:3000", "x-forwarded-for": `10.6.0.${++seq % 250}`, ...(init.headers ?? {}) };
    if (init.cookie) headers.cookie = init.cookie;
    if (init.body !== undefined) headers["content-type"] = "application/json";
    return new NextRequest(`http://localhost:3000${url}`, { method: init.method ?? "GET", headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  }
  const admin = { authorization: `Bearer ${ADMIN}` };
  async function customer(name: string) {
    const users = await import("@/app/api/admin/users/route");
    const login = await import("@/app/api/auth/login/route");
    const email = `owner@${name}.example`;
    const made = await users.POST(req("/api/admin/users", { method: "POST", headers: admin, body: { email, name: email, password: PASSWORD, newOrg: { name, type: "agency" } } }));
    assert.equal(made.status, 200, await made.clone().text());
    const org = (await made.json()).organization.id as string;
    const res = await login.POST(req("/api/auth/login", { method: "POST", body: { email, password: PASSWORD } }));
    return { org, cookie: `silpi_session=${/silpi_session=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")![1]}` };
  }

  it("the administrator's plan-price and coupon routes need the token and do what they say", async () => {
    const prices = await import("@/app/api/admin/plans/prices/route");
    const coupons = await import("@/app/api/admin/coupons/route");
    assert.equal((await prices.PUT(req("/api/admin/plans/prices", { method: "PUT", body: { planId: "pro", currency: "USD", period: "monthly", amountMinor: 1 } }))).status, 401);
    assert.equal((await coupons.GET(req("/api/admin/coupons"))).status, 401);
    assert.equal((await coupons.PUT(req("/api/admin/coupons", { method: "PUT", body: {} }))).status, 401);
    const made = await coupons.PUT(req("/api/admin/coupons", { method: "PUT", headers: admin, body: { code: "API-LAUNCH-20", percentBasisPoints: 2000, duration: "once", maxRedemptions: 100 } }));
    assert.equal(made.status, 200);
    assert.equal((await made.json()).coupon.code, "API-LAUNCH-20");
    assert.equal((await coupons.PUT(req("/api/admin/coupons", { method: "PUT", headers: admin, body: { code: "bad", percentBasisPoints: 20_000 } }))).status, 400);
    assert.ok((await (await coupons.GET(req("/api/admin/coupons", { headers: admin }))).json()).coupons.some((c: { code: string }) => c.code === "API-LAUNCH-20"));
    const set = await prices.PUT(req("/api/admin/plans/prices", { method: "PUT", headers: admin, body: { planId: "studio", currency: "AUD", period: "monthly", amountMinor: 14_900 } }));
    assert.equal(set.status, 200);
    assert.ok((await set.json()).plan.prices.some((p: { currency: string; amountMinor: number }) => p.currency === "AUD" && p.amountMinor === 14_900));
    assert.equal((await prices.PUT(req("/api/admin/plans/prices", { method: "PUT", headers: admin, body: { planId: "studio", currency: "ZZZ", period: "monthly", amountMinor: 1 } }))).status, 400);
    await prices.PUT(req("/api/admin/plans/prices", { method: "PUT", headers: admin, body: { planId: "studio", currency: "AUD", period: "monthly", amountMinor: null } }));
  });
  it("a customer upgrades from Free in dollars with a coupon through the billing route", async () => {
    const route = await import("@/app/api/workspace/billing/plan/route");
    const owner = await customer("plans-api");
    const ask = (body: unknown) => route.POST(req("/api/workspace/billing/plan", { method: "POST", cookie: owner.cookie, body }));
    assert.equal((await ask({ planId: "pro", currency: "XYZ" })).status, 400);
    assert.equal((await ask({ planId: "pro", currency: "USD", couponCode: "NOT-A-CODE" })).status, 400);
    const ok = await ask({ planId: "pro", currency: "USD", couponCode: "api-launch-20" });
    assert.equal(ok.status, 200, await ok.clone().text());
    const body = await ok.json();
    assert.deepEqual(money(body.result.invoice), { currency: "USD", subtotal: 1900, discount: 380, gst: 0, total: 1520 });
  });
});
