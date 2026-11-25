import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { getDb, transaction } from "@/lib/business/db";
import { CURRENCY_CODES, isCurrency } from "@/lib/currencies";
import { ValidationError } from "@/lib/business/validate";
import { discountFor, noteCouponUsedIn, redeemCouponIn, releaseRedemptionIn } from "./coupons";
import { addCreditsIn, getWallet, type Wallet } from "./credits";

/**
 * Plans, subscriptions and invoices (server only).
 *
 * Money is whole units of the smallest part of a currency (paise, cents, pence). Plans are rows in the `plans` table and their prices are rows in
 * `plan_prices`, one per plan, currency and period: prices and credit allowances are edited there, never in code.
 *
 * A subscription LOCKS the price (and the credit allowance) it was sold at. Changing a plan afterwards affects only people who subscribe after the change:
 * nobody is billed a different amount, or given a different allowance, at a renewal just because the list price moved.
 *
 * No payment provider is connected. A paid plan waits in "pending_payment" with an open invoice, and credits arrive only
 * when `markInvoicePaid` records that the money was received (by an administrator today, by a provider webhook later).
 *
 * Life of a subscription:
 *   Free ........ active at once, grants its credits.
 *   Paid ........ pending_payment + open invoice  --markInvoicePaid-->  active + credits.
 *   Trial ....... a paid plan with trial days starts active at once with its trial credits and no invoice; the first invoice is raised before the trial
 *                 ends, and unpaid at the end it is past_due, then back to Free after the grace days. An organization has one trial.
 *   Upgrade ..... a new pending subscription; the old one keeps running until the new invoice is paid, then it ends.
 *   Downgrade ... scheduled (pending_plan_id) for the end of the current period.
 *   Cancel ...... keeps access until the period ends, then the organization drops to Free.
 *   Renewal ..... an open invoice is raised before the period ends; unpaid at the end = past_due; past grace = back to Free.
 * `processSubscriptions` moves things along. It is safe to run any number of times. Nothing calls it on a timer yet.
 */

export const GRACE_DAYS = 7;
const RENEWAL_NOTICE_DAYS = 7;
const DAY_MS = 86_400_000;

export type Period = "monthly" | "annual";
export type PlanPrice = { currency: string; period: Period; amountMinor: number };
export type Plan = {
  id: string; name: string; description: string;
  monthlyPricePaise: number | null; annualPricePaise: number | null; monthlyPriceUsdCents: number | null; annualPriceUsdCents: number | null; monthlyPriceGbpPence: number | null; annualPriceGbpPence: number | null;
  /** Every price this plan is sold at, in every currency (the three fields pairs above are the rupee, dollar and pound ones). */
  prices: PlanPrice[];
  monthlyCreditUnits: number; maxActiveProjects: number | null; isCustom: boolean; active: boolean; sortOrder: number;
  /** Days of free use before the first payment, or null for no trial; and the credits a trial receives. */
  trialDays: number | null; trialCreditUnits: number;
  /** Plans that are sizes of one plan share a family; the headline size has id = family. */
  family: string | null;
};
export type Subscription = { id: string; orgId: string; planId: string; pendingPlanId: string | null; status: "pending_payment" | "active" | "past_due" | "ended"; billingPeriod: Period; currentPeriodStart: string | null; currentPeriodEnd: string | null; cancelAtPeriodEnd: boolean; createdAt: string; currency: string; unitAmountMinor: number | null; allowanceMonthlyUnits: number | null; trialEndsAt: string | null };
/**
 * Amounts named "...Paise" are whole units of the invoice's `currency` smallest part (paise, cents, pence); the names are older than the other currencies.
 * subtotalPaise is the amount TAX is charged on: the list price less any coupon discount. The list price is listPriceMinor = subtotal + discount.
 * The database insists that total = subtotal + tax.
 */
export type Invoice = { id: string; number: string; orgId: string; subscriptionId: string; planId: string; periodStart: string; periodEnd: string; currency: string; listPriceMinor: number; subtotalPaise: number; discountMinor: number; couponCode: string | null; gstBasisPoints: number; gstPaise: number; totalPaise: number; status: "open" | "paid" | "void"; provider: string; providerRef: string | null; issuedAt: string; paidAt: string | null };

type PlanRow = { id: string; name: string; description: string; monthly_price_paise: number | null; annual_price_paise: number | null; monthly_price_usd_cents: number | null; annual_price_usd_cents: number | null; monthly_price_gbp_pence: number | null; annual_price_gbp_pence: number | null; monthly_credit_units: number; max_active_projects: number | null; is_custom: number; active: number; sort_order: number; family: string | null; trial_days: number | null; trial_credit_units: number };
type SubRow = { id: string; org_id: string; plan_id: string; pending_plan_id: string | null; status: Subscription["status"]; billing_period: Period; current_period_start: string | null; current_period_end: string | null; cancel_at_period_end: number; created_at: string; currency: string; unit_amount_minor: number | null; allowance_monthly_units: number | null; trial_ends_at: string | null; coupon_redemption_id: string | null };
type InvoiceRow = { id: string; number: string; org_id: string; subscription_id: string; plan_id: string; period_start: string; period_end: string; currency: string; subtotal_paise: number; discount_minor: number; coupon_code: string | null; gst_basis_points: number; gst_paise: number; total_paise: number; status: Invoice["status"]; provider: string; provider_ref: string | null; issued_at: string; paid_at: string | null };
type PriceRow = { plan_id: string; currency: string; period: Period; amount_minor: number };

