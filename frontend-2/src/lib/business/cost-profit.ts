import type { InternalCost, ProfitAndMargin } from "./cost-types";
import { formatINR } from "./pricing";

/**
 * Profit and margin (pure).
 *
 *   Gross profit   = development revenue excluding GST - internal delivery cost
 *   Gross margin % = gross profit / development revenue excluding GST x 100
 *
 * Revenue is the quotation's taxable value: GST collected for the government is
 * never revenue, and the client's running costs are never revenue or profit.
 */

const round2 = (n: number) => Math.round(n * 100) / 100;

export function calcProfit(revenueExGst: number, internalCost: number, costComplete: boolean, minMarginPercent: number | null): ProfitAndMargin {
  const revenue = round2(revenueExGst);
  const grossProfit = round2(revenue - internalCost);
  return {
    revenue,
    internalCost: round2(internalCost),
    grossProfit,
    grossMarginPercent: revenue > 0 ? round2((grossProfit / revenue) * 100) : null,
    minMarginPercent,
    provisional: !costComplete,
  };
}

/** Plain-language warnings about the profit: loss, thin margin, incomplete or assumed inputs. */
export function profitWarnings(profit: ProfitAndMargin, internal: InternalCost): string[] {
  const warnings: string[] = [];
  if (profit.internalCost > profit.revenue) {
    warnings.push(`Internal cost (${formatINR(profit.internalCost)}) is more than the development revenue excluding GST (${formatINR(profit.revenue)}): a loss of ${formatINR(-profit.grossProfit)}.`);
  } else if (profit.minMarginPercent === null) {
    warnings.push("No minimum margin target is configured, so the margin cannot be checked.");
  } else if (profit.grossMarginPercent !== null && profit.grossMarginPercent < profit.minMarginPercent) {
    warnings.push(`Gross margin ${profit.grossMarginPercent}% is below the minimum target of ${profit.minMarginPercent}%.`);
  }
  if (profit.internalCost > profit.revenue && profit.minMarginPercent === null) warnings.push("No minimum margin target is configured.");
  if (!internal.complete) {
    warnings.push(`Internal cost is incomplete (${internal.missing.length} input${internal.missing.length === 1 ? " is" : "s are"} missing), so the profit shown is higher than it will be.`);
  }
  if (internal.ai.estimatedUsd > 0) warnings.push("Part of the AI cost is estimated from token counts, not reported by the provider.");
  if (internal.human.basis === "actual-hours") warnings.push("People cost uses the hours worked at the estimated mix of roles.");
  return warnings;
}
