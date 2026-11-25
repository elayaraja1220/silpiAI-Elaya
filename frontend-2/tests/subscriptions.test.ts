// Phase 2: plans, subscriptions, invoices and the credits they grant. Real SQLite database; every date is explicit.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { useFixedCatalogue } from "./fixtures/fixed-pricing";

const dir = mkdtempSync(path.join(tmpdir(), "silpi-subs-"));
const mods = async () => ({ s: await import("@/server/subscriptions"), c: await import("@/server/credits"), t: await import("@/server/tenancy"), db: await import("@/lib/business/db"), m: await import("@/lib/business/migrations") });
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 15, 10, 0, 0); // 15 Jan 2026, 10:00 UTC
const at = (ms: number) => new Date(ms).toISOString();
let n = 0;
const newOrg = async (type: "business" | "freelancer" = "business") => (await mods()).t.createOrganization({ name: `Org ${++n}`, type }).id;
const fails = (fn: () => unknown, pattern: RegExp) => assert.throws(fn, pattern);

before(async () => {
  process.env.SILPI_DB_PATH = path.join(dir, "subs.db");
  await useFixedCatalogue(); // these tests are about how billing works, not about today's commercial plans
});
after(() => {
  const cached = globalThis as unknown as { silpiDb?: { close(): void } };
  cached.silpiDb?.close();
  delete cached.silpiDb;
  rmSync(dir, { recursive: true, force: true });
});

// =================================================================================================
describe("1. months are calendar months", () => {
  it("adds months in UTC, clamping the day, across years and leap years", async () => {
    const { s } = await mods();
    assert.equal(s.addMonths("2026-01-31T10:00:00.000Z", 1), "2026-02-28T10:00:00.000Z");
    assert.equal(s.addMonths("2028-01-31T10:00:00.000Z", 1), "2028-02-29T10:00:00.000Z");
    assert.equal(s.addMonths("2026-12-15T10:00:00.000Z", 1), "2027-01-15T10:00:00.000Z");
    assert.equal(s.addMonths("2026-01-15T10:00:00.000Z", 12), "2027-01-15T10:00:00.000Z");
    assert.equal(s.addMonths("2026-03-31T00:00:00.000Z", 1), "2026-04-30T00:00:00.000Z");
  });
});

// =================================================================================================
describe("2. plans are data", () => {
  it("starts with the six plans and Enterprise, as ordinary rows, in order", async () => {
    const { s } = await mods();
    const plans = s.listPlans();
    assert.deepEqual(plans.map((p) => p.id), ["free", "starter", "creator", "pro", "professional", "studio", "enterprise"]);
    const pro = plans.find((p) => p.id === "pro")!;
    assert.deepEqual([pro.monthlyPricePaise, pro.annualPricePaise, pro.monthlyCreditUnits], [149_900, 1_499_000, 400_000]);
    assert.deepEqual([plans[plans.length - 1].isCustom, plans[plans.length - 1].monthlyPricePaise], [true, null]);
  });
  it("an administrator can change a price; new invoices use it, nothing hardcoded", async () => {
    const { s } = await mods();
    const before = s.getPlan("starter")!;
    try {
      s.updatePlan("starter", { monthlyPricePaise: 70_000, monthlyCreditUnits: 150_000, name: "Starter Plus" });
      const org = await newOrg();
      const { invoice } = s.startSubscription({ orgId: org, planId: "starter", now: T0 });
      assert.deepEqual([invoice!.subtotalPaise, invoice!.gstPaise, invoice!.totalPaise], [70_000, 12_600, 82_600]);
      assert.equal(s.getPlan("starter")!.name, "Starter Plus");
    } finally {
      s.updatePlan("starter", { monthlyPricePaise: before.monthlyPricePaise, monthlyCreditUnits: before.monthlyCreditUnits, name: before.name });
    }
  });
  it("refuses bad plan edits and unknown fields; the id cannot change", async () => {
    const { s } = await mods();
    fails(() => s.updatePlan("nope", { name: "x" }), /does not exist/);
    fails(() => s.updatePlan("pro", { monthlyPricePaise: -1 }), /whole number of paise/);
    fails(() => s.updatePlan("pro", { monthlyPricePaise: 10.5 }), /whole number of paise/);
    fails(() => s.updatePlan("pro", { monthlyPricePaise: null }), /needs a monthly price/);
    fails(() => s.updatePlan("pro", { monthlyCreditUnits: 1.5 }), /whole number of units/);
    fails(() => s.updatePlan("pro", { name: " " }), /name is required/);
    fails(() => s.updatePlan("pro", { id: "other" } as never), /Unknown plan field/);
    assert.equal(s.getPlan("pro")!.monthlyPricePaise, 149_900);
  });
  it("a plan that is switched off is not listed and cannot be started", async () => {
    const { s } = await mods();
    const org = await newOrg();
    s.updatePlan("starter", { active: false });
    try {
      assert.ok(!s.listPlans().some((p) => p.id === "starter"));
      assert.ok(s.listPlans({ includeInactive: true }).some((p) => p.id === "starter"));
      fails(() => s.startSubscription({ orgId: org, planId: "starter", now: T0 }), /not available/);
    } finally {
      s.updatePlan("starter", { active: true });
    }
  });
});