const toPlan = (r: PlanRow, prices: PriceRow[] = []): Plan => ({
  id: r.id, name: r.name, description: r.description,
  monthlyPricePaise: r.monthly_price_paise, annualPricePaise: r.annual_price_paise, monthlyPriceUsdCents: r.monthly_price_usd_cents, annualPriceUsdCents: r.annual_price_usd_cents, monthlyPriceGbpPence: r.monthly_price_gbp_pence, annualPriceGbpPence: r.annual_price_gbp_pence,
  prices: prices.filter((p) => p.plan_id === r.id).map((p) => ({ currency: p.currency, period: p.period, amountMinor: p.amount_minor })),
  monthlyCreditUnits: r.monthly_credit_units, maxActiveProjects: r.max_active_projects, isCustom: r.is_custom === 1, active: r.active === 1, sortOrder: r.sort_order, trialDays: r.trial_days, trialCreditUnits: r.trial_credit_units, family: r.family,
});
const toSub = (r: SubRow): Subscription => ({ id: r.id, orgId: r.org_id, planId: r.plan_id, pendingPlanId: r.pending_plan_id, status: r.status, billingPeriod: r.billing_period, currentPeriodStart: r.current_period_start, currentPeriodEnd: r.current_period_end, cancelAtPeriodEnd: r.cancel_at_period_end === 1, createdAt: r.created_at, currency: r.currency, unitAmountMinor: r.unit_amount_minor, allowanceMonthlyUnits: r.allowance_monthly_units, trialEndsAt: r.trial_ends_at });
const toInvoice = (r: InvoiceRow): Invoice => ({ id: r.id, number: r.number, orgId: r.org_id, subscriptionId: r.subscription_id, planId: r.plan_id, periodStart: r.period_start, periodEnd: r.period_end, currency: r.currency, listPriceMinor: r.subtotal_paise + r.discount_minor, subtotalPaise: r.subtotal_paise, discountMinor: r.discount_minor, couponCode: r.coupon_code, gstBasisPoints: r.gst_basis_points, gstPaise: r.gst_paise, totalPaise: r.total_paise, status: r.status, provider: r.provider, providerRef: r.provider_ref, issuedAt: r.issued_at, paidAt: r.paid_at });

const bad = (message: string) => new ValidationError(message);

// ---- dates -----------------------------------------------------------------------------------------------------------
/** Adds calendar months in UTC, clamping the day (31 Jan + 1 month = 28/29 Feb), so a monthly period never skips a month. */
export function addMonths(iso: string, months: number): string {
  const d = new Date(iso);
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d.getUTCDate(), last));
  return target.toISOString();
}
const periodEnd = (start: string, period: Period) => addMonths(start, period === "annual" ? 12 : 1);
const iso = (ms: number) => new Date(ms).toISOString();

// ---- plans -----------------------------------------------------------------------------------------------------------
const allPrices = (db: DatabaseSync) => db.prepare("SELECT plan_id, currency, period, amount_minor FROM plan_prices WHERE active = 1 ORDER BY plan_id, currency, period").all() as PriceRow[];

export function listPlans(opts: { includeInactive?: boolean } = {}): Plan[] {
  const db = getDb();
  const rows = db.prepare(`SELECT * FROM plans ${opts.includeInactive ? "" : "WHERE active = 1"} ORDER BY sort_order, monthly_credit_units, id`).all() as PlanRow[];
  const prices = allPrices(db);
  return rows.map((r) => toPlan(r, prices));
}
export function getPlan(id: string): Plan | null {
  const db = getDb();
  const r = db.prepare("SELECT * FROM plans WHERE id = ?").get(id) as PlanRow | undefined;
  return r ? toPlan(r, allPrices(db)) : null;
}

/** The list price of a plan in a currency and period, or null when it is not sold that way. The Free plan is free in every currency. */
export function priceOf(db: DatabaseSync, planId: string, currency: string, period: Period): number | null {
  if (planId === "free") return 0;
  const row = db.prepare("SELECT amount_minor FROM plan_prices WHERE plan_id = ? AND currency = ? AND period = ? AND active = 1").get(planId, currency, period) as { amount_minor: number } | undefined;
  return row ? row.amount_minor : null;
}
function priceFor(db: DatabaseSync, plan: PlanRow, currency: string, period: Period): number {
  const price = priceOf(db, plan.id, currency, period);
  if (price === null) throw bad(`The ${plan.name} plan is not sold ${period === "annual" ? "yearly" : "monthly"} in ${currency}.`);
  return price;
}

