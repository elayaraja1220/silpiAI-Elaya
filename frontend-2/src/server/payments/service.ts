import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { getDb, transaction } from "@/lib/business/db";
import { CURRENCY_CODES, isCurrency } from "@/lib/currencies";
import { ValidationError } from "@/lib/business/validate";
import { recordAuditIn } from "../audit";
import { addCreditsIn, bucketOfGrant, clawbackIn } from "../credits";
import { gstBasisPoints, markInvoicePaidIn } from "../subscriptions";
import { getPaymentProvider, WebhookError, type PaymentEvent, type PaymentTarget } from "./provider";

/**
 * Payments (server only): recording that money arrived, for a subscription invoice or a credit top-up, whoever took it; refunds; and the provider's notices.
 *
 * Rules this module keeps:
 *  - Nothing is paid, and no credits arrive, on the strength of a browser redirect. Only a verified provider notice (parseWebhook) or the administrator's
 *    own record (recordManualPayment) can pay anything.
 *  - The amount and currency of a payment must match what was asked for. A payment that does not match is recorded as a failure and applies nothing.
 *  - The same payment, or the same provider notice, applied twice changes nothing the second time.
 *  - A payment, the invoice or top-up it pays, and the credits it grants commit together or not at all.
 *  - A refund takes back the credits that payment bought, as far as they are still unspent, and says how many could not be recovered.
 */

/** A refusal for a business reason (wrong amount, already paid, void invoice). A webhook records it as a failed notice instead of retrying forever. */
export class PaymentProblem extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaymentProblem";
  }
}

const bad = (m: string) => new ValidationError(m);
const nowIso = () => new Date().toISOString();

// ---- shapes ----------------------------------------------------------------------------------------------------------------
export type PaymentStatus = "pending" | "succeeded" | "failed" | "refunded" | "partially_refunded" | "disputed";
export type Payment = { id: string; orgId: string; provider: string; providerPaymentId: string | null; purpose: "subscription_invoice" | "topup"; invoiceId: string | null; topupId: string | null; currency: string; amountMinor: number; status: PaymentStatus; failureReason: string | null; refundedMinor: number; createdAt: string; paidAt: string | null };
type PaymentRow = { id: string; org_id: string; provider: string; provider_payment_id: string | null; purpose: Payment["purpose"]; invoice_id: string | null; topup_id: string | null; currency: string; amount_minor: number; status: PaymentStatus; failure_reason: string | null; refunded_minor: number; created_at: string; paid_at: string | null };
const toPayment = (r: PaymentRow): Payment => ({ id: r.id, orgId: r.org_id, provider: r.provider, providerPaymentId: r.provider_payment_id, purpose: r.purpose, invoiceId: r.invoice_id, topupId: r.topup_id, currency: r.currency, amountMinor: r.amount_minor, status: r.status, failureReason: r.failure_reason, refundedMinor: r.refunded_minor, createdAt: r.created_at, paidAt: r.paid_at });

export type Topup = { id: string; number: string; orgId: string; packageId: string; creditUnits: number; currency: string; subtotalMinor: number; gstBasisPoints: number; gstMinor: number; totalMinor: number; status: "pending" | "paid" | "cancelled"; createdAt: string; paidAt: string | null };
type TopupRow = { id: string; number: string; org_id: string; package_id: string; credit_units: number; currency: string; subtotal_minor: number; gst_basis_points: number; gst_minor: number; total_minor: number; status: Topup["status"]; created_at: string; paid_at: string | null };
const toTopup = (r: TopupRow): Topup => ({ id: r.id, number: r.number, orgId: r.org_id, packageId: r.package_id, creditUnits: r.credit_units, currency: r.currency, subtotalMinor: r.subtotal_minor, gstBasisPoints: r.gst_basis_points, gstMinor: r.gst_minor, totalMinor: r.total_minor, status: r.status, createdAt: r.created_at, paidAt: r.paid_at });

export type Refund = { id: string; paymentId: string; orgId: string; provider: string; providerRefundId: string | null; amountMinor: number; currency: string; reason: string; status: "pending" | "succeeded" | "failed"; creditsReversedUnits: number; creditsUnrecoveredUnits: number; requestedBy: string; createdAt: string };
type RefundRow = { id: string; payment_id: string; org_id: string; provider: string; provider_refund_id: string | null; amount_minor: number; currency: string; reason: string; status: Refund["status"]; credits_reversed_units: number; credits_unrecovered_units: number; requested_by: string; created_at: string };
const toRefund = (r: RefundRow): Refund => ({ id: r.id, paymentId: r.payment_id, orgId: r.org_id, provider: r.provider, providerRefundId: r.provider_refund_id, amountMinor: r.amount_minor, currency: r.currency, reason: r.reason, status: r.status, creditsReversedUnits: r.credits_reversed_units, creditsUnrecoveredUnits: r.credits_unrecovered_units, requestedBy: r.requested_by, createdAt: r.created_at });

