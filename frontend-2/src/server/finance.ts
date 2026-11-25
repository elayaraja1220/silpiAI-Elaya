import { getDb } from "@/lib/business/db";
import { getUnitsPerUsd } from "@/server/ai/catalog";
import { auditBuckets, auditWallets } from "@/server/credits";
import { consolidate, rateMap, type Consolidated } from "@/server/fx";

/**
 * The administrator's money view, worked out from the books (payments, refunds, subscriptions, the wallets and the AI request log) when asked.
 * Amounts in different currencies are NEVER added together: each is reported in its own currency (no exchange rates exist yet, step 8).
 * AI figures are in US dollars because that is what providers charge. A "month" is a calendar month in UTC.
 */
export type ByCurrency = Record<string, number>;
export type AiLine = { key: string; requests: number; failed: number; fallbacks: number; providerCostMicroUsd: number; chargedUnits: number; billedMicroUsd: number; uncollectedUnits: number };
export type Finance = {
  generatedAt: string;
  month: { start: string; label: string };
  unitsPerUsd: number;
  revenue: { thisMonth: { received: ByCurrency; refunded: ByCurrency; net: ByCurrency }; lastMonth: { received: ByCurrency; refunded: ByCurrency; net: ByCurrency }; allTime: { received: ByCurrency; refunded: ByCurrency; net: ByCurrency }; topupsThisMonth: { orders: number; value: ByCurrency } };
  subscriptions: { activePaid: number; pastDue: number; inTrial: number; free: number; cancelling: number; endedThisMonth: number; mrr: ByCurrency; mrrAtRisk: ByCurrency; byPlan: { planId: string; name: string; count: number }[]; openInvoices: { count: number; value: ByCurrency } };
  credits: { outstandingUnits: number; outstandingValueMicroUsd: number; byCategory: { category: string; units: number }[]; grantedThisMonthUnits: number; spentThisMonthUnits: number };
  ai: { thisMonth: AiLine; lastMonth: AiLine; byProvider: AiLine[]; byModel: AiLine[]; daily: { date: string; requests: number; providerCostMicroUsd: number; billedMicroUsd: number }[] };
  /** The same money added up in US dollars at the exchange rates the administrator has entered. An estimate: currencies with no rate are listed as missing and left out. */
  inUsd: { netThisMonth: Consolidated; netLastMonth: Consolidated; netAllTime: Consolidated; mrr: Consolidated; mrrAtRisk: Consolidated; openInvoices: Consolidated };
  health: { walletMismatches: number; bucketMismatches: number; failedNoticesLast7Days: number; duplicatePaymentsToRefund: number; creditsNotRecoveredOnRefundUnits: number; stuckAiRequests: number; unchargedAiUnits: number };
};

const monthStart = (ms: number) => { const d = new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); };
const addMap = (m: ByCurrency, c: string, n: number) => { m[c] = (m[c] ?? 0) + n; };
const sub = (a: ByCurrency, b: ByCurrency): ByCurrency => { const out: ByCurrency = { ...a }; for (const [c, n] of Object.entries(b)) out[c] = (out[c] ?? 0) - n; return out; };