const paise = (v: unknown, name: string): number | null => {
  if (v === null) return null;
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) throw bad(`${name} must be a whole number of paise (0 or more), or null.`);
  return v;
};

const cents = (v: unknown, name: string): number | null => {
  if (v === null) return null;
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) throw bad(`${name} must be a whole number of the currency's smallest unit (cents or pence, 0 or more), or null when the plan is not sold in that currency.`);
  return v;
};

/** The columns on `plans` that still mirror the rupee, dollar and pound prices (kept in step with plan_prices; nothing reads them for billing). */
const LEGACY_COLUMN: Record<string, string> = { "INR/monthly": "monthly_price_paise", "INR/annual": "annual_price_paise", "USD/monthly": "monthly_price_usd_cents", "USD/annual": "annual_price_usd_cents", "GBP/monthly": "monthly_price_gbp_pence", "GBP/annual": "annual_price_gbp_pence" };

function writePrice(db: DatabaseSync, planId: string, currency: string, period: Period, amount: number | null, at: string): void {
  if (amount === null) db.prepare("DELETE FROM plan_prices WHERE plan_id = ? AND currency = ? AND period = ?").run(planId, currency, period);
  else db.prepare("INSERT INTO plan_prices (id, plan_id, currency, period, amount_minor, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?) ON CONFLICT(plan_id, currency, period) DO UPDATE SET amount_minor = excluded.amount_minor, active = 1, updated_at = excluded.updated_at").run(`pp_${planId}_${currency}_${period}`, planId, currency, period, amount, at, at);
  const column = LEGACY_COLUMN[`${currency}/${period}`];
  if (column) db.prepare(`UPDATE plans SET ${column} = ?, updated_at = ? WHERE id = ?`).run(amount, at, planId);
}

/**
 * Sets, changes or removes (null) the price of a plan in one currency and period (admin). Affects only people who subscribe AFTER this:
 * existing subscriptions keep the price they were sold at.
 */
export function setPlanPrice(input: { planId: string; currency: string; period: string; amountMinor: number | null }): Plan {
  if (!getPlan(input.planId)) throw bad("That plan does not exist.");
  if (!isCurrency(input.currency)) throw bad(`currency must be one of: ${CURRENCY_CODES.join(", ")}.`);
  if (input.period !== "monthly" && input.period !== "annual") throw bad("period must be monthly or annual.");
  cents(input.amountMinor, "The price");
  if (input.planId === "free" && input.amountMinor !== null && input.amountMinor !== 0) throw bad("The Free plan is free.");
  const at = new Date().toISOString();
  transaction((db) => writePrice(db, input.planId, input.currency, input.period as Period, input.amountMinor, at));
  return getPlan(input.planId)!;
}

type PlanPatch = Partial<Pick<Plan, "name" | "description" | "monthlyPricePaise" | "annualPricePaise" | "monthlyPriceUsdCents" | "annualPriceUsdCents" | "monthlyPriceGbpPence" | "annualPriceGbpPence" | "monthlyCreditUnits" | "maxActiveProjects" | "active" | "sortOrder" | "trialDays" | "trialCreditUnits">>;