// =================================================================================================
describe("3. starting a subscription", () => {
  it("Free is active at once and grants its credits", async () => {
    const { s, c } = await mods();
    const org = await newOrg();
    const { subscription, invoice } = s.startSubscription({ orgId: org, planId: "free", now: T0 });
    assert.equal(invoice, null);
    assert.deepEqual([subscription.status, subscription.currentPeriodStart, subscription.currentPeriodEnd], ["active", at(T0), "2026-02-15T10:00:00.000Z"]);
    assert.equal(c.getWallet(org).balanceUnits, 10_000);
    assert.equal(c.listLedger(org)[0].note, "Free plan, monthly");
  });
  it("a paid plan waits for payment: pending, an open invoice with GST, and NO credits yet", async () => {
    const { s, c } = await mods();
    const org = await newOrg();
    const { subscription, invoice } = s.startSubscription({ orgId: org, planId: "pro", now: T0 });
    assert.equal(subscription.status, "pending_payment");
    assert.deepEqual([invoice!.status, invoice!.subtotalPaise, invoice!.gstBasisPoints, invoice!.gstPaise, invoice!.totalPaise], ["open", 149_900, 1800, 26_982, 176_882]);
    assert.match(invoice!.number, /^INV-2026-\d{5}$/);
    assert.equal(c.getWallet(org).balanceUnits, 0);
  });
  it("invoice numbers never repeat", async () => {
    const { s } = await mods();
    const numbers = new Set<string>();
    for (let i = 0; i < 5; i++) numbers.add(s.startSubscription({ orgId: await newOrg(), planId: "starter", now: T0 }).invoice!.number);
    assert.equal(numbers.size, 5);
  });
  it("one subscription per organization; the agency, suspended organizations and custom plans are refused", async () => {
    const { s, t, db, m } = await mods();
    const org = await newOrg();
    s.startSubscription({ orgId: org, planId: "free", now: T0 });
    fails(() => s.startSubscription({ orgId: org, planId: "pro", now: T0 }), /already has a subscription/);
    fails(() => s.startSubscription({ orgId: m.AGENCY_ORG_ID, planId: "free", now: T0 }), /agency does not subscribe/);
    fails(() => s.startSubscription({ orgId: "org_missing", planId: "free", now: T0 }), /does not exist/);
    const suspended = t.createOrganization({ name: "Suspended", type: "business" });
    db.getDb().prepare("UPDATE organizations SET status = 'suspended' WHERE id = ?").run(suspended.id);
    fails(() => s.startSubscription({ orgId: suspended.id, planId: "free", now: T0 }), /suspended/);
    const fresh = await newOrg();
    fails(() => s.startSubscription({ orgId: fresh, planId: "enterprise", now: T0 }), /arranged individually/);
    fails(() => s.startSubscription({ orgId: fresh, planId: "pro", period: "weekly" as never, now: T0 }), /monthly or annual/);
    fails(() => s.startSubscription({ orgId: fresh, planId: "ghost", now: T0 }), /does not exist/);
    assert.equal(s.getBilling(fresh).running, null, "none of the refused attempts left anything behind");
    assert.equal(s.getBilling(fresh).pending, null);
  });
  it("the database allows only one running subscription per organization, even by direct SQL", async () => {
    const { s, db } = await mods();
    const org = await newOrg();
    s.startSubscription({ orgId: org, planId: "free", now: T0 });
    assert.throws(() => db.getDb().prepare("INSERT INTO subscriptions (id, org_id, plan_id, status, billing_period, created_at, updated_at) VALUES ('x', ?, 'free', 'active', 'monthly', 't', 't')").run(org), /UNIQUE/);
  });
});

