import { NEAR_BUDGET_SHARE } from "./budget";
import type { BudgetState, BudgetViability, ClientBudgetAnalysis, InternalBudgetAnalysis, ProfitAndMargin } from "./cost-types";
import { formatINR } from "./pricing";

/**
 * Budget analysis (pure): two separate budgets and whether the project makes money.
 *
 * - The client's budget is a limit on the quotation (incl. GST). Nothing is reduced to fit it.
 * - The studio's internal budget is a limit on the cost of delivery.
 * - Viability: not-viable (a loss, or the internal budget is exceeded), at-risk
 *   (thin margin, or the quotation is over the client's budget), unknown (internal
 *   cost still incomplete) or viable.
 * It never changes scope. Reducing scope stays the explicit "Use this scope" step.
 */

const round2 = (n: number) => Math.round(n * 100) / 100;

function state(budget: number, amount: number): BudgetState {
  if (!(budget > 0)) return "none";
  return amount > budget ? "over" : amount >= budget * NEAR_BUDGET_SHARE ? "near" : "within";
}

export function analyseBudget(input: {
  clientBudget?: number;
  quoteTotal: number;
  internalBudget?: number;
  internalCost: number;
  internalComplete: boolean;
  profit: ProfitAndMargin;
}): BudgetViability {
  const cb = input.clientBudget && input.clientBudget > 0 ? input.clientBudget : 0;
  const ib = input.internalBudget && input.internalBudget > 0 ? input.internalBudget : 0;
  const client: ClientBudgetAnalysis = {
    budget: cb,
    quote: input.quoteTotal,
    difference: cb ? round2(cb - input.quoteTotal) : 0,
    shortfall: cb ? round2(Math.max(0, input.quoteTotal - cb)) : 0,
    status: state(cb, input.quoteTotal),
  };
  const internal: InternalBudgetAnalysis = {
    budget: ib,
    estimatedCost: input.internalCost,
    difference: ib ? round2(ib - input.internalCost) : 0,
    shortfall: ib ? round2(Math.max(0, input.internalCost - ib)) : 0,
    status: state(ib, input.internalCost),
  };

  const { profit } = input;
  const blockers: string[] = [];
  const risks: string[] = [];
  if (profit.grossProfit < 0) blockers.push(`Internal cost is more than the development revenue: a loss of ${formatINR(-profit.grossProfit)}.`);
  if (internal.status === "over") blockers.push(`Internal cost is ${formatINR(internal.shortfall)} over the internal budget of ${formatINR(ib)}.`);
  if (profit.grossProfit >= 0 && profit.minMarginPercent !== null && profit.grossMarginPercent !== null && profit.grossMarginPercent < profit.minMarginPercent) {
    risks.push(`Gross margin ${profit.grossMarginPercent}% is below the ${profit.minMarginPercent}% target.`);
  }
  if (client.status === "over") risks.push(`The quotation is ${formatINR(client.shortfall)} over the client's budget of ${formatINR(cb)}. Prices are not reduced; agree a smaller scope or a larger budget with the client.`);

  let viability: BudgetViability["viability"];
  const reasons = [...blockers, ...risks];
  if (blockers.length) viability = "not-viable";
  else if (risks.length) viability = "at-risk";
  else if (!input.internalComplete) {
    viability = "unknown";
    reasons.push("Internal cost is incomplete, so profit cannot be confirmed yet.");
  } else {
    viability = "viable";
    reasons.push(profit.grossMarginPercent === null ? "No development revenue." : `Gross margin is ${profit.grossMarginPercent}%${profit.minMarginPercent !== null ? ` (target ${profit.minMarginPercent}%)` : ""}.`);
    if (profit.minMarginPercent === null) reasons.push("No minimum margin target is configured.");
  }
  return { client, internal, viability, reasons };
}