/** Edits a plan (admin). Only the fields given change; the id never does. Existing subscriptions and invoices are unaffected: they keep the price and allowance they were sold at. */
export function updatePlan(id: string, patch: PlanPatch): Plan {
  const current = getPlan(id);
  if (!current) throw bad("That plan does not exist.");
  const known = new Set(["name", "description", "monthlyPricePaise", "annualPricePaise", "monthlyPriceUsdCents", "annualPriceUsdCents", "monthlyPriceGbpPence", "annualPriceGbpPence", "monthlyCreditUnits", "maxActiveProjects", "active", "sortOrder", "trialDays", "trialCreditUnits"]);
  for (const k of Object.keys(patch)) if (!known.has(k)) throw bad(`Unknown plan field "${k}".`);
  const next = { ...current, ...patch };
  if (typeof next.name !== "string" || !next.name.trim() || next.name.length > 80) throw bad("The plan name is required (up to 80 characters).");
  if (typeof next.description !== "string" || next.description.length > 300) throw bad("The description must be text of up to 300 characters.");
  paise(next.monthlyPricePaise, "The monthly price");
  paise(next.annualPricePaise, "The annual price");
  cents(next.monthlyPriceUsdCents, "The monthly dollar price");
  cents(next.annualPriceUsdCents, "The annual dollar price");
  cents(next.monthlyPriceGbpPence, "The monthly pound price");
  cents(next.annualPriceGbpPence, "The annual pound price");
  if (!Number.isSafeInteger(next.monthlyCreditUnits) || next.monthlyCreditUnits < 0) throw bad("The monthly credits must be a whole number of units (0 or more).");
  if (next.maxActiveProjects !== null && (!Number.isSafeInteger(next.maxActiveProjects) || next.maxActiveProjects < 0)) throw bad("The project limit must be a whole number, or null for no limit.");
  if (typeof next.active !== "boolean") throw bad("active must be true or false.");
  if (!Number.isSafeInteger(next.sortOrder)) throw bad("sortOrder must be a whole number.");
  if (!next.isCustom && next.monthlyPricePaise === null) throw bad("A plan that is not custom needs a monthly price.");
  if (next.trialDays !== null && (!Number.isSafeInteger(next.trialDays) || next.trialDays < 1 || next.trialDays > 365)) throw bad("trialDays must be from 1 to 365, or null for no trial.");
  if (!Number.isSafeInteger(next.trialCreditUnits) || next.trialCreditUnits < 0) throw bad("trialCreditUnits must be a whole number of units (0 or more).");
  if (next.trialDays !== null && id === "free") throw bad("The Free plan has no trial: it is already free.");
  const at = new Date().toISOString();
  transaction((db) => {
    db.prepare("UPDATE plans SET name = ?, description = ?, monthly_credit_units = ?, max_active_projects = ?, active = ?, sort_order = ?, trial_days = ?, trial_credit_units = ?, updated_at = ? WHERE id = ?")
      .run(next.name.trim(), next.description, next.monthlyCreditUnits, next.maxActiveProjects, next.active ? 1 : 0, next.sortOrder, next.trialDays, next.trialCreditUnits, at, id);
    // The rupee, dollar and pound fields are stored as prices like any other currency.
    const prices: [string, Period, number | null][] = [["INR", "monthly", next.monthlyPricePaise], ["INR", "annual", next.annualPricePaise], ["USD", "monthly", next.monthlyPriceUsdCents], ["USD", "annual", next.annualPriceUsdCents], ["GBP", "monthly", next.monthlyPriceGbpPence], ["GBP", "annual", next.annualPriceGbpPence]];
    for (const [currency, period, amount] of prices) writePrice(db, id, currency, period, amount, at);
  });
  return getPlan(id)!;
}

// ---- reading subscriptions and invoices -------------------------------------------------------------------------------
const running = (db: DatabaseSync, orgId: string) => db.prepare("SELECT * FROM subscriptions WHERE org_id = ? AND status IN ('active', 'past_due')").get(orgId) as SubRow | undefined;
const pending = (db: DatabaseSync, orgId: string) => db.prepare("SELECT * FROM subscriptions WHERE org_id = ? AND status = 'pending_payment'").get(orgId) as SubRow | undefined;
const planRow = (db: DatabaseSync, id: string): PlanRow => {
  const p = db.prepare("SELECT * FROM plans WHERE id = ?").get(id) as PlanRow | undefined;
  if (!p) throw bad("That plan does not exist.");
  return p;
};
const planOf = (db: DatabaseSync, id: string): Plan => toPlan(planRow(db, id), allPrices(db));

export function listInvoices(orgId: string): Invoice[] {
  return (getDb().prepare("SELECT * FROM subscription_invoices WHERE org_id = ? ORDER BY issued_at DESC, number DESC").all(orgId) as InvoiceRow[]).map(toInvoice);
}
export function getInvoice(id: string): Invoice | null {
  const r = getDb().prepare("SELECT * FROM subscription_invoices WHERE id = ?").get(id) as InvoiceRow | undefined;
  return r ? toInvoice(r) : null;
}

export type Billing = { running: Subscription | null; plan: Plan | null; scheduledPlan: Plan | null; pending: Subscription | null; pendingPlan: Plan | null; openInvoices: Invoice[]; wallet: Wallet };
/** Everything the billing screen needs for one organization. */
export function getBilling(orgId: string): Billing {
  const db = getDb();
  const r = running(db, orgId);
  const p = pending(db, orgId);
  return {
    running: r ? toSub(r) : null,
    plan: r ? planOf(db, r.plan_id) : null,
    scheduledPlan: r?.pending_plan_id ? planOf(db, r.pending_plan_id) : null,
    pending: p ? toSub(p) : null,
    pendingPlan: p ? planOf(db, p.plan_id) : null,
    openInvoices: listInvoices(orgId).filter((i) => i.status === "open"),
    wallet: getWallet(orgId),
  };
}

// ---- GST on subscription invoices ----------------------------------------------------------------------------------------
/** The GST rate on SaaS invoices, in basis points (1800 = 18%). Its own setting: the agency's quotation rate is separate books. Charged on rupee invoices only. */
export function gstBasisPoints(db: DatabaseSync = getDb()): number {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'saas_gst_basis_points'").get() as { value: string } | undefined;
  const n = row ? Number(row.value) : 1800;
  return Number.isInteger(n) && n >= 0 && n <= 10_000 ? n : 1800;
}

// ---- inside a transaction ----------------------------------------------------------------------------------------------
function nextInvoiceNumber(db: DatabaseSync, at: string): string {
  const year = at.slice(0, 4);
  const row = db.prepare("SELECT MAX(CAST(SUBSTR(number, 10) AS INTEGER)) AS n FROM subscription_invoices WHERE number LIKE ?").get(`INV-${year}-%`) as { n: number | null };
  return `INV-${year}-${String((row.n ?? 0) + 1).padStart(5, "0")}`;
}