// =================================================================================================
describe("4. paying an invoice", () => {
  it("activates the plan and grants its credits, once", async () => {
    const { s, c } = await mods();
    const org = await newOrg();
    const { invoice } = s.startSubscription({ orgId: org, planId: "pro", now: T0 });
    const paid = s.markInvoicePaid({ invoiceId: invoice!.id, providerRef: "UPI-123456", now: T0 + 3_600_000 });
    assert.deepEqual([paid.invoice.status, paid.invoice.providerRef, paid.invoice.paidAt], ["paid", "UPI-123456", at(T0 + 3_600_000)]);
    assert.deepEqual([paid.subscription.status, paid.subscription.currentPeriodStart, paid.subscription.currentPeriodEnd], ["active", at(T0 + 3_600_000), "2026-02-15T11:00:00.000Z"]);
    assert.equal(paid.invoice.periodStart, at(T0 + 3_600_000), "the period starts when the money arrives");
    assert.equal(c.getWallet(org).balanceUnits, 400_000);
    // repeating the same confirmation (a webhook retry) changes nothing
    s.markInvoicePaid({ invoiceId: invoice!.id, providerRef: "UPI-123456", now: T0 + 7_200_000 });
    assert.equal(c.getWallet(org).balanceUnits, 400_000, "credited once");
    fails(() => s.markInvoicePaid({ invoiceId: invoice!.id, providerRef: "OTHER-REF", now: T0 }), /different reference/);
    fails(() => s.markInvoicePaid({ invoiceId: invoice!.id, providerRef: "x", now: T0 }), /3 to 200/);
    fails(() => s.markInvoicePaid({ invoiceId: "inv_missing", providerRef: "UPI-1234", now: T0 }), /does not exist/);
  });
  it("an annual plan costs the annual price and grants twelve months of credits at once", async () => {
    const { s, c } = await mods();
    const org = await newOrg();
    const { invoice } = s.startSubscription({ orgId: org, planId: "professional", period: "annual", now: T0 });
    assert.equal(invoice!.subtotalPaise, 4_499_000, "ten months of Rs 4,499");
    const { subscription } = s.markInvoicePaid({ invoiceId: invoice!.id, providerRef: "NEFT-9988", now: T0 });
    assert.equal(subscription.currentPeriodEnd, "2027-01-15T10:00:00.000Z");
    assert.equal(c.getWallet(org).balanceUnits, 14_400_000, "twelve months of the Professional allowance (1,200 credits a month)");
  });
  it("the invoice, subscription and credits change together: if the grant fails, nothing is marked paid", async () => {
    const { s, c, db } = await mods();
    const org = await newOrg();
    const { invoice } = s.startSubscription({ orgId: org, planId: "pro", now: T0 });
    // Sabotage: make the credit grant fail by pre-using its key for a different amount.
    const sub = s.getBilling(org).pending!;
    c.addCredits({ orgId: org, units: 7, kind: "grant", idempotencyKey: `plan:${sub.id}:${at(T0 + 1000)}` });
    assert.throws(() => s.markInvoicePaid({ invoiceId: invoice!.id, providerRef: "UPI-777777", now: T0 + 1000 }), /idempotency key/);
    assert.equal(s.getInvoice(invoice!.id)!.status, "open", "still open");
    assert.equal(s.getBilling(org).pending!.status, "pending_payment", "still waiting");
    assert.equal((db.getDb().prepare("SELECT COUNT(*) AS n FROM subscriptions WHERE org_id = ? AND status = 'active'").get(org) as { n: number }).n, 0);
  });
  it("a cancelled invoice cannot be paid", async () => {
    const { s, db } = await mods();
    const org = await newOrg();
    const { invoice } = s.startSubscription({ orgId: org, planId: "starter", now: T0 });
    db.getDb().prepare("UPDATE subscription_invoices SET status = 'void' WHERE id = ?").run(invoice!.id);
    fails(() => s.markInvoicePaid({ invoiceId: invoice!.id, providerRef: "UPI-555555", now: T0 }), /cancelled/);
  });
});