export function financeOverview(now = Date.now()): Finance {
  const db = getDb();
  const rate = getUnitsPerUsd(db);
  const thisStart = new Date(monthStart(now)).toISOString();
  const lastStart = new Date(monthStart(monthStart(now) - 1)).toISOString();
  const iso = (ms: number) => new Date(ms).toISOString();
  const billed = (units: number) => Math.round((units * 1_000_000) / rate); // micro-dollars of customer credit value

  // ---- revenue: cash in (successful payments) less money returned (successful refunds). Customers' real organizations only. ----
  const received = (from: string | null, to: string | null): ByCurrency => {
    const out: ByCurrency = {};
    const rows = db.prepare(`SELECT p.currency, SUM(p.amount_minor) AS n FROM billing_payments p JOIN organizations o ON o.id = p.org_id WHERE o.type != 'internal' AND p.status IN ('succeeded', 'partially_refunded', 'refunded', 'disputed') AND (? IS NULL OR p.paid_at >= ?) AND (? IS NULL OR p.paid_at < ?) GROUP BY p.currency`).all(from, from, to, to) as { currency: string; n: number }[];
    for (const r of rows) addMap(out, r.currency, r.n);
    return out;
  };
  const refunded = (from: string | null, to: string | null): ByCurrency => {
    const out: ByCurrency = {};
    const rows = db.prepare(`SELECT r.currency, SUM(r.amount_minor) AS n FROM refunds r WHERE r.status = 'succeeded' AND (? IS NULL OR r.created_at >= ?) AND (? IS NULL OR r.created_at < ?) GROUP BY r.currency`).all(from, from, to, to) as { currency: string; n: number }[];
    for (const r of rows) addMap(out, r.currency, r.n);
    return out;
  };
  const period = (from: string | null, to: string | null) => { const r = received(from, to); const f = refunded(from, to); return { received: r, refunded: f, net: sub(r, f) }; };
  const topupValue: ByCurrency = {};
  let topupOrders = 0;
  for (const r of db.prepare("SELECT currency, COUNT(*) AS c, SUM(total_minor) AS n FROM topups WHERE status = 'paid' AND paid_at >= ? GROUP BY currency").all(thisStart) as { currency: string; c: number; n: number }[]) { addMap(topupValue, r.currency, r.n); topupOrders += r.c; }

  // ---- subscriptions: monthly recurring revenue is what paying subscribers pay per month (yearly counted as a twelfth, rounded down) ----
  const subs = db.prepare(`SELECT s.plan_id, s.status, s.billing_period, s.currency, s.unit_amount_minor, s.cancel_at_period_end, s.trial_ends_at FROM subscriptions s JOIN organizations o ON o.id = s.org_id WHERE o.type != 'internal' AND s.status IN ('active', 'past_due')`).all() as { plan_id: string; status: string; billing_period: string; currency: string; unit_amount_minor: number | null; cancel_at_period_end: number; trial_ends_at: string | null }[];
  const mrr: ByCurrency = {};
  const mrrAtRisk: ByCurrency = {};
  const counts = { activePaid: 0, pastDue: 0, inTrial: 0, free: 0, cancelling: 0 };
  const perPlan = new Map<string, number>();
  for (const s of subs) {
    perPlan.set(s.plan_id, (perPlan.get(s.plan_id) ?? 0) + 1);
    const amount = s.unit_amount_minor ?? 0;
    if (amount <= 0) { counts.free++; continue; }
    if (s.trial_ends_at && s.trial_ends_at > iso(now)) { counts.inTrial++; continue; } // a trial pays nothing yet
    if (s.status === "past_due") counts.pastDue++; else counts.activePaid++;
    const monthly = s.billing_period === "annual" ? Math.floor(amount / 12) : amount;
    if (s.status === "active") addMap(mrr, s.currency, monthly); // past-due money is not counted as recurring until it is paid
    if (s.cancel_at_period_end === 1) { counts.cancelling++; addMap(mrrAtRisk, s.currency, monthly); }
  }
  const planNames = new Map((db.prepare("SELECT id, name FROM plans").all() as { id: string; name: string }[]).map((p) => [p.id, p.name]));
  const endedThisMonth = (db.prepare("SELECT COUNT(*) AS n FROM subscriptions s JOIN organizations o ON o.id = s.org_id WHERE o.type != 'internal' AND s.status = 'ended' AND s.unit_amount_minor > 0 AND s.updated_at >= ?").get(thisStart) as { n: number }).n;
  const open = db.prepare("SELECT i.currency, COUNT(*) AS c, SUM(i.total_paise) AS n FROM subscription_invoices i JOIN organizations o ON o.id = i.org_id WHERE o.type != 'internal' AND i.status = 'open' GROUP BY i.currency").all() as { currency: string; c: number; n: number }[];
  const openValue: ByCurrency = {};
  let openCount = 0;
  for (const r of open) { addMap(openValue, r.currency, r.n); openCount += r.c; }

  // ---- credits owed to customers (a liability: they can still be spent on AI we have to pay for) ----
  const buckets = db.prepare("SELECT b.category, SUM(b.remaining_units) AS n FROM credit_buckets b JOIN organizations o ON o.id = b.org_id WHERE o.type != 'internal' AND b.remaining_units > 0 GROUP BY b.category ORDER BY b.category").all() as { category: string; n: number }[];
  const outstanding = buckets.reduce((n, b) => n + b.n, 0);
  const granted = (db.prepare("SELECT COALESCE(SUM(l.delta_units), 0) AS n FROM credit_ledger l JOIN organizations o ON o.id = l.org_id WHERE o.type != 'internal' AND l.kind IN ('grant', 'purchase', 'refund') AND l.delta_units > 0 AND l.created_at >= ?").get(thisStart) as { n: number }).n;
  const spent = (db.prepare("SELECT COALESCE(SUM(r.charged_units), 0) AS n FROM ai_requests r JOIN organizations o ON o.id = r.org_id WHERE o.type != 'internal' AND r.status = 'completed' AND r.created_at >= ?").get(thisStart) as { n: number }).n;

  // ---- AI: what providers charged us against what customers were billed in credits ----
  type AiRow = { key: string; requests: number; failed: number; fallbacks: number; cost: number; charged: number; uncollected: number };
  const line = (r: AiRow | undefined, key: string): AiLine => ({ key, requests: r?.requests ?? 0, failed: r?.failed ?? 0, fallbacks: r?.fallbacks ?? 0, providerCostMicroUsd: r?.cost ?? 0, chargedUnits: r?.charged ?? 0, billedMicroUsd: billed(r?.charged ?? 0), uncollectedUnits: r?.uncollected ?? 0 });
  const aiSelect = (keyExpr: string, where: string, group: string) => `SELECT ${keyExpr} AS key, COUNT(*) AS requests, COALESCE(SUM(r.status = 'failed'), 0) AS failed, COALESCE(SUM(r.fallback_used), 0) AS fallbacks, COALESCE(SUM(r.provider_cost_micro_usd), 0) AS cost, COALESCE(SUM(r.charged_units), 0) AS charged, COALESCE(SUM(r.uncollected_units), 0) AS uncollected
    FROM ai_requests r JOIN organizations o ON o.id = r.org_id LEFT JOIN ai_models m ON m.id = r.model_id WHERE o.type != 'internal' AND r.status != 'running' AND ${where} ${group}`;
  const aiRange = (from: string, to: string | null) => line(db.prepare(aiSelect("'all'", "r.created_at >= ? AND (? IS NULL OR r.created_at < ?)", "")).get(from, to, to) as AiRow, "all");
  const grouped = (keyExpr: string) => (db.prepare(aiSelect(keyExpr, "r.created_at >= ?", `GROUP BY ${keyExpr} ORDER BY cost DESC`)).all(thisStart) as AiRow[]).map((r) => line(r, r.key));
  const days: { date: string; requests: number; providerCostMicroUsd: number; billedMicroUsd: number }[] = [];
  const dayStart = (back: number) => iso(Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate()) - back * 86_400_000);
  for (let back = 13; back >= 0; back--) {
    const r = db.prepare(aiSelect("'d'", "r.created_at >= ? AND r.created_at < ?", "")).get(dayStart(back), back === 0 ? iso(now + 86_400_000) : dayStart(back - 1)) as AiRow;
    days.push({ date: dayStart(back).slice(0, 10), requests: r.requests, providerCostMicroUsd: r.cost, billedMicroUsd: billed(r.charged) });
  }

  // ---- health: things that should be zero ----
  const week = iso(now - 7 * 86_400_000);
  const count = (sql: string, ...a: (string | number)[]) => (db.prepare(sql).get(...a) as { n: number }).n;

  const rates = rateMap(db);
  const usd = (m: ByCurrency) => consolidate(m, "USD", rates, db);
  return {
    generatedAt: iso(now),
    month: { start: thisStart, label: thisStart.slice(0, 7) },
    unitsPerUsd: rate,
    revenue: { thisMonth: period(thisStart, null), lastMonth: period(lastStart, thisStart), allTime: period(null, null), topupsThisMonth: { orders: topupOrders, value: topupValue } },
    subscriptions: {
      ...counts, endedThisMonth, mrr, mrrAtRisk,
      byPlan: [...perPlan].map(([planId, n]) => ({ planId, name: planNames.get(planId) ?? planId, count: n })).sort((a, b) => b.count - a.count),
      openInvoices: { count: openCount, value: openValue },
    },
    inUsd: { netThisMonth: usd(period(thisStart, null).net), netLastMonth: usd(period(lastStart, thisStart).net), netAllTime: usd(period(null, null).net), mrr: usd(mrr), mrrAtRisk: usd(mrrAtRisk), openInvoices: usd(openValue) },
    credits: { outstandingUnits: outstanding, outstandingValueMicroUsd: billed(outstanding), byCategory: buckets.map((b) => ({ category: b.category, units: b.n })), grantedThisMonthUnits: granted, spentThisMonthUnits: spent },
    ai: { thisMonth: aiRange(thisStart, null), lastMonth: aiRange(lastStart, thisStart), byProvider: grouped("COALESCE(m.provider, 'unknown')"), byModel: grouped("COALESCE(r.model_id, 'none')"), daily: days },
    health: {
      walletMismatches: auditWallets().length,
      bucketMismatches: auditBuckets().length,
      failedNoticesLast7Days: count("SELECT COUNT(*) AS n FROM payment_webhook_events WHERE status = 'failed' AND received_at >= ?", week),
      duplicatePaymentsToRefund: count("SELECT COUNT(*) AS n FROM billing_payments WHERE status = 'succeeded' AND failure_reason LIKE 'Second payment%' AND refunded_minor = 0"),
      creditsNotRecoveredOnRefundUnits: count("SELECT COALESCE(SUM(credits_unrecovered_units), 0) AS n FROM refunds WHERE status = 'succeeded'"),
      stuckAiRequests: count("SELECT COUNT(*) AS n FROM ai_requests WHERE status = 'running' AND created_at < ?", iso(now - 10 * 60_000)),
      unchargedAiUnits: count("SELECT COALESCE(SUM(uncollected_units), 0) AS n FROM ai_requests"),
    },
  };
}