/**
 * One invoice per subscription per period (a second request returns the first). The amount is the price the subscription LOCKED when it was sold, less any
 * coupon discount; tax (GST) is charged on rupee invoices only, on the discounted amount.
 */
function raiseInvoice(db: DatabaseSync, sub: SubRow, plan: PlanRow, period: Period, start: string, end: string, at: string): InvoiceRow {
  const existing = db.prepare("SELECT * FROM subscription_invoices WHERE subscription_id = ? AND period_start = ?").get(sub.id, start) as InvoiceRow | undefined;
  if (existing) return existing;
  const subtotal = sub.unit_amount_minor ?? priceFor(db, plan, sub.currency, period);
  const coupon = discountFor(db, sub, subtotal);
  const discount = coupon?.discountMinor ?? 0;
  const taxable = subtotal - discount;
  const bp = sub.currency === "INR" ? gstBasisPoints(db) : 0;
  const gst = Math.round((taxable * bp) / 10_000);
  const id = `inv_${randomUUID()}`;
  db.prepare(
    `INSERT INTO subscription_invoices (id, number, org_id, subscription_id, plan_id, period_start, period_end, currency, subtotal_paise, discount_minor, coupon_code, gst_basis_points, gst_paise, total_paise, status, provider, issued_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', 'manual', ?)`,
  ).run(id, nextInvoiceNumber(db, at), sub.org_id, sub.id, plan.id, start, end, sub.currency, taxable, discount, coupon?.code ?? null, bp, gst, taxable + gst, at);
  if (coupon) noteCouponUsedIn(db, coupon.redemptionId);
  return db.prepare("SELECT * FROM subscription_invoices WHERE id = ?").get(id) as InvoiceRow;
}

const monthsOf = (period: Period) => (period === "annual" ? 12 : 1);

function grantAllowance(db: DatabaseSync, sub: SubRow, plan: PlanRow, period: Period, periodStart: string): void {
  const monthly = sub.allowance_monthly_units ?? plan.monthly_credit_units; // the allowance it was sold with, not today's
  const units = monthly * monthsOf(period); // an annual plan receives its twelve months at once
  if (units > 0) addCreditsIn(db, { orgId: sub.org_id, units, kind: "grant", category: "subscription", idempotencyKey: `plan:${sub.id}:${periodStart}`, reference: `plan:${plan.id}`, note: `${plan.name} plan, ${period}`, createdBy: "system" });
}

function insertSub(db: DatabaseSync, orgId: string, plan: PlanRow, status: SubRow["status"], period: Period, start: string | null, end: string | null, at: string, lock: { currency: string; unit: number; trialEndsAt?: string | null }): SubRow {
  const id = `sub_${randomUUID()}`;
  db.prepare("INSERT INTO subscriptions (id, org_id, plan_id, status, billing_period, current_period_start, current_period_end, cancel_at_period_end, created_at, updated_at, currency, unit_amount_minor, allowance_monthly_units, trial_ends_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)")
    .run(id, orgId, plan.id, status, period, start, end, at, at, lock.currency, lock.unit, plan.monthly_credit_units, lock.trialEndsAt ?? null);
  return db.prepare("SELECT * FROM subscriptions WHERE id = ?").get(id) as SubRow;
}

/** An active Free subscription for an organization that has none running, with its credits. */
function startFreeIn(db: DatabaseSync, orgId: string, at: string, currency = "INR"): SubRow {
  const free = planRow(db, "free");
  const sub = insertSub(db, orgId, free, "active", "monthly", at, addMonths(at, 1), at, { currency, unit: 0 });
  grantAllowance(db, sub, free, "monthly", at);
  return sub;
}

/** An organization may have one free trial, ever. */
const trialAvailable = (db: DatabaseSync, orgId: string) => !db.prepare("SELECT 1 FROM subscriptions WHERE org_id = ? AND trial_ends_at IS NOT NULL").get(orgId);

