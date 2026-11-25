import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { getDb } from "@/lib/business/db";
import { isCurrency } from "@/lib/currencies";
import { ValidationError } from "@/lib/business/validate";

/**
 * Coupons (server only): discount codes for subscriptions.
 *
 * A coupon is a percentage or a fixed amount in ONE currency; it lasts for one invoice ("once"), for a number of months ("repeating") or for as long as
 * the subscription runs ("forever"). It can be limited by dates, by how many organizations may use it, and by plan. One organization uses a coupon once.
 * The discount is written onto each invoice it applies to, and the subscription remembers its redemption, so a coupon changes nothing about the plan's own price.
 */

export const DURATIONS = ["once", "repeating", "forever"] as const;
export type Duration = (typeof DURATIONS)[number];

export type Coupon = { id: string; code: string; name: string; kind: "percent" | "fixed"; percentBp: number | null; fixedAmountMinor: number | null; fixedCurrency: string | null; duration: Duration; durationMonths: number | null; validFrom: string | null; validUntil: string | null; maxRedemptions: number | null; planIds: string[] | null; active: boolean; redemptions: number };
type CouponRow = { id: string; code: string; name: string; kind: "percent" | "fixed"; percent_bp: number | null; fixed_amount_minor: number | null; fixed_currency: string | null; duration: Duration; duration_months: number | null; valid_from: string | null; valid_until: string | null; max_redemptions: number | null; plan_ids: string | null; active: number; redemptions?: number };

const bad = (m: string) => new ValidationError(m);
const toCoupon = (r: CouponRow): Coupon => ({ id: r.id, code: r.code, name: r.name, kind: r.kind, percentBp: r.percent_bp, fixedAmountMinor: r.fixed_amount_minor, fixedCurrency: r.fixed_currency, duration: r.duration, durationMonths: r.duration_months, validFrom: r.valid_from, validUntil: r.valid_until, maxRedemptions: r.max_redemptions, planIds: r.plan_ids ? (JSON.parse(r.plan_ids) as string[]) : null, active: r.active === 1, redemptions: r.redemptions ?? 0 });

const SELECT = "SELECT c.*, (SELECT COUNT(*) FROM coupon_redemptions r WHERE r.coupon_id = c.id) AS redemptions FROM coupons c";
export const listCoupons = (db: DatabaseSync = getDb()): Coupon[] => (db.prepare(`${SELECT} ORDER BY c.created_at DESC, c.code`).all() as CouponRow[]).map(toCoupon);
export const getCouponByCode = (code: string, db: DatabaseSync = getDb()): Coupon | null => {
  const row = db.prepare(`${SELECT} WHERE c.code = ?`).get(String(code ?? "").trim()) as CouponRow | undefined;
  return row ? toCoupon(row) : null;
};

export type CouponInput = { code: string; name?: string; percentBasisPoints?: number; fixedAmountMinor?: number; fixedCurrency?: string; duration?: string; durationMonths?: number; validFrom?: string | null; validUntil?: string | null; maxRedemptions?: number | null; planIds?: string[] | null; active?: boolean };

const isoOrNull = (v: unknown, what: string): string | null => {
  if (v === null || v === undefined || v === "") return null;
  const t = Date.parse(String(v));
  if (!Number.isFinite(t)) throw bad(`${what} must be a valid date.`);
  return new Date(t).toISOString();
};

/**
 * Creates a coupon, or changes the one with the same code. `percentBasisPoints` is the discount in basis points of a percent,
 * for example 2000 = 20%. A fixed coupon needs its amount and its currency. The code is not case sensitive.
 */