const getPaymentRow = (db: DatabaseSync, id: string) => db.prepare("SELECT * FROM billing_payments WHERE id = ?").get(id) as PaymentRow | undefined;

// ---- reading ---------------------------------------------------------------------------------------------------------------
export function listPayments(opts: { orgId?: string; status?: string; limit?: number } = {}): Payment[] {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (opts.orgId) { where.push("org_id = ?"); args.push(opts.orgId); }
  if (opts.status) { where.push("status = ?"); args.push(opts.status); }
  const rows = getDb().prepare(`SELECT * FROM billing_payments ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(...args, Math.min(Math.max(1, Math.floor(opts.limit ?? 50)), 200)) as PaymentRow[];
  return rows.map(toPayment);
}
export const getPayment = (id: string): Payment | null => { const r = getPaymentRow(getDb(), id); return r ? toPayment(r) : null; };
export const listRefunds = (paymentId: string): Refund[] => (getDb().prepare("SELECT * FROM refunds WHERE payment_id = ? ORDER BY created_at, rowid").all(paymentId) as RefundRow[]).map(toRefund);
export const listTopups = (orgId: string): Topup[] => (getDb().prepare("SELECT * FROM topups WHERE org_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 50").all(orgId) as TopupRow[]).map(toTopup);
export const getTopup = (id: string): Topup | null => { const r = getDb().prepare("SELECT * FROM topups WHERE id = ?").get(id) as TopupRow | undefined; return r ? toTopup(r) : null; };
export type WebhookEventRow = { id: number; provider: string; eventId: string; type: string; status: string; error: string | null; receivedAt: string };
export const listWebhookEvents = (limit = 50): WebhookEventRow[] =>
  (getDb().prepare("SELECT id, provider, event_id AS eventId, type, status, error, received_at AS receivedAt FROM payment_webhook_events ORDER BY id DESC LIMIT ?").all(Math.min(Math.max(1, limit), 200)) as WebhookEventRow[]).map((r) => ({ ...r }));

// ---- credit packages and top-up orders -------------------------------------------------------------------------------------
export type CreditPackage = { id: string; name: string; creditUnits: number; active: boolean; sortOrder: number; prices: { currency: string; amountMinor: number }[] };
type PackageRow = { id: string; name: string; credit_units: number; active: number; sort_order: number };
export function listCreditPackages(opts: { includeInactive?: boolean } = {}): CreditPackage[] {
  const db = getDb();
  const rows = db.prepare(`SELECT * FROM credit_packages ${opts.includeInactive ? "" : "WHERE active = 1"} ORDER BY sort_order, credit_units`).all() as PackageRow[];
  const prices = db.prepare("SELECT package_id, currency, amount_minor FROM credit_package_prices ORDER BY currency").all() as { package_id: string; currency: string; amount_minor: number }[];
  return rows.map((r) => ({ id: r.id, name: r.name, creditUnits: r.credit_units, active: r.active === 1, sortOrder: r.sort_order, prices: prices.filter((p) => p.package_id === r.id).map((p) => ({ currency: p.currency, amountMinor: p.amount_minor })) }));
}

/** Creates or edits a pack of credits (admin). Existing orders keep what they were made at. */
export function saveCreditPackage(input: { id: string; name?: string; credits?: number; active?: boolean; sortOrder?: number }): CreditPackage {
  const id = String(input.id ?? "").trim();
  if (!/^[a-z0-9][a-z0-9_-]{1,40}$/.test(id)) throw bad("A package id is 2 to 41 lowercase letters, digits, dashes or underscores.");
  const db = getDb();
  const existing = db.prepare("SELECT * FROM credit_packages WHERE id = ?").get(id) as PackageRow | undefined;
  if (!existing && (input.credits === undefined || !input.name)) throw bad("A new package needs a name and a number of credits.");
  const units = input.credits !== undefined ? Math.round(input.credits * 1000) : existing!.credit_units;
  if (!Number.isSafeInteger(units) || units < 1) throw bad("credits must be a positive number.");
  const name = (input.name ?? existing!.name).trim();
  if (!name || name.length > 60) throw bad("A package name is required (up to 60 characters).");
  const order = input.sortOrder ?? existing?.sort_order ?? 0;
  if (!Number.isSafeInteger(order)) throw bad("sortOrder must be a whole number.");
  const at = nowIso();
  db.prepare("INSERT INTO credit_packages (id, name, credit_units, active, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, credit_units = excluded.credit_units, active = excluded.active, sort_order = excluded.sort_order, updated_at = excluded.updated_at")
    .run(id, name, units, input.active === false ? 0 : existing && input.active === undefined ? existing.active : 1, order, at, at);
  return listCreditPackages({ includeInactive: true }).find((p) => p.id === id)!;
}

/** Sets or removes (null) a pack's price in one currency (admin). */
export function setPackagePrice(input: { packageId: string; currency: string; amountMinor: number | null }): CreditPackage {
  const db = getDb();
  if (!db.prepare("SELECT 1 FROM credit_packages WHERE id = ?").get(input.packageId)) throw bad("That package does not exist.");
  if (!isCurrency(input.currency)) throw bad(`currency must be one of: ${CURRENCY_CODES.join(", ")}.`);
  if (input.amountMinor === null) db.prepare("DELETE FROM credit_package_prices WHERE package_id = ? AND currency = ?").run(input.packageId, input.currency);
  else {
    if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor < 1) throw bad("The price must be a whole number of the currency's smallest unit, at least 1.");
    db.prepare("INSERT INTO credit_package_prices (package_id, currency, amount_minor) VALUES (?, ?, ?) ON CONFLICT(package_id, currency) DO UPDATE SET amount_minor = excluded.amount_minor").run(input.packageId, input.currency, input.amountMinor);
  }
  return listCreditPackages({ includeInactive: true }).find((p) => p.id === input.packageId)!;
}

const MAX_PENDING_TOPUPS = 5;

/**
 * An order for a pack of credits: fixed amount, tax (GST on rupees only), a number. Nothing is bought until a verified payment arrives.
 * Creates the order and a pending payment for it. An organization may have a few unpaid orders at a time, not an unlimited number.
 */
export function createTopupOrder(input: { orgId: string; packageId: string; currency: string; createdBy?: string; provider?: string; now?: number }): { topup: Topup; payment: Payment } {
  const at = new Date(input.now ?? Date.now()).toISOString();
  return transaction((db) => {
    const org = db.prepare("SELECT type, status FROM organizations WHERE id = ?").get(input.orgId) as { type: string; status: string } | undefined;
    if (!org) throw bad("That organization does not exist.");
    if (org.type === "internal") throw bad("The agency does not buy credits: it keeps its own books.");
    if (org.status !== "active") throw bad("That organization is suspended.");
    if (!isCurrency(input.currency)) throw bad(`currency must be one of: ${CURRENCY_CODES.join(", ")}.`);
    const pkg = db.prepare("SELECT * FROM credit_packages WHERE id = ?").get(input.packageId) as PackageRow | undefined;
    if (!pkg || pkg.active !== 1) throw bad("That credit package is not available.");
    const price = db.prepare("SELECT amount_minor FROM credit_package_prices WHERE package_id = ? AND currency = ?").get(pkg.id, input.currency) as { amount_minor: number } | undefined;
    if (!price) throw bad(`The ${pkg.name} package is not sold in ${input.currency}.`);
    const waiting = (db.prepare("SELECT COUNT(*) AS n FROM topups WHERE org_id = ? AND status = 'pending'").get(input.orgId) as { n: number }).n;
    if (waiting >= MAX_PENDING_TOPUPS) throw bad(`There are already ${waiting} unpaid top-up orders. Pay or cancel one first.`);
    const provider = input.provider ?? "manual";
    if (!getPaymentProvider(provider)?.isConfigured()) throw bad("That payment method is not available.");
    const bp = input.currency === "INR" ? gstBasisPoints(db) : 0;
    const gst = Math.round((price.amount_minor * bp) / 10_000);
    const year = at.slice(0, 4);
    const last = db.prepare("SELECT MAX(CAST(SUBSTR(number, 10) AS INTEGER)) AS n FROM topups WHERE number LIKE ?").get(`TOP-${year}-%`) as { n: number | null };
    const topupId = `top_${randomUUID()}`;
    db.prepare("INSERT INTO topups (id, number, org_id, package_id, credit_units, currency, subtotal_minor, gst_basis_points, gst_minor, total_minor, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)")
      .run(topupId, `TOP-${year}-${String((last.n ?? 0) + 1).padStart(5, "0")}`, input.orgId, pkg.id, pkg.credit_units, input.currency, price.amount_minor, bp, gst, price.amount_minor + gst, input.createdBy ?? "", at);
    const paymentId = `pay_${randomUUID()}`;
    db.prepare("INSERT INTO billing_payments (id, org_id, provider, provider_payment_id, purpose, topup_id, currency, amount_minor, status, created_at, updated_at) VALUES (?, ?, ?, NULL, 'topup', ?, ?, ?, 'pending', ?, ?)")
      .run(paymentId, input.orgId, provider, topupId, input.currency, price.amount_minor + gst, at, at);
    return { topup: toTopup(db.prepare("SELECT * FROM topups WHERE id = ?").get(topupId) as TopupRow), payment: toPayment(getPaymentRow(db, paymentId)!) };
  });
}

/** Cancels an unpaid top-up order (the customer changed their mind). A paid order cannot be cancelled: refund it instead. */
export function cancelTopupOrder(input: { orgId: string; topupId: string }): Topup {
  return transaction((db) => {
    const t = db.prepare("SELECT * FROM topups WHERE id = ? AND org_id = ?").get(input.topupId, input.orgId) as TopupRow | undefined;
    if (!t) throw bad("That top-up order does not exist.");
    if (t.status !== "pending") throw bad(t.status === "paid" ? "That order is paid. Ask for a refund instead." : "That order is already cancelled.");
    db.prepare("UPDATE topups SET status = 'cancelled' WHERE id = ?").run(t.id);
    db.prepare("UPDATE billing_payments SET status = 'failed', failure_reason = 'Order cancelled', updated_at = ? WHERE topup_id = ? AND status = 'pending'").run(nowIso(), t.id);
    return toTopup(db.prepare("SELECT * FROM topups WHERE id = ?").get(t.id) as TopupRow);
  });
}

// ---- applying a payment ----------------------------------------------------------------------------------------------------
type Resolved = { orgId: string; currency: string; expected: number; label: string; paid: boolean; invoiceId: string | null; topupId: string | null };

function resolveTarget(db: DatabaseSync, target: PaymentTarget): Resolved {
  if (target.kind === "invoice") {
    const inv = db.prepare("SELECT id, org_id, currency, total_paise, status, number FROM subscription_invoices WHERE id = ?").get(target.invoiceId) as { id: string; org_id: string; currency: string; total_paise: number; status: string; number: string } | undefined;
    if (!inv) throw new PaymentProblem("That invoice does not exist.");
    if (inv.status === "void") throw new PaymentProblem(`Invoice ${inv.number} was cancelled.`);
    return { orgId: inv.org_id, currency: inv.currency, expected: inv.total_paise, label: `invoice ${inv.number}`, paid: inv.status === "paid", invoiceId: inv.id, topupId: null };
  }
  const t = db.prepare("SELECT id, org_id, currency, total_minor, status, number FROM topups WHERE id = ?").get(target.topupId) as { id: string; org_id: string; currency: string; total_minor: number; status: string; number: string } | undefined;
  if (!t) throw new PaymentProblem("That top-up order does not exist.");
  if (t.status === "cancelled") throw new PaymentProblem(`Top-up order ${t.number} was cancelled.`);
  return { orgId: t.org_id, currency: t.currency, expected: t.total_minor, label: `top-up ${t.number}`, paid: t.status === "paid", invoiceId: null, topupId: t.id };
}

const SETTLED: PaymentStatus[] = ["succeeded", "refunded", "partially_refunded", "disputed"];

/**
 * Applies money that arrived. Checks amount and currency against the invoice or top-up, finds the payment (so the same one is never applied twice),
 * pays the invoice or grants the credits, and records it. Runs inside the caller's transaction.
 * `rejectIfAlreadyPaid`: refuse (the administrator's record) instead of keeping a flagged duplicate (a provider's second payment for something already paid).
 */
export function applySuccessfulPayment(db: DatabaseSync, p: { provider: string; providerPaymentId: string; target: PaymentTarget; amountMinor?: number; currency?: string; at: string; rejectIfAlreadyPaid?: boolean }): { payment: Payment; applied: boolean; duplicate: boolean } {
  const t = resolveTarget(db, p.target);
  const existing = db.prepare("SELECT * FROM billing_payments WHERE provider = ? AND provider_payment_id = ?").get(p.provider, p.providerPaymentId) as PaymentRow | undefined;
  if (existing && SETTLED.includes(existing.status)) return { payment: toPayment(existing), applied: false, duplicate: true };
  if (p.currency !== undefined && p.currency.toUpperCase() !== t.currency) throw new PaymentProblem(`The payment is in ${p.currency.toUpperCase()} but ${t.label} is in ${t.currency}.`);
  if (p.amountMinor !== undefined && p.amountMinor !== t.expected) throw new PaymentProblem(`The payment is ${p.amountMinor} but ${t.label} is ${t.expected}.`);

  // Take the row this payment belongs to: the one already made for it, or a pending one made for the order, or a new one.
  const pendingForTarget = t.topupId ? (db.prepare("SELECT * FROM billing_payments WHERE topup_id = ? AND provider = ? AND provider_payment_id IS NULL AND status = 'pending' ORDER BY created_at LIMIT 1").get(t.topupId, p.provider) as PaymentRow | undefined) : undefined;
  const row = existing ?? pendingForTarget;
  const id = row?.id ?? `pay_${randomUUID()}`;
  const save = (status: PaymentStatus, note: string | null) => {
    if (row) db.prepare("UPDATE billing_payments SET provider_payment_id = ?, amount_minor = ?, currency = ?, status = ?, failure_reason = ?, paid_at = ?, updated_at = ? WHERE id = ?").run(p.providerPaymentId, t.expected, t.currency, status, note, p.at, p.at, id);
    else db.prepare("INSERT INTO billing_payments (id, org_id, provider, provider_payment_id, purpose, invoice_id, topup_id, currency, amount_minor, status, failure_reason, created_at, updated_at, paid_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, t.orgId, p.provider, p.providerPaymentId, t.invoiceId ? "subscription_invoice" : "topup", t.invoiceId, t.topupId, t.currency, t.expected, status, note, p.at, p.at, p.at);
  };

  if (t.paid) {
    if (p.rejectIfAlreadyPaid) throw new PaymentProblem(`${t.label[0]!.toUpperCase()}${t.label.slice(1)} is already paid.`);
    // Money arrived for something that was already paid. Keep the record, apply nothing, and say so, so it can be refunded.
    save("succeeded", `Second payment for ${t.label}, which was already paid. Nothing was applied: refund it.`);
    recordAuditIn(db, { actor: p.provider === "manual" ? "admin" : `provider:${p.provider}`, action: "payment.duplicate_flagged", entityType: "payment", entityId: id, orgId: t.orgId, detail: { amountMinor: t.expected, currency: t.currency, reference: p.providerPaymentId } }, p.at);
    return { payment: toPayment(getPaymentRow(db, id)!), applied: false, duplicate: false };
  }

  if (t.invoiceId) markInvoicePaidIn(db, { invoiceId: t.invoiceId, providerRef: `${p.provider}:${p.providerPaymentId}` }, p.at);
  else {
    const topup = db.prepare("SELECT * FROM topups WHERE id = ?").get(t.topupId!) as TopupRow;
    addCreditsIn(db, { orgId: topup.org_id, units: topup.credit_units, kind: "purchase", category: "purchased", idempotencyKey: `topup:${topup.id}`, reference: `topup:${topup.number}`, note: `Credit top-up ${topup.number}`, createdBy: "system", at: p.at });
    db.prepare("UPDATE topups SET status = 'paid', paid_at = ? WHERE id = ?").run(p.at, topup.id);
  }
  save("succeeded", null);
  recordAuditIn(db, { actor: p.provider === "manual" ? "admin" : `provider:${p.provider}`, action: "payment.succeeded", entityType: "payment", entityId: id, orgId: t.orgId, detail: { amountMinor: t.expected, currency: t.currency, reference: p.providerPaymentId, for: t.invoiceId ? `invoice ${t.invoiceId}` : `top-up ${t.topupId}` } }, p.at);
  // Any other attempt still waiting for the same thing is no longer needed.
  db.prepare("UPDATE billing_payments SET status = 'failed', failure_reason = 'Paid another way', updated_at = ? WHERE id != ? AND status = 'pending' AND ((invoice_id IS NOT NULL AND invoice_id = ?) OR (topup_id IS NOT NULL AND topup_id = ?))").run(p.at, id, t.invoiceId, t.topupId);
  return { payment: toPayment(getPaymentRow(db, id)!), applied: true, duplicate: false };
}

/** A failed attempt. Recorded for the history and for the customer to see; it never undoes a payment that already succeeded. */
export function applyFailedPayment(db: DatabaseSync, p: { provider: string; providerPaymentId: string; target: PaymentTarget; reason: string; at: string }): { payment: Payment | null } {
  const t = resolveTarget(db, p.target);
  const existing = db.prepare("SELECT * FROM billing_payments WHERE provider = ? AND provider_payment_id = ?").get(p.provider, p.providerPaymentId) as PaymentRow | undefined;
  if (existing && SETTLED.includes(existing.status)) return { payment: toPayment(existing) };
  const reason = p.reason.slice(0, 300);
  if (existing) db.prepare("UPDATE billing_payments SET status = 'failed', failure_reason = ?, updated_at = ? WHERE id = ?").run(reason, p.at, existing.id);
  else {
    const id = `pay_${randomUUID()}`;
    db.prepare("INSERT INTO billing_payments (id, org_id, provider, provider_payment_id, purpose, invoice_id, topup_id, currency, amount_minor, status, failure_reason, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'failed', ?, ?, ?)")
      .run(id, t.orgId, p.provider, p.providerPaymentId, t.invoiceId ? "subscription_invoice" : "topup", t.invoiceId, t.topupId, t.currency, t.expected, reason, p.at, p.at);
    return { payment: toPayment(getPaymentRow(db, id)!) };
  }
  return { payment: toPayment(getPaymentRow(db, existing.id)!) };
}

export type ManualPaymentInput = { invoiceId?: string; topupId?: string; reference: string; amountMinor?: number; now?: number };

/**
 * The administrator records money received outside the system (UPI, a bank transfer, cash). Same checks as a provider's payment: the amount, when given, must match;
 * recording the same reference again changes nothing; a different reference for something already paid is refused.
 */
export function recordManualPayment(input: ManualPaymentInput): { payment: Payment; applied: boolean; duplicate: boolean } {
  if ((input.invoiceId === undefined) === (input.topupId === undefined)) throw bad("Give either invoiceId or topupId, not both and not neither.");
  const reference = typeof input.reference === "string" ? input.reference.trim() : "";
  if (reference.length < 3 || reference.length > 200) throw bad("A payment reference of 3 to 200 characters is required.");
  const at = new Date(input.now ?? Date.now()).toISOString();
  const target: PaymentTarget = input.invoiceId !== undefined ? { kind: "invoice", invoiceId: input.invoiceId } : { kind: "topup", topupId: input.topupId! };
  return transaction((db) => {
    try {
      return applySuccessfulPayment(db, { provider: "manual", providerPaymentId: reference, target, amountMinor: input.amountMinor, at, rejectIfAlreadyPaid: true });
    } catch (e) {
      if (e instanceof PaymentProblem) throw bad(e.message);
      throw e;
    }
  });
}

// ---- refunds ---------------------------------------------------------------------------------------------------------------
/**
 * Takes back the credits a refunded payment bought, in proportion to the money returned (refund 1/4 of the money, take back 1/4 of the credits),
 * from the very bucket those credits went into, as far as they are still there. What was already spent cannot be taken back: it is recorded as unrecovered.
 */
function reverseCredits(db: DatabaseSync, pay: PaymentRow, refundId: string, cumulativeRefunded: number): { reversed: number; unrecovered: number } {
  // A second payment for something already paid applied nothing, so refunding it must take nothing back.
  if (pay.failure_reason?.startsWith("Second payment")) return { reversed: 0, unrecovered: 0 };
  let grantKey: string | null = null;
  if (pay.topup_id) grantKey = `topup:${pay.topup_id}`;
  else if (pay.invoice_id) {
    const inv = db.prepare("SELECT subscription_id, period_start FROM subscription_invoices WHERE id = ?").get(pay.invoice_id) as { subscription_id: string; period_start: string } | undefined;
    if (inv) grantKey = `plan:${inv.subscription_id}:${inv.period_start}`;
  }
  if (!grantKey) return { reversed: 0, unrecovered: 0 };
  const grant = db.prepare("SELECT delta_units AS units FROM credit_ledger WHERE org_id = ? AND idempotency_key = ?").get(pay.org_id, grantKey) as { units: number } | undefined;
  if (!grant || grant.units <= 0) return { reversed: 0, unrecovered: 0 };
  const targetTotal = Math.floor((grant.units * cumulativeRefunded) / pay.amount_minor);
  const done = db.prepare("SELECT COALESCE(SUM(credits_reversed_units + credits_unrecovered_units), 0) AS n FROM refunds WHERE payment_id = ? AND status = 'succeeded' AND id != ?").get(pay.id, refundId) as { n: number };
  const now = Math.max(0, targetTotal - done.n);
  const r = clawbackIn(db, { orgId: pay.org_id, bucketId: bucketOfGrant(db, pay.org_id, grantKey), units: now, idempotencyKey: `refund:${refundId}`, note: "Credits taken back after a refund", reference: `refund:${refundId}` });
  return { reversed: r.removed, unrecovered: r.shortfall };
}

/** Marks a refund as done: updates the payment, takes the credits back, and records how many were recovered. Inside the caller's transaction. */
function finishRefund(db: DatabaseSync, refundId: string, providerRefundId: string | null, at: string): Refund {
  const refund = db.prepare("SELECT * FROM refunds WHERE id = ?").get(refundId) as RefundRow;
  const pay = getPaymentRow(db, refund.payment_id)!;
  const cumulative = pay.refunded_minor + refund.amount_minor;
  db.prepare("UPDATE refunds SET status = 'succeeded', provider_refund_id = COALESCE(?, provider_refund_id) WHERE id = ?").run(providerRefundId, refundId);
  db.prepare("UPDATE billing_payments SET refunded_minor = ?, status = ?, updated_at = ? WHERE id = ?").run(cumulative, cumulative >= pay.amount_minor ? "refunded" : "partially_refunded", at, pay.id);
  const { reversed, unrecovered } = reverseCredits(db, { ...pay, refunded_minor: cumulative }, refundId, cumulative);
  db.prepare("UPDATE refunds SET credits_reversed_units = ?, credits_unrecovered_units = ? WHERE id = ?").run(reversed, unrecovered, refundId);
  recordAuditIn(db, { actor: refund.requested_by || "system", action: "refund.succeeded", entityType: "payment", entityId: pay.id, orgId: pay.org_id, detail: { refundId, amountMinor: refund.amount_minor, currency: refund.currency, reason: refund.reason, creditsReversedUnits: reversed, creditsUnrecoveredUnits: unrecovered } }, at);
  return toRefund(db.prepare("SELECT * FROM refunds WHERE id = ?").get(refundId) as RefundRow);
}

/**
 * Returns money for a payment, in full or in part (admin). For a provider that can refund, the provider is asked first and the books change only if it agrees;
 * for the manual provider the money is returned outside the system and this records it. The credits the payment bought are taken back as far as they are unspent.
 * Repeating the same request (same idempotency key) returns the first result and refunds nothing more.
 */
export async function refundPayment(input: { paymentId: string; amountMinor?: number; reason: string; requestedBy: string; idempotencyKey?: string; now?: number }): Promise<Refund> {
  const at = new Date(input.now ?? Date.now()).toISOString();
  const reason = String(input.reason ?? "").trim();
  if (reason.length < 3 || reason.length > 300) throw bad("A reason of 3 to 300 characters is required for a refund.");
  const key = input.idempotencyKey?.trim() || undefined;
  if (key !== undefined && (key.length < 6 || key.length > 200)) throw bad("An idempotency key of 6 to 200 characters is required.");

  // 1. Reserve the refund: it counts against what can still be refunded straight away, so two refunds cannot both take the same money.
  const started = transaction((db) => {
    const pay = getPaymentRow(db, input.paymentId);
    if (!pay) throw bad("That payment does not exist.");
    if (key) {
      const prior = db.prepare("SELECT * FROM refunds WHERE payment_id = ? AND idempotency_key = ?").get(pay.id, key) as RefundRow | undefined;
      if (prior) {
        if (input.amountMinor !== undefined && input.amountMinor !== prior.amount_minor) throw bad("That idempotency key was already used for a different refund.");
        return { refund: toRefund(prior), pay, existing: true };
      }
    }
    if (pay.status !== "succeeded" && pay.status !== "partially_refunded") throw bad(pay.status === "refunded" ? "That payment is already fully refunded." : "Only a successful payment can be refunded.");
    const reserved = (db.prepare("SELECT COALESCE(SUM(amount_minor), 0) AS n FROM refunds WHERE payment_id = ? AND status IN ('pending', 'succeeded')").get(pay.id) as { n: number }).n;
    const remaining = pay.amount_minor - reserved;
    const amount = input.amountMinor ?? remaining;
    if (!Number.isSafeInteger(amount) || amount < 1) throw bad("The refund amount must be a whole number of at least 1.");
    if (amount > remaining) throw bad(`Only ${remaining} of this payment can still be refunded.`);
    const id = `ref_${randomUUID()}`;
    db.prepare("INSERT INTO refunds (id, payment_id, org_id, provider, amount_minor, currency, reason, status, requested_by, idempotency_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)")
      .run(id, pay.id, pay.org_id, pay.provider, amount, pay.currency, reason, String(input.requestedBy ?? "").slice(0, 80), key ?? null, at);
    return { refund: toRefund(db.prepare("SELECT * FROM refunds WHERE id = ?").get(id) as RefundRow), pay, existing: false };
  });
  if (started.existing && started.refund.status !== "pending") return started.refund;

  // 2. Ask the provider, if there is one that can. Outside any transaction: this is a call over the network.
  const provider = getPaymentProvider(started.pay.provider);
  let providerRefundId: string | null = null;
  if (provider?.refund && started.pay.provider !== "manual" && started.pay.provider_payment_id) {
    try {
      providerRefundId = (await provider.refund({ providerPaymentId: started.pay.provider_payment_id, amountMinor: started.refund.amountMinor, currency: started.pay.currency, reason, idempotencyKey: started.refund.id })).providerRefundId;
    } catch (e) {
      transaction((db) => db.prepare("UPDATE refunds SET status = 'failed' WHERE id = ? AND status = 'pending'").run(started.refund.id));
      throw bad(`The payment provider did not accept the refund: ${(e as Error).message}`);
    }
  }

  // 3. The money is on its way back: change the books.
  return transaction((db) => finishRefund(db, started.refund.id, providerRefundId, at));
}

/** A refund the provider made on its own (from its dashboard): recorded here too, once. */
function applyExternalRefund(db: DatabaseSync, p: { provider: string; providerPaymentId: string; providerRefundId: string; amountMinor: number; reason: string; at: string }): void {
  if (db.prepare("SELECT 1 FROM refunds WHERE provider = ? AND provider_refund_id = ?").get(p.provider, p.providerRefundId)) return; // one we made, or a repeat
  const pay = db.prepare("SELECT * FROM billing_payments WHERE provider = ? AND provider_payment_id = ?").get(p.provider, p.providerPaymentId) as PaymentRow | undefined;
  if (!pay) throw new PaymentProblem("A refund arrived for a payment this system does not know.");
  const remaining = pay.amount_minor - pay.refunded_minor;
  const amount = Math.min(p.amountMinor, remaining);
  if (amount < 1) throw new PaymentProblem("A refund arrived for a payment that is already fully refunded.");
  const id = `ref_${randomUUID()}`;
  db.prepare("INSERT INTO refunds (id, payment_id, org_id, provider, provider_refund_id, amount_minor, currency, reason, status, requested_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'provider', ?)")
    .run(id, pay.id, pay.org_id, pay.provider, p.providerRefundId, amount, pay.currency, p.reason.slice(0, 300), p.at);
  finishRefund(db, id, p.providerRefundId, p.at);
}

// ---- disputes (chargebacks) -------------------------------------------------------------------------------------------------
function applyDispute(db: DatabaseSync, p: { provider: string; providerPaymentId: string; outcome: "opened" | "won" | "lost"; eventId: string; at: string }): void {
  const pay = db.prepare("SELECT * FROM billing_payments WHERE provider = ? AND provider_payment_id = ?").get(p.provider, p.providerPaymentId) as PaymentRow | undefined;
  if (!pay) throw new PaymentProblem("A dispute arrived for a payment this system does not know.");
  if (p.outcome !== "lost") recordAuditIn(db, { actor: `provider:${p.provider}`, action: `payment.dispute_${p.outcome}`, entityType: "payment", entityId: pay.id, orgId: pay.org_id, detail: { amountMinor: pay.amount_minor, currency: pay.currency } }, p.at);
  if (p.outcome === "opened") {
    if (pay.status === "succeeded" || pay.status === "partially_refunded") db.prepare("UPDATE billing_payments SET status = 'disputed', updated_at = ? WHERE id = ?").run(p.at, pay.id);
  } else if (p.outcome === "won") {
    if (pay.status === "disputed") db.prepare("UPDATE billing_payments SET status = ?, updated_at = ? WHERE id = ?").run(pay.refunded_minor > 0 ? "partially_refunded" : "succeeded", p.at, pay.id);
  } else {
    // Lost: the bank took the money back. Treat what was left as refunded, and take the credits back as far as they are unspent.
    const remaining = pay.amount_minor - pay.refunded_minor;
    if (remaining < 1) return;
    const id = `ref_${randomUUID()}`;
    db.prepare("INSERT INTO refunds (id, payment_id, org_id, provider, provider_refund_id, amount_minor, currency, reason, status, requested_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'Chargeback: the dispute was lost', 'pending', 'provider', ?)")
      .run(id, pay.id, pay.org_id, pay.provider, `dispute:${p.eventId}`, remaining, pay.currency, p.at);
    finishRefund(db, id, null, p.at);
  }
}

// ---- the provider's notices -------------------------------------------------------------------------------------------------
/** Runs `fn`, and if it fails undoes everything it did inside it, leaving the surrounding transaction intact. */
function attempt<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("SAVEPOINT payment_event");
  try {
    const result = fn();
    db.exec("RELEASE payment_event");
    return result;
  } catch (error) {
    db.exec("ROLLBACK TO payment_event");
    db.exec("RELEASE payment_event");
    throw error;
  }
}

export type WebhookResult = { received: number; processed: number; duplicates: number; ignored: number; failed: number };

/**
 * The one door for a provider's notices. Verifies the signature (the provider's adapter does), then applies each event once:
 *  - a notice seen before (same provider event id) is recognised and does nothing;
 *  - a notice that cannot be applied for a business reason (wrong amount, unknown payment) is recorded as failed, and answered normally so the provider does not retry for ever;
 *  - anything unexpected rolls that notice back entirely and is raised, so the provider tries again.
 */
export function ingestWebhook(providerId: string, rawBody: string, headers: Record<string, string>, now = Date.now()): WebhookResult {
  const provider = getPaymentProvider(providerId);
  if (!provider || !provider.isConfigured() || typeof provider.parseWebhook !== "function") throw new WebhookError(404, "Unknown payment provider.");
  if (typeof rawBody !== "string" || rawBody.length === 0) throw new WebhookError(400, "The notice had no body.");
  const events = provider.parseWebhook(rawBody, headers); // throws WebhookError when the signature is wrong
  const at = new Date(now).toISOString();
  const result: WebhookResult = { received: events.length, processed: 0, duplicates: 0, ignored: 0, failed: 0 };
  for (const ev of events) {
    transaction((db) => {
      if (db.prepare("SELECT 1 FROM payment_webhook_events WHERE provider = ? AND event_id = ?").get(provider.id, ev.eventId)) { result.duplicates++; return; }
      let status: "processed" | "ignored" | "failed" = "processed";
      let error: string | null = null;
      try {
        status = attempt(db, () => applyEvent(db, provider.id, ev, at));
      } catch (e) {
        if (!(e instanceof PaymentProblem) && !(e instanceof ValidationError)) throw e; // unexpected: roll the whole notice back, answer with an error, the provider retries
        status = "failed";
        error = e.message.slice(0, 300);
      }
      db.prepare("INSERT INTO payment_webhook_events (provider, event_id, type, status, error, payload, received_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(provider.id, ev.eventId, ev.type, status, error, rawBody.slice(0, 20_000), at);
      if (status === "processed") result.processed++;
      else if (status === "ignored") result.ignored++;
      else result.failed++;
    });
  }
  return result;
}

function applyEvent(db: DatabaseSync, provider: string, ev: PaymentEvent, at: string): "processed" | "ignored" {
  switch (ev.type) {
    case "payment.succeeded":
      applySuccessfulPayment(db, { provider, providerPaymentId: ev.providerPaymentId, target: ev.target, amountMinor: ev.amountMinor, currency: ev.currency, at });
      return "processed";
    case "payment.failed":
      applyFailedPayment(db, { provider, providerPaymentId: ev.providerPaymentId, target: ev.target, reason: ev.reason, at });
      return "processed";
    case "refund.succeeded":
      applyExternalRefund(db, { provider, providerPaymentId: ev.providerPaymentId, providerRefundId: ev.providerRefundId, amountMinor: ev.amountMinor, reason: ev.reason ?? "Refunded by the provider", at });
      return "processed";
    case "dispute.opened":
    case "dispute.won":
    case "dispute.lost":
      applyDispute(db, { provider, providerPaymentId: ev.providerPaymentId, outcome: ev.type.slice("dispute.".length) as "opened" | "won" | "lost", eventId: ev.eventId, at });
      return "processed";
    default:
      return "ignored";
  }
}
