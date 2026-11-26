/**
 * The market hourly rate engine (pure; no database, no network, no floating point).
 *
 * A rate is looked up for a country, a role, an experience level and a KIND of benchmark:
 *   employee   - what a company pays a person (a wage turned into an hour). It is a COST, not a price.
 *   freelancer - what independents charge.
 *   agency     - what a software agency bills.
 * The administrator chooses which kind powers each quotation mode, and sets a multiplier, overhead and margin for each kind. Employee wages are never
 * used as a customer's price unless that is configured on purpose, and the result says so ("bills at cost") when it would.
 *
 * Nothing is invented: a country, role and level with no verified row has NO rate and the caller must fall back to something the team typed. Every row
 * carries its source and the date it applies from; an old row is flagged stale, not hidden. Amounts are whole numbers of the currency's smallest unit.
 */
export const BENCHMARK_KINDS = ["employee", "freelancer", "agency"] as const;
export type BenchmarkKind = (typeof BENCHMARK_KINDS)[number];
export const BENCHMARK_LABELS: Record<BenchmarkKind, string> = { employee: "Employee wage (a cost)", freelancer: "Freelancer billing rate", agency: "Agency billing rate" };

export const ANY_ROLE = "any";

export type MarketRate = {
  id: number;
  country: string;
  roleId: string;
  levelId: string;
  kind: BenchmarkKind;
  currency: string;
  minMinor: number;
  medianMinor: number;
  maxMinor: number;
  source: string;
  sourceUrl: string;
  /** The day (YYYY-MM-DD) this figure starts to apply. */
  effectiveDate: string;
  enteredBy: string;
  enteredAt: string;
  enabled: boolean;
  /** An assumption, not a measured market rate: shown as such wherever it is used. */
  illustrative: boolean;
  note: string;
};

/** How a benchmark becomes a price, in basis points (10,000 = 1.00). */
export type Billing = { multiplierBp: number; overheadBp: number; marginBp: number };
export type PricingConfig = {
  /** Which kind of benchmark powers each quotation mode. */
  benchmark: { hourly: BenchmarkKind; fixed: BenchmarkKind };
  billing: Record<BenchmarkKind, Billing>;
  /** Extra allowance on a fixed price for what cannot be foreseen, in basis points (500 = 5%). */
  riskAllowanceBp: number;
  /** A rate older than this many days is flagged as out of date. */
  staleAfterDays: number;
  /** Paid hours in a working year, used to turn a yearly salary into an hourly figure. */
  hoursPerYear: number;
};

/** Neutral starting settings: nothing here is a commercial assumption. An employee wage at x1.00 bills at cost, and the result says so. */
export const DEFAULT_PRICING_CONFIG: PricingConfig = {
  benchmark: { hourly: "freelancer", fixed: "agency" },
  billing: { employee: { multiplierBp: 10_000, overheadBp: 0, marginBp: 0 }, freelancer: { multiplierBp: 10_000, overheadBp: 0, marginBp: 0 }, agency: { multiplierBp: 10_000, overheadBp: 0, marginBp: 0 } },
  riskAllowanceBp: 0,
  staleAfterDays: 365,
  hoursPerYear: 2080,
};

export type Resolved =
  | {
      ok: true;
      country: string;
      currency: string;
      kind: BenchmarkKind;
      roleId: string;
      levelId: string;
      /** The role the row was for: "any" when no row existed for this exact role and the any-role row was used. */
      matchedRole: string;
      minMinor: number;
      medianMinor: number;
      maxMinor: number;
      /** The market figures after the multiplier, overhead and margin: what to charge. */
      billedMinMinor: number;
      billedMinor: number;
      billedMaxMinor: number;
      source: string;
      sourceUrl: string;
      effectiveDate: string;
      ageDays: number;
      stale: boolean;
      illustrative: boolean;
      /** True when the figure charged is the benchmark itself, with no multiplier, overhead or margin: the quotation would earn nothing above cost. */
      billsAtCost: boolean;
      rateId: number;
    }
  | { ok: false; reason: "no-country" | "no-rate" | "disabled"; message: string };

/** a x b / c, rounded half up, in whole numbers (BigInt): no floating point anywhere near money. */
export function mulDiv(a: number, b: number, c: number): number {
  const num = BigInt(Math.round(a)) * BigInt(Math.round(b));
  const den = BigInt(Math.round(c));
  return Number((num * BigInt(2) + den) / (den * BigInt(2)));
}

