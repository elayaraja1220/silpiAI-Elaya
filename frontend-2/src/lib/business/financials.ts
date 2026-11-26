// The five money figures of a project, kept apart. Nothing here prices anything: it only reads figures that already exist and shows them side by side.
//
//   A  human-equivalent value  what the same work would cost if people were hired at verified market rates (market median x hours by role). A benchmark, never a price.
//   B  customer price          what the quotation charges (the rate card or market-rate engine decided it, never A).
//   C  AI cost                 what AI services cost to deliver the project (records the team entered or the provider reported).
//   D  infrastructure cost     servers, build and test infrastructure for the project (from the studio's own configuration).
//   E  margin                  the only column that is a RESULT: B (without GST) less the internal delivery cost (people + C + D). It never uses A.
//
// A is not used to work out B, C, D or E, and B, C and D are not worked out from each other. Where a figure is missing it is shown as missing, never guessed.
import { ANY_ROLE, type Resolved } from "./market-rates";
import { minorDigits } from "./countries";
import { SPLIT_LABELS, type SplitLine, type SplitRole } from "./hour-split";
import type { CostEstimate } from "./cost-types";
import type { Quotation } from "./types";

export type ValueLine = { roleId: string; label: string; hours: number; matchedRole: string | null; medianMinor: number | null; minMinor: number | null; maxMinor: number | null; valueMinor: number | null };

export type HumanEquivalent = {
  status: "ok" | "incomplete" | "unavailable";
  currency: string | null;
  /** The median figure and the range, in the smallest unit of `currency`. Only the lines with a verified rate are included. */
  valueMinor: number | null;
  rangeMinor: { min: number; max: number } | null;
  /** The same figure in rupees, when it can be converted with the rate the quotation already carries. */
  inr: number | null;
  lines: ValueLine[];
  basis: string[];
};

export type Financials = {
  a: HumanEquivalent;
  b: { totalInr: number; taxableInr: number; gstInr: number; currency: string; inrPerUnit: number };
  c: { provided: boolean; totalInr: number | null; actualUsd: number; estimatedUsd: number; records: number };
  d: { configured: boolean; totalInr: number };
  e: { revenueInr: number; internalCostInr: number; peopleCostInr: number; grossProfitInr: number; marginPercent: number | null; minMarginPercent: number | null; provisional: boolean };
  /** Things to know before relying on a figure, in plain words. */
  warnings: string[];
  /** The rules that keep the five apart, shown with the report. */
  rules: string[];
};

export const SEPARATION_RULES = [
  "A is a market benchmark: what hiring people for these hours would cost. It is never used to work out the price, the AI cost, the infrastructure cost or the margin.",
  "B is the price on the quotation, from the rate card or the verified market rate. It does not come from A, C or D.",
  "C and D are costs of delivering the project, from the records and settings you keep. They are not worked out from the price or from each other.",
  "E is the only figure that is a result: the price without GST less the internal delivery cost. It is provisional while any cost is missing.",
];

export type ValueInput = {
  /** Hours by role: an accepted split, or null when there is none (then all hours are valued at the any-role rate). */
  split: SplitLine[] | null;
  totalHours: number;
  /** The verified market rate for a role (with the country and level already chosen), or a refusal. */
  rateOf: (roleId: string) => Resolved;
  country: string | null;
  levelId: string;
  levelAssumed: boolean;
  /** Rupees per unit of the quotation's currency, and which currency that is, for converting A into rupees. */
  quoteCurrency: string;
  inrPerUnit: number;
};