function begin(db: DatabaseSync, orgId: string, planId: string, period: Period, currency: string, at: string, opts: { couponCode?: string } = {}): { sub: SubRow; invoice: InvoiceRow | null } {
  const plan = planRow(db, planId);
  if (!plan.active) throw bad("That plan is not available.");
  if (plan.is_custom) throw bad("That plan is arranged individually. Contact SILPI.");
  if (period !== "monthly" && period !== "annual") throw bad("The billing period must be monthly or annual.");
  if (!isCurrency(currency)) throw bad(`currency must be one of: ${CURRENCY_CODES.join(", ")}.`);
  const price = priceFor(db, plan, currency, period);
  const coupon = typeof opts.couponCode === "string" && opts.couponCode.trim() ? opts.couponCode.trim() : null;
  if (price === 0) {
    if (coupon) throw bad("A coupon applies to a paid plan.");
    const sub = insertSub(db, orgId, plan, "active", period, at, periodEnd(at, period), at, { currency, unit: 0 });
    grantAllowance(db, sub, plan, period, at);
    return { sub, invoice: null };
  }
  // A paid plan with trial days, for an organization that has not had a trial: active at once with the trial credits and no invoice yet.
  if (plan.trial_days && trialAvailable(db, orgId)) {
    const end = new Date(Date.parse(at) + plan.trial_days * DAY_MS).toISOString();
    const sub = insertSub(db, orgId, plan, "active", period, at, end, at, { currency, unit: price, trialEndsAt: end });
    if (coupon) redeemCouponIn(db, { code: coupon, orgId, subscriptionId: sub.id, planId, currency, at });
    if (plan.trial_credit_units > 0) addCreditsIn(db, { orgId, units: plan.trial_credit_units, kind: "grant", category: "subscription", idempotencyKey: `trial:${sub.id}`, reference: `trial:${plan.id}`, note: `${plan.name} free trial`, createdBy: "system" });
    return { sub: db.prepare("SELECT * FROM subscriptions WHERE id = ?").get(sub.id) as SubRow, invoice: null };
  }
  const sub = insertSub(db, orgId, plan, "pending_payment", period, null, null, at, { currency, unit: price });
  if (coupon) redeemCouponIn(db, { code: coupon, orgId, subscriptionId: sub.id, planId, currency, at });
  return { sub: db.prepare("SELECT * FROM subscriptions WHERE id = ?").get(sub.id) as SubRow, invoice: raiseInvoice(db, db.prepare("SELECT * FROM subscriptions WHERE id = ?").get(sub.id) as SubRow, plan, period, at, periodEnd(at, period), at) };
}

function requireCustomerOrg(db: DatabaseSync, orgId: string): void {
  const org = db.prepare("SELECT type, status FROM organizations WHERE id = ?").get(orgId) as { type: string; status: string } | undefined;
  if (!org) throw bad("That organization does not exist.");
  if (org.type === "internal") throw bad("The agency does not subscribe: it keeps its own books.");
  if (org.status !== "active") throw bad("That organization is suspended.");
}

// ---- public operations -------------------------------------------------------------------------------------------------
export type Started = { subscription: Subscription; invoice: Invoice | null };

/**
 * The first subscription of an organization. Free starts at once; a paid plan waits for its invoice to be paid (or starts a free trial, if the plan has one).
 * `currency` is what the customer will be billed in (default INR); `couponCode` is optional.
 */
export function startSubscription(input: { orgId: string; planId: string; period?: Period; currency?: string; couponCode?: string; now?: number }): Started {
  const at = iso(input.now ?? Date.now());
  return transaction((db) => {
    requireCustomerOrg(db, input.orgId);
    if (running(db, input.orgId) || pending(db, input.orgId)) throw bad("This organization already has a subscription. Change its plan instead.");
    const { sub, invoice } = begin(db, input.orgId, input.planId, input.period ?? "monthly", input.currency ?? "INR", at, { couponCode: input.couponCode });
    return { subscription: toSub(sub), invoice: invoice ? toInvoice(invoice) : null };
  });
}

export type Change = { kind: "upgrade" | "scheduled"; subscription: Subscription; invoice: Invoice | null; effectiveAt: string | null };

/**
 * Moves an organization to another plan, in the currency it is already billed in. An organization still on Free has paid nothing yet, so it may choose
 * its billing currency now; once it pays in one currency it stays in it.
 * Upgrade (more expensive, or monthly to annual of the same plan): a new subscription waits for payment; the current one
 * keeps running until then. Anything else is scheduled for the end of the current period.
 */