/** A figure with the multiplier, overhead and margin applied, to the smallest unit. */
export function applyBilling(minor: number, b: Billing): number {
  const afterMultiplier = mulDiv(minor, b.multiplierBp, 10_000);
  const afterOverhead = mulDiv(afterMultiplier, 10_000 + b.overheadBp, 10_000);
  return mulDiv(afterOverhead, 10_000 + b.marginBp, 10_000);
}

const dayNumber = (isoDay: string) => Math.floor(Date.parse(`${isoDay}T00:00:00Z`) / 86_400_000);

/** The row that applies today for this exact country, role, level and kind: the newest enabled row that has started. */
function current(rows: readonly MarketRate[], q: { country: string; roleId: string; levelId: string; kind: BenchmarkKind }, today: string): MarketRate | null {
  const live = rows.filter((r) => r.enabled && r.country === q.country && r.roleId === q.roleId && r.levelId === q.levelId && r.kind === q.kind && r.effectiveDate <= today);
  if (live.length === 0) return null;
  return live.reduce((a, b) => (b.effectiveDate > a.effectiveDate || (b.effectiveDate === a.effectiveDate && b.id > a.id) ? b : a));
}

export function resolveRate(rows: readonly MarketRate[], query: { country: string | null | undefined; roleId: string; levelId: string; kind: BenchmarkKind }, config: PricingConfig, today: string): Resolved {
  const country = String(query.country ?? "").toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) return { ok: false, reason: "no-country", message: "Choose the client's country first." };
  const q = { country, roleId: query.roleId, levelId: query.levelId, kind: query.kind };
  const exact = current(rows, q, today);
  const row = exact ?? (query.roleId !== ANY_ROLE ? current(rows, { ...q, roleId: ANY_ROLE }, today) : null);
  if (!row) return { ok: false, reason: "no-rate", message: `There is no verified ${BENCHMARK_LABELS[query.kind].toLowerCase()} for this country, role and level yet. Type a rate by hand, or ask an administrator to add one with its source.` };
  const b = config.billing[row.kind];
  const age = Math.max(0, dayNumber(today) - dayNumber(row.effectiveDate));
  const billedMinor = applyBilling(row.medianMinor, b);
  return {
    ok: true,
    country,
    currency: row.currency,
    kind: row.kind,
    roleId: query.roleId,
    levelId: query.levelId,
    matchedRole: row.roleId,
    minMinor: row.minMinor,
    medianMinor: row.medianMinor,
    maxMinor: row.maxMinor,
    billedMinMinor: applyBilling(row.minMinor, b),
    billedMinor,
    billedMaxMinor: applyBilling(row.maxMinor, b),
    source: row.source,
    sourceUrl: row.sourceUrl,
    effectiveDate: row.effectiveDate,
    ageDays: age,
    stale: age > config.staleAfterDays,
    illustrative: row.illustrative,
    billsAtCost: billedMinor === row.medianMinor,
    rateId: row.id,
  };
}

/** A yearly salary as an hourly figure in the smallest unit: salary / paid hours, rounded to the nearest unit. */
export const hourlyFromAnnual = (annualMinor: number, hoursPerYear: number): number => mulDiv(annualMinor, 1, hoursPerYear);

/** Checks a rate before it is stored: the figures must be whole, positive and in order; a source and a start date are mandatory. */
export function rateProblems(r: { min: unknown; median: unknown; max: unknown; source: unknown; effectiveDate: unknown }, today: string): string[] {
  const out: string[] = [];
  const whole = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
  if (!whole(r.min) || !whole(r.median) || !whole(r.max)) out.push("The minimum, median and maximum must each be a whole number above 0 (in the currency's smallest unit).");
  else if (!(r.min as number <= (r.median as number) && (r.median as number) <= (r.max as number))) out.push("The figures must be in order: minimum, then median, then maximum.");
  else if ((r.max as number) > 100_000_000) out.push("That maximum is outside the believable range.");
  const source = typeof r.source === "string" ? r.source.trim() : "";
  if (source.length < 8) out.push("Say where the figure comes from (8 or more characters): the survey, statistics table or report, and its year.");
  const date = typeof r.effectiveDate === "string" ? r.effectiveDate : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) out.push("The date it applies from must look like 2026-01-01.");
  else if (date > today) out.push("The date it applies from cannot be in the future.");
  return out;
}