/** A: hours by role x the market median for that role, country and level. Missing rates are listed, never filled in. */
export function humanEquivalent(input: ValueInput): HumanEquivalent {
  const basis: string[] = [];
  if (!input.country) return { status: "unavailable", currency: null, valueMinor: null, rangeMinor: null, inr: null, lines: [], basis: ["The client's country is not known, so no market rate can be chosen."] };
  if (!(input.totalHours > 0)) return { status: "unavailable", currency: null, valueMinor: null, rangeMinor: null, inr: null, lines: [], basis: ["The quotation has no hours."] };
  const hours: { roleId: string; hours: number }[] = input.split && input.split.length ? input.split : [{ roleId: ANY_ROLE, hours: input.totalHours }];
  basis.push(input.split && input.split.length ? "Hours by role come from the accepted hour split." : "No hour split has been accepted: all hours are valued at the any-role rate.");
  basis.push(`Country ${input.country}, level ${input.levelId}${input.levelAssumed ? " (assumed: the quotation names none)" : ""}.`);

  let currency: string | null = null;
  const lines: ValueLine[] = hours.map((h) => {
    const label = h.roleId === ANY_ROLE ? "Any software role" : SPLIT_LABELS[h.roleId as SplitRole] ?? h.roleId;
    const r = input.rateOf(h.roleId);
    if (!r.ok) return { roleId: h.roleId, label, hours: h.hours, matchedRole: null, medianMinor: null, minMinor: null, maxMinor: null, valueMinor: null };
    currency = currency ?? r.currency;
    const times = (minor: number) => Math.round(minor * h.hours);
    return { roleId: h.roleId, label, hours: h.hours, matchedRole: r.matchedRole, medianMinor: r.medianMinor, minMinor: r.minMinor, maxMinor: r.maxMinor, valueMinor: times(r.medianMinor) };
  });
  const rated = lines.filter((l) => l.valueMinor !== null);
  if (rated.length === 0) return { status: "unavailable", currency: null, valueMinor: null, rangeMinor: null, inr: null, lines, basis: [...basis, "There is no verified market rate for any of these roles in this country and level."] };
  const missing = lines.filter((l) => l.valueMinor === null).map((l) => l.label);
  if (missing.length) basis.push(`No verified market rate for: ${missing.join(", ")}. They are left out, so this figure is understated.`);
  const sum = (pick: (l: ValueLine) => number | null) => rated.reduce((a, l) => a + Math.round((pick(l) ?? 0) * l.hours), 0);
  const valueMinor = sum((l) => l.medianMinor);
  const rangeMinor = { min: sum((l) => l.minMinor), max: sum((l) => l.maxMinor) };
  const digits = minorDigits(currency ?? "INR");
  let inr: number | null = null;
  if (currency === "INR") inr = valueMinor / 10 ** digits;
  else if (currency && currency === input.quoteCurrency && input.inrPerUnit > 0) inr = Math.round((valueMinor / 10 ** digits) * input.inrPerUnit * 100) / 100;
  else basis.push(`Shown in ${currency}: it is not converted to rupees because the quotation is not in ${currency}.`);
  return { status: missing.length ? "incomplete" : "ok", currency, valueMinor, rangeMinor, inr, lines, basis };
}

/** Puts the five together. `costs` is the existing cost estimate of the latest quotation: B, C, D and E are read from it, not recomputed. */
export function assembleFinancials(q: Pick<Quotation, "grandTotal" | "taxable" | "gst" | "currency" | "inrPerUnit">, costs: CostEstimate, a: HumanEquivalent): Financials {
  const internal = costs.internal;
  const profit = costs.profit;
  const warnings: string[] = [];
  if (a.status === "unavailable") warnings.push(`A is unavailable: ${a.basis[a.basis.length - 1]}`);
  if (a.status === "incomplete") warnings.push("A is understated: some roles have no verified market rate.");
  if (!internal.ai.provided) warnings.push("C is not recorded yet: no AI cost has been entered for this project, so it counts as nothing.");
  else if (internal.ai.totalInr === null) warnings.push("C has costs in dollars but no exchange rate is set, so it is not in rupees.");
  if (!internal.infrastructure.configured) warnings.push("D is not set up: no infrastructure cost is configured.");
  if (profit.provisional) warnings.push("E is provisional: some internal costs are missing, so the margin is overstated.");
  if (profit.grossProfit < 0) warnings.push("E is a loss: the internal cost is more than the price without GST.");
  return {
    a,
    b: { totalInr: q.grandTotal, taxableInr: q.taxable, gstInr: q.gst.total, currency: q.currency ?? "INR", inrPerUnit: q.inrPerUnit ?? 1 },
    c: { provided: internal.ai.provided, totalInr: internal.ai.totalInr, actualUsd: internal.ai.actualUsd, estimatedUsd: internal.ai.estimatedUsd, records: internal.ai.records.length },
    d: { configured: internal.infrastructure.configured, totalInr: internal.infrastructure.total },
    e: { revenueInr: profit.revenue, internalCostInr: profit.internalCost, peopleCostInr: internal.human.knownCost, grossProfitInr: profit.grossProfit, marginPercent: profit.grossMarginPercent, minMarginPercent: profit.minMarginPercent, provisional: profit.provisional },
    warnings,
    rules: SEPARATION_RULES,
  };
}