// =================================================================================================
describe("5. changing plan", () => {
  it("an upgrade waits for payment while the current plan keeps running; paying it replaces the old one", async () => {
    const { s, c } = await mods();
    const org = await newOrg();
    s.startSubscription({ orgId: org, planId: "free", now: T0 });
    const up = s.changePlan({ orgId: org, planId: "pro", now: T0 + DAY });
    assert.deepEqual([up.kind, up.subscription.status, up.invoice!.subtotalPaise], ["upgrade", "pending_payment", 149_900]);
    let b = s.getBilling(org);
    assert.deepEqual([b.running!.planId, b.pending!.planId, b.openInvoices.length], ["free", "pro", 1]);
    s.markInvoicePaid({ invoiceId: up.invoice!.id, providerRef: "UPI-UP0001", now: T0 + 2 * DAY });
    b = s.getBilling(org);
    assert.deepEqual([b.running!.planId, b.pending, b.openInvoices.length], ["pro", null, 0]);
    assert.equal(c.getWallet(org).balanceUnits, 10_000 + 400_000, "the Free credits stay, the Pro credits are added");
  });
  it("a newer upgrade choice replaces an unpaid one and cancels its invoice", async () => {
    const { s } = await mods();
    const org = await newOrg();
    s.startSubscription({ orgId: org, planId: "free", now: T0 });
    const first = s.changePlan({ orgId: org, planId: "starter", now: T0 + DAY });
    const second = s.changePlan({ orgId: org, planId: "pro", now: T0 + 2 * DAY });
    assert.equal(s.getInvoice(first.invoice!.id)!.status, "void");
    assert.equal(s.getBilling(org).pending!.planId, "pro");
    assert.deepEqual(s.getBilling(org).openInvoices.map((i) => i.id), [second.invoice!.id]);
  });
  it("monthly to annual of the same plan is an upgrade; annual back to monthly is not supported", async () => {
    const { s } = await mods();
    const org = await newOrg();
    const start = s.startSubscription({ orgId: org, planId: "pro", now: T0 });
    s.markInvoicePaid({ invoiceId: start.invoice!.id, providerRef: "UPI-AN0001", now: T0 });
    fails(() => s.changePlan({ orgId: org, planId: "pro", now: T0 + DAY }), /already the current plan/);
    const annual = s.changePlan({ orgId: org, planId: "pro", period: "annual", now: T0 + DAY });
    assert.deepEqual([annual.kind, annual.invoice!.subtotalPaise], ["upgrade", 1_499_000]);
    s.markInvoicePaid({ invoiceId: annual.invoice!.id, providerRef: "UPI-AN0002", now: T0 + 2 * DAY });
    fails(() => s.changePlan({ orgId: org, planId: "pro", period: "monthly", now: T0 + 3 * DAY }), /annual back to monthly is not supported/);
  });
  it("a downgrade is scheduled for the end of the period and can be undone", async () => {
    const { s } = await mods();
    const org = await newOrg();
    const start = s.startSubscription({ orgId: org, planId: "pro", now: T0 });
    s.markInvoicePaid({ invoiceId: start.invoice!.id, providerRef: "UPI-DN0001", now: T0 });
    const down = s.changePlan({ orgId: org, planId: "starter", now: T0 + DAY });
    assert.deepEqual([down.kind, down.effectiveAt, down.invoice, down.subscription.pendingPlanId], ["scheduled", "2026-02-15T10:00:00.000Z", null, "starter"]);
    assert.equal(s.getBilling(org).running!.planId, "pro", "still on Pro until the period ends");
    assert.equal(s.getBilling(org).scheduledPlan!.id, "starter");
    assert.equal(s.keepSubscription({ orgId: org, now: T0 + 2 * DAY }).pendingPlanId, null);
  });
  it("refuses a change with no subscription, to a custom or unknown plan", async () => {
    const { s } = await mods();
    fails(() => s.changePlan({ orgId: "org_missing", planId: "pro", now: T0 }), /does not exist/);
    const org = await newOrg();
    fails(() => s.changePlan({ orgId: org, planId: "pro", now: T0 }), /no running subscription/);
    s.startSubscription({ orgId: org, planId: "free", now: T0 });
    fails(() => s.changePlan({ orgId: org, planId: "enterprise", now: T0 }), /arranged individually/);
    fails(() => s.changePlan({ orgId: org, planId: "ghost", now: T0 }), /does not exist/);
  });
});