export function changePlan(input: { orgId: string; planId: string; period?: Period; currency?: string; couponCode?: string; now?: number }): Change {
  const at = iso(input.now ?? Date.now());
  return transaction((db) => {
    requireCustomerOrg(db, input.orgId);
    const cur = running(db, input.orgId);
    if (!cur) throw bad("This organization has no running subscription. Start one first.");
    const target = planRow(db, input.planId);
    const period: Period = input.period ?? cur.billing_period;
    if (!target.active) throw bad("That plan is not available.");
    if (target.is_custom) throw bad("That plan is arranged individually. Contact SILPI.");
    if (period !== "monthly" && period !== "annual") throw bad("The billing period must be monthly or annual.");
    const currency = input.currency ?? cur.currency;
    if (!isCurrency(currency)) throw bad(`currency must be one of: ${CURRENCY_CODES.join(", ")}.`);
    if (currency !== cur.currency && (cur.unit_amount_minor ?? 0) > 0) throw bad(`This organization is billed in ${cur.currency}. To bill in ${currency}, cancel and subscribe again when the period ends.`);
    const sameIsh = target.id === cur.plan_id;
    if (sameIsh && period === cur.billing_period) throw bad("That is already the current plan.");
    if (sameIsh && cur.billing_period === "annual") throw bad("Switching from annual back to monthly is not supported yet. Cancel at the end of the period instead.");
    // Comparing like with like: both prices in the currency the customer pays in. A plan retired from sale falls back to what the customer pays now.
    const targetMonthly = priceOf(db, target.id, currency, "monthly");
    if (targetMonthly === null) throw bad(`The ${target.name} plan is not sold in ${currency}.`);
    const paidMonthly = priceOf(db, cur.plan_id, currency, "monthly") ?? Math.round((cur.unit_amount_minor ?? 0) / monthsOf(cur.billing_period));
    const dearer = sameIsh ? true : targetMonthly > paidMonthly;
    if (dearer) {
      const waiting = pending(db, input.orgId);
      if (waiting) {
        // A newer choice replaces an unpaid one: the old request and its invoices are cancelled, and its coupon is given back.
        db.prepare("UPDATE subscription_invoices SET status = 'void' WHERE subscription_id = ? AND status = 'open'").run(waiting.id);
        releaseRedemptionIn(db, waiting.id);
        db.prepare("UPDATE subscriptions SET status = 'ended', updated_at = ? WHERE id = ?").run(at, waiting.id);
      }
      const { sub, invoice } = begin(db, input.orgId, target.id, period, currency, at, { couponCode: input.couponCode });
      return { kind: "upgrade" as const, subscription: toSub(sub), invoice: invoice ? toInvoice(invoice) : null, effectiveAt: null };
    }
    if (input.couponCode) throw bad("A coupon applies when you move to a dearer plan or start one, not to a scheduled downgrade.");
    db.prepare("UPDATE subscriptions SET pending_plan_id = ?, cancel_at_period_end = 0, updated_at = ? WHERE id = ?").run(target.id, at, cur.id);
    return { kind: "scheduled" as const, subscription: toSub(db.prepare("SELECT * FROM subscriptions WHERE id = ?").get(cur.id) as SubRow), invoice: null, effectiveAt: cur.current_period_end };
  });
}

/** Stops renewal. Access continues to the end of the paid period, then the organization is on Free. */
export function cancelSubscription(input: { orgId: string; now?: number }): Subscription {
  const at = iso(input.now ?? Date.now());
  return transaction((db) => {
    const cur = running(db, input.orgId);
    if (!cur) throw bad("This organization has no running subscription.");
    if (cur.plan_id === "free") throw bad("The Free plan has nothing to cancel.");
    db.prepare("UPDATE subscriptions SET cancel_at_period_end = 1, pending_plan_id = NULL, updated_at = ? WHERE id = ?").run(at, cur.id);
    return toSub(db.prepare("SELECT * FROM subscriptions WHERE id = ?").get(cur.id) as SubRow);
  });
}

/** Undoes a cancellation or a scheduled downgrade before the period ends. */
export function keepSubscription(input: { orgId: string; now?: number }): Subscription {
  const at = iso(input.now ?? Date.now());
  return transaction((db) => {
    const cur = running(db, input.orgId);
    if (!cur) throw bad("This organization has no running subscription.");
    db.prepare("UPDATE subscriptions SET cancel_at_period_end = 0, pending_plan_id = NULL, updated_at = ? WHERE id = ?").run(at, cur.id);
    return toSub(db.prepare("SELECT * FROM subscriptions WHERE id = ?").get(cur.id) as SubRow);
  });
}

/**
 * Records that an invoice was paid. The invoice, the subscription and the credits change together or not at all.
 * A first payment activates the subscription (ending the one it replaces); a renewal payment extends the period.
 * Repeating it with the same reference changes nothing; a different reference is refused.
 */
export function markInvoicePaid(input: { invoiceId: string; providerRef: string; now?: number }): { invoice: Invoice; subscription: Subscription } {
  const ref = typeof input.providerRef === "string" ? input.providerRef.trim() : "";
  if (ref.length < 3 || ref.length > 200) throw bad("A payment reference of 3 to 200 characters is required.");
  const at = iso(input.now ?? Date.now());
  return transaction((db) => {
    const inv = db.prepare("SELECT * FROM subscription_invoices WHERE id = ?").get(input.invoiceId) as InvoiceRow | undefined;
    if (!inv) throw bad("That invoice does not exist.");
    const sub = db.prepare("SELECT * FROM subscriptions WHERE id = ?").get(inv.subscription_id) as SubRow;
    if (inv.status === "paid") {
      if (inv.provider_ref === ref) return { invoice: toInvoice(inv), subscription: toSub(sub) };
      throw bad("That invoice was already paid with a different reference.");
    }
    if (inv.status === "void") throw bad("That invoice was cancelled.");
    if (sub.status === "ended") throw bad("That subscription has ended.");
    const plan = planRow(db, inv.plan_id);
    const period = sub.billing_period;
    let start: string;
    if (sub.status === "pending_payment") {
      const old = running(db, sub.org_id);
      if (old) db.prepare("UPDATE subscriptions SET status = 'ended', updated_at = ? WHERE id = ?").run(at, old.id); // the plan it replaces
      start = at;
    } else {
      start = sub.current_period_end && sub.current_period_end > at ? sub.current_period_end : at; // renewal: continue from the old end, or from now if it already lapsed
    }
    const end = periodEnd(start, period);
    db.prepare("UPDATE subscription_invoices SET status = 'paid', provider_ref = ?, paid_at = ?, period_start = ?, period_end = ? WHERE id = ?").run(ref, at, start, end, inv.id);
    db.prepare("UPDATE subscriptions SET status = 'active', current_period_start = ?, current_period_end = ?, updated_at = ? WHERE id = ?").run(start, end, at, sub.id);
    grantAllowance(db, sub, plan, period, start);
    return { invoice: toInvoice(db.prepare("SELECT * FROM subscription_invoices WHERE id = ?").get(inv.id) as InvoiceRow), subscription: toSub(db.prepare("SELECT * FROM subscriptions WHERE id = ?").get(sub.id) as SubRow) };
  });
}