export function saveCoupon(input: CouponInput): Coupon {
  const db = getDb();
  const code = String(input.code ?? "").trim();
  if (!/^[A-Za-z0-9_-]{3,40}$/.test(code)) throw bad("A coupon code is 3 to 40 letters, digits, dashes or underscores.");
  const percent = input.percentBasisPoints;
  const fixed = input.fixedAmountMinor;
  if ((percent === undefined) === (fixed === undefined)) throw bad("Give either percentBasisPoints or fixedAmountMinor with fixedCurrency, not both and not neither.");
  if (percent !== undefined && (!Number.isSafeInteger(percent) || percent < 1 || percent > 10_000)) throw bad("percentBasisPoints must be from 1 to 10000 (basis points of a percent: 2000 is 20%).");
  if (fixed !== undefined) {
    if (!Number.isSafeInteger(fixed) || fixed < 1) throw bad("fixedAmountMinor must be a whole number of the currency's smallest unit, at least 1.");
    if (!isCurrency(input.fixedCurrency)) throw bad("A fixed coupon needs fixedCurrency, one of the currencies plans are sold in.");
  }
  const duration = (input.duration ?? "once") as Duration;
  if (!(DURATIONS as readonly string[]).includes(duration)) throw bad(`duration must be one of: ${DURATIONS.join(", ")}.`);
  if (duration === "repeating" && (!Number.isSafeInteger(input.durationMonths) || (input.durationMonths as number) < 1 || (input.durationMonths as number) > 120)) throw bad("A repeating coupon needs durationMonths from 1 to 120.");
  if (duration !== "repeating" && input.durationMonths !== undefined && input.durationMonths !== null) throw bad("durationMonths only applies to a repeating coupon.");
  const from = isoOrNull(input.validFrom, "validFrom");
  const until = isoOrNull(input.validUntil, "validUntil");
  if (from && until && until <= from) throw bad("validUntil must be after validFrom.");
  if (input.maxRedemptions !== undefined && input.maxRedemptions !== null && (!Number.isSafeInteger(input.maxRedemptions) || input.maxRedemptions < 1)) throw bad("maxRedemptions must be a whole number of 1 or more, or empty for no limit.");
  let planIds: string | null = null;
  if (input.planIds) {
    if (!Array.isArray(input.planIds) || input.planIds.length === 0) throw bad("planIds must list at least one plan, or be empty for every plan.");
    for (const id of input.planIds) if (!db.prepare("SELECT 1 FROM plans WHERE id = ?").get(id)) throw bad(`Plan "${String(id)}" does not exist.`);
    planIds = JSON.stringify([...new Set(input.planIds)]);
  }
  const at = new Date().toISOString();
  const existing = db.prepare("SELECT id FROM coupons WHERE code = ?").get(code) as { id: string } | undefined;
  const args = [String(input.name ?? "").slice(0, 120), percent !== undefined ? "percent" : "fixed", percent ?? null, fixed ?? null, fixed !== undefined ? input.fixedCurrency! : null, duration, duration === "repeating" ? input.durationMonths! : null, from, until, input.maxRedemptions ?? null, planIds, input.active === false ? 0 : 1];
  if (existing) {
    const used = (db.prepare("SELECT COUNT(*) AS n FROM coupon_redemptions WHERE coupon_id = ?").get(existing.id) as { n: number }).n;
    if (used > 0) {
      // Once organizations have used a coupon, what it IS may not change under them: only whether it is offered, its dates and its limit.
      const before = db.prepare("SELECT * FROM coupons WHERE id = ?").get(existing.id) as CouponRow;
      const same = before.kind === args[1] && before.percent_bp === args[2] && before.fixed_amount_minor === args[3] && before.fixed_currency === args[4] && before.duration === args[5] && before.duration_months === args[6];
      if (!same) throw bad("This coupon has been used, so its discount and duration cannot change. Switch it off and create a new one.");
    }
    db.prepare("UPDATE coupons SET name = ?, kind = ?, percent_bp = ?, fixed_amount_minor = ?, fixed_currency = ?, duration = ?, duration_months = ?, valid_from = ?, valid_until = ?, max_redemptions = ?, plan_ids = ?, active = ?, updated_at = ? WHERE id = ?").run(...(args as (string | number | null)[]), at, existing.id);
  } else {
    db.prepare("INSERT INTO coupons (id, code, name, kind, percent_bp, fixed_amount_minor, fixed_currency, duration, duration_months, valid_from, valid_until, max_redemptions, plan_ids, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(`cpn_${randomUUID()}`, code, ...(args as (string | number | null)[]), at, at);
  }
  return getCouponByCode(code, db)!;
}

// ---- using a coupon ---------------------------------------------------------------------------------------------------------
/** Why a coupon cannot be used, in words a customer can read; null when it can. */
export function couponProblem(db: DatabaseSync, c: Coupon, ctx: { orgId: string; planId: string; currency: string; at: string }): string | null {
  if (!c.active) return "That coupon is not available.";
  if (c.validFrom && ctx.at < c.validFrom) return "That coupon is not valid yet.";
  if (c.validUntil && ctx.at > c.validUntil) return "That coupon has expired.";
  if (c.maxRedemptions !== null && c.redemptions >= c.maxRedemptions) return "That coupon has reached its limit.";
  if (c.planIds && !c.planIds.includes(ctx.planId)) return "That coupon does not apply to this plan.";
  if (c.kind === "fixed" && c.fixedCurrency !== ctx.currency) return `That coupon is only valid for payments in ${c.fixedCurrency}.`;
  if (db.prepare("SELECT 1 FROM coupon_redemptions WHERE coupon_id = ? AND org_id = ?").get(c.id, ctx.orgId)) return "This organization has already used that coupon.";
  return null;
}

/** Records that an organization used a coupon on a subscription. Refuses, with the reason, when it cannot be used. Runs inside the caller's transaction. */
export function redeemCouponIn(db: DatabaseSync, input: { code: string; orgId: string; subscriptionId: string; planId: string; currency: string; at: string }): { redemptionId: string; coupon: Coupon } {
  const coupon = getCouponByCode(input.code, db);
  if (!coupon) throw bad("That coupon code is not recognised.");
  const problem = couponProblem(db, coupon, input);
  if (problem) throw bad(problem);
  const id = `red_${randomUUID()}`;
  db.prepare("INSERT INTO coupon_redemptions (id, coupon_id, org_id, subscription_id, redeemed_at, periods_used) VALUES (?, ?, ?, ?, ?, 0)").run(id, coupon.id, input.orgId, input.subscriptionId, input.at);
  db.prepare("UPDATE subscriptions SET coupon_redemption_id = ? WHERE id = ?").run(id, input.subscriptionId);
  return { redemptionId: id, coupon };
}

/** Takes back a redemption that was never paid for (the request it belonged to was replaced), so it does not use up the coupon. */
export function releaseRedemptionIn(db: DatabaseSync, subscriptionId: string): void {
  db.prepare("UPDATE subscriptions SET coupon_redemption_id = NULL WHERE id = ?").run(subscriptionId);
  db.prepare("DELETE FROM coupon_redemptions WHERE subscription_id = ?").run(subscriptionId);
}

/**
 * The discount for the next invoice of a subscription, or null. It counts how many invoices the coupon has already covered: "once" covers one,
 * "repeating" covers enough invoices to span its months, "forever" covers all. The caller records the use with `noteCouponUsedIn`.
 */
export function discountFor(db: DatabaseSync, sub: { id: string; currency: string; billing_period: "monthly" | "annual"; coupon_redemption_id: string | null }, subtotalMinor: number): { discountMinor: number; code: string; redemptionId: string } | null {
  if (!sub.coupon_redemption_id || subtotalMinor <= 0) return null;
  const row = db.prepare("SELECT r.id AS rid, r.periods_used AS used, c.* FROM coupon_redemptions r JOIN coupons c ON c.id = r.coupon_id WHERE r.id = ?").get(sub.coupon_redemption_id) as (CouponRow & { rid: string; used: number }) | undefined;
  if (!row) return null;
  const monthsPerPeriod = sub.billing_period === "annual" ? 12 : 1;
  const covered = row.duration === "forever" ? Infinity : row.duration === "once" ? 1 : Math.ceil((row.duration_months ?? 0) / monthsPerPeriod);
  if (row.used >= covered) return null;
  let discount = 0;
  if (row.kind === "percent") discount = Math.round((subtotalMinor * (row.percent_bp ?? 0)) / 10_000);
  else if (row.fixed_currency === sub.currency) discount = row.fixed_amount_minor ?? 0;
  discount = Math.min(discount, subtotalMinor);
  return discount > 0 ? { discountMinor: discount, code: row.code, redemptionId: row.rid } : null;
}

export const noteCouponUsedIn = (db: DatabaseSync, redemptionId: string): void => {
  db.prepare("UPDATE coupon_redemptions SET periods_used = periods_used + 1 WHERE id = ?").run(redemptionId);
};