// =================================================================================================
describe("6. cancelling, renewing and lapsing", () => {
  const paidPro = async (start = T0) => {
    const { s } = await mods();
    const org = await newOrg();
    const started = s.startSubscription({ orgId: org, planId: "pro", now: start });
    s.markInvoicePaid({ invoiceId: started.invoice!.id, providerRef: `UPI-${org.slice(-6)}`, now: start });
    return org;
  };
  const END = Date.UTC(2026, 1, 15, 10, 0, 0); // the end of a Pro period started at T0

  it("cancelling keeps access to the end of the period, then the organization is on Free", async () => {
    const { s, c } = await mods();
    const org = await paidPro();
    assert.equal(s.cancelSubscription({ orgId: org, now: T0 + DAY }).cancelAtPeriodEnd, true);
    s.processSubscriptions({ now: END - DAY });
    assert.equal(s.getBilling(org).running!.planId, "pro", "still Pro the day before the period ends");
    assert.ok(s.processSubscriptions({ now: END + 1000 }).cancelled >= 1);
    const b = s.getBilling(org);
    assert.deepEqual([b.running!.planId, b.running!.status], ["free", "active"]);
    assert.equal(c.getWallet(org).balanceUnits, 400_000 + 10_000, "the unused Pro credits are kept");
  });
  it("the Free plan cannot be cancelled; cancelling can be undone", async () => {
    const { s } = await mods();
    const free = await newOrg();
    s.startSubscription({ orgId: free, planId: "free", now: T0 });
    fails(() => s.cancelSubscription({ orgId: free, now: T0 }), /nothing to cancel/);
    const nobody = await newOrg();
    fails(() => s.cancelSubscription({ orgId: nobody, now: T0 }), /no running subscription/);
    const org = await paidPro();
    s.cancelSubscription({ orgId: org, now: T0 + DAY });
    assert.equal(s.keepSubscription({ orgId: org, now: T0 + 2 * DAY }).cancelAtPeriodEnd, false);
    s.processSubscriptions({ now: END + 1000 });
    assert.equal(s.getBilling(org).running!.status, "past_due", "no longer cancelled, so it now waits for the renewal payment");
  });
  it("a renewal invoice is raised a week ahead, once; paying it extends the period and grants credits again", async () => {
    const { s, c } = await mods();
    const org = await paidPro();
    s.processSubscriptions({ now: END - 10 * DAY });
    assert.equal(s.getBilling(org).openInvoices.length, 0, "too early for a renewal invoice");
    s.processSubscriptions({ now: END - 5 * DAY });
    s.processSubscriptions({ now: END - 4 * DAY });
    const open = s.getBilling(org).openInvoices;
    assert.equal(open.length, 1, "raised once, not twice");
    assert.deepEqual([open[0].periodStart, open[0].periodEnd, open[0].subtotalPaise], [at(END), "2026-03-15T10:00:00.000Z", 149_900]);
    const paid = s.markInvoicePaid({ invoiceId: open[0].id, providerRef: "UPI-RENEW1", now: END - 3 * DAY });
    assert.deepEqual([paid.subscription.currentPeriodStart, paid.subscription.currentPeriodEnd, paid.subscription.status], [at(END), "2026-03-15T10:00:00.000Z", "active"]);
    assert.equal(c.getWallet(org).balanceUnits, 800_000, "a second allowance, once");
    s.processSubscriptions({ now: END + DAY });
    assert.equal(s.getBilling(org).running!.status, "active", "paid in advance, so nothing is due");
  });
  it("unpaid at the end: past_due; after the grace days it lapses to Free and the open invoice is cancelled", async () => {
    const { s } = await mods();
    const org = await paidPro();
    s.processSubscriptions({ now: END + 1000 });
    let b = s.getBilling(org);
    assert.deepEqual([b.running!.planId, b.running!.status], ["pro", "past_due"]);
    assert.equal(b.openInvoices.length, 1);
    s.processSubscriptions({ now: END + 3 * DAY });
    assert.equal(s.getBilling(org).running!.planId, "pro", "still inside the grace period");
    s.processSubscriptions({ now: END + 8 * DAY });
    b = s.getBilling(org);
    assert.deepEqual([b.running!.planId, b.running!.status, b.openInvoices.length], ["free", "active", 0]);
  });
  it("paying while past_due brings it back to active", async () => {
    const { s } = await mods();
    const org = await paidPro();
    s.processSubscriptions({ now: END + 1000 });
    const inv = s.getBilling(org).openInvoices[0];
    const paid = s.markInvoicePaid({ invoiceId: inv.id, providerRef: "UPI-LATE01", now: END + 2 * DAY });
    assert.deepEqual([paid.subscription.status, paid.subscription.currentPeriodStart], ["active", at(END + 2 * DAY)]);
  });
  it("a scheduled downgrade starts at the period end: Free meanwhile, the lower plan once its invoice is paid", async () => {
    const { s, c } = await mods();
    const org = await paidPro();
    s.changePlan({ orgId: org, planId: "starter", now: T0 + DAY });
    s.processSubscriptions({ now: END + 1000 });
    const b = s.getBilling(org);
    assert.deepEqual([b.running!.planId, b.pending!.planId, b.openInvoices[0].subtotalPaise], ["free", "starter", 49_900]);
    s.markInvoicePaid({ invoiceId: b.openInvoices[0].id, providerRef: "UPI-LOW001", now: END + DAY });
    assert.equal(s.getBilling(org).running!.planId, "starter");
    assert.equal(c.getWallet(org).balanceUnits, 400_000 + 10_000 + 100_000);
  });
  it("Free renews itself each month with a fresh allowance, and running it twice at the same moment adds nothing more", async () => {
    const { s, c } = await mods();
    const org = await newOrg();
    s.startSubscription({ orgId: org, planId: "free", now: T0 });
    const first = Date.UTC(2026, 1, 15, 10, 0, 1);
    s.processSubscriptions({ now: first });
    assert.equal(c.getWallet(org).balanceUnits, 20_000);
    s.processSubscriptions({ now: first });
    assert.equal(c.getWallet(org).balanceUnits, 20_000, "the second run did nothing");
  });
  it("every wallet still equals its ledger after all of this", async () => {
    const { c } = await mods();
    assert.deepEqual(c.auditWallets(), []);
  });
});