export type Processed = { renewed: number; renewalInvoices: number; pastDue: number; downgraded: number; cancelled: number; lapsedToFree: number };

/**
 * Moves every subscription along as of `now`. Idempotent: running it again at the same moment does nothing more.
 * Raises renewal invoices a week ahead; at the end of a period applies a cancellation or scheduled downgrade, renews Free,
 * or marks an unpaid paid plan past_due; after the grace days an unpaid plan lapses to Free. A trial is handled the same way:
 * its first invoice is raised a week before it ends.
 */
export function processSubscriptions(input: { now?: number } = {}): Processed {
  const nowMs = input.now ?? Date.now();
  const at = iso(nowMs);
  const out: Processed = { renewed: 0, renewalInvoices: 0, pastDue: 0, downgraded: 0, cancelled: 0, lapsedToFree: 0 };
  const orgIds = (getDb().prepare("SELECT org_id FROM subscriptions WHERE status IN ('active', 'past_due')").all() as { org_id: string }[]).map((r) => r.org_id);
  for (const orgId of orgIds) {
    transaction((db) => {
      const sub = running(db, orgId);
      if (!sub || !sub.current_period_end) return;
      const plan = planRow(db, sub.plan_id);
      const end = sub.current_period_end;
      const free = plan.id === "free" || sub.unit_amount_minor === 0;
      const ended = end <= at;

      if (!ended) {
        const soon = Date.parse(end) - nowMs <= RENEWAL_NOTICE_DAYS * DAY_MS;
        if (!free && soon && !sub.cancel_at_period_end && !sub.pending_plan_id) {
          const before = db.prepare("SELECT COUNT(*) AS n FROM subscription_invoices WHERE subscription_id = ?").get(sub.id) as { n: number };
          raiseInvoice(db, sub, plan, sub.billing_period, end, periodEnd(end, sub.billing_period), at);
          const after = db.prepare("SELECT COUNT(*) AS n FROM subscription_invoices WHERE subscription_id = ?").get(sub.id) as { n: number };
          out.renewalInvoices += after.n - before.n;
        }
        return;
      }

      const finish = (status: SubRow["status"]) => db.prepare("UPDATE subscriptions SET status = ?, updated_at = ? WHERE id = ?").run(status, at, sub.id);
      const voidOpen = () => db.prepare("UPDATE subscription_invoices SET status = 'void' WHERE subscription_id = ? AND status = 'open'").run(sub.id);

      if (sub.status === "past_due") {
        if (nowMs - Date.parse(end) > GRACE_DAYS * DAY_MS) {
          voidOpen();
          finish("ended");
          startFreeIn(db, orgId, at, sub.currency);
          out.lapsedToFree += 1;
        }
        return;
      }
      if (sub.cancel_at_period_end) {
        voidOpen();
        finish("ended");
        startFreeIn(db, orgId, at, sub.currency);
        out.cancelled += 1;
        return;
      }
      if (sub.pending_plan_id) {
        voidOpen();
        finish("ended");
        const target = planRow(db, sub.pending_plan_id);
        const targetPrice = target.is_custom || !target.active ? null : priceOf(db, target.id, sub.currency, "monthly");
        if (targetPrice === null) startFreeIn(db, orgId, at, sub.currency);
        else if (targetPrice === 0) begin(db, orgId, target.id, "monthly", sub.currency, at);
        else { startFreeIn(db, orgId, at, sub.currency); begin(db, orgId, target.id, "monthly", sub.currency, at); } // Free meanwhile; the lower plan starts when its invoice is paid
        out.downgraded += 1;
        return;
      }
      if (free) {
        const start = at; // Free renews on its own, one allowance per renewal
        db.prepare("UPDATE subscriptions SET current_period_start = ?, current_period_end = ?, updated_at = ? WHERE id = ?").run(start, periodEnd(start, sub.billing_period), at, sub.id);
        grantAllowance(db, sub, plan, sub.billing_period, start);
        out.renewed += 1;
        return;
      }
      raiseInvoice(db, sub, plan, sub.billing_period, end, periodEnd(end, sub.billing_period), at);
      finish("past_due");
      out.pastDue += 1;
    });
  }
  return out;
}
