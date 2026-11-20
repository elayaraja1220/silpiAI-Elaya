import { calcInternalCost } from "./cost-internal";
import { calcProfit, profitWarnings } from "./cost-profit";
import { calcRecurring, projectDeliveryCosts } from "./cost-recurring";
import type {
  AiUsageRecord,
  ClientDevelopmentCost,
  CostConfig,
  CostEstimate,
  RecurringCostItem,
  SecurityLevel,
  TechnologyContext,
} from "./cost-types";
import { analyseBudget } from "./cost-viability";
import { resolveNeeds, type RecommendedOption } from "./tech-recommend";
import type { Level, Scale } from "./tech-catalog";
import { activeClientIds, selectedStackIds, withDependencies } from "./tech-preference";
import type { Quote, RateCard, Requirement } from "./types";

/**
 * Cost estimation (step 3): the three costs side by side, never added together.
 *
 *   Client development cost  - the existing quotation, copied as it is (single pricing system).
 *   Internal delivery cost   - people, AI/API and infrastructure at the studio's own rates.
 *   Client running costs     - domain, hosting, subscriptions: separate bills.
 *
 * Pure. Nothing here changes a price, a scope or a saved quotation. The client's
 * budget is compared with the quotation but never changes it, and a larger budget
 * never makes the project more complex or more costly to deliver.
 */

export const DEVELOPMENT_ONLY_NOTE = "Development only. Domain, hosting and other running costs are billed separately and are not included in this total.";

export type CostEstimateInput = {
  /** The quotation's price: a quote from `buildQuote`, or a saved quotation. */
  quote: Pick<Quote, "items" | "totalHours" | "subtotal" | "discount" | "taxable" | "gst" | "roundOff" | "grandTotal" | "estimatedWeeks">;
  rates: RateCard;
  config: CostConfig;
  requirement?: Requirement;
  /** The recommended stack (step 2). Used when no stack is given explicitly. */
  recommendation?: Pick<RecommendedOption, "ids" | "maintenance">;
  /** An explicit stack of catalog ids (for example a confirmed choice). Wins over everything else. */
  stackIds?: string[];
  /** Overrides what is worked out from the requirement. */
  needs?: { scale?: Scale; security?: SecurityLevel };
  /** undefined = not provided (reported as missing); [] = none used. */
  aiUsage?: AiUsageRecord[];
  /** Hours actually worked, for example from the work log. */
  actualHours?: number;
  /** undefined = not provided. Never added to any total above. */
  recurring?: RecurringCostItem[];
  clientBudget?: number;
  internalBudget?: number;
};

function developmentCost(quote: CostEstimateInput["quote"]): ClientDevelopmentCost {
  return {
    hours: quote.totalHours,
    subtotal: quote.subtotal,
    discount: quote.discount,
    taxable: quote.taxable,
    gstMode: quote.gst.mode,
    gstRate: quote.gst.rate,
    cgst: quote.gst.cgst,
    sgst: quote.gst.sgst,
    igst: quote.gst.igst,
    gstTotal: quote.gst.total,
    roundOff: quote.roundOff,
    total: quote.grandTotal,
    note: DEVELOPMENT_ONLY_NOTE,
  };
}

/** The technology the estimate is for: an explicit stack, the recommendation, or what the client asked for. */
function technologyFor(input: CostEstimateInput): TechnologyContext {
  const needs = input.requirement ? resolveNeeds(input.requirement, input.rates, {}) : undefined;
  let stackIds: string[] = [];
  let source: TechnologyContext["source"] = "none";
  if (input.stackIds?.length) {
    stackIds = input.stackIds;
    source = "given";
  } else if (input.requirement?.selectedStack?.ids.length) {
    stackIds = selectedStackIds(input.requirement);
    source = "selected";
  } else if (input.recommendation?.ids.length) {
    stackIds = input.recommendation.ids;
    source = "recommendation";
  } else {
    const client = activeClientIds(input.requirement?.clientTech);
    if (client.length) {
      stackIds = withDependencies(client);
      source = "client";
    }
  }
  return {
    stackIds,
    source,
    scale: input.needs?.scale ?? needs?.scale ?? "small",
    security: input.needs?.security ?? needs?.security ?? "standard",
    ...(input.recommendation ? { maintenance: input.recommendation.maintenance as Level } : {}),
  };
}

export function estimateCosts(input: CostEstimateInput): CostEstimate {
  const technology = technologyFor(input);
  const recurring = calcRecurring(input.recurring, input.config);
  const internal = calcInternalCost({
    quote: input.quote,
    rates: input.rates,
    config: input.config,
    stackIds: technology.stackIds,
    scale: technology.scale,
    security: technology.security,
    aiUsage: input.aiUsage,
    actualHours: input.actualHours,
    studioProjectCosts: projectDeliveryCosts(recurring),
  });

  // A studio-paid project cost with no amount yet leaves the internal cost incomplete.
  for (const item of recurring.items) {
    if (item.payer === "studio" && item.kind === "one-time" && item.includeInDeliveryCost && item.reason === "The amount is not known yet.") {
      internal.missing.push(`The amount of the studio cost "${item.service}" is not known yet.`);
      internal.complete = false;
    }
  }

  const profit = calcProfit(input.quote.taxable, internal.total, internal.complete, input.config.minMarginPercent);
  const budget = analyseBudget({
    clientBudget: input.clientBudget ?? input.requirement?.budget,
    quoteTotal: input.quote.grandTotal,
    internalBudget: input.internalBudget,
    internalCost: internal.total,
    internalComplete: internal.complete,
    profit,
  });
  return {
    clientDevelopment: developmentCost(input.quote),
    internal,
    recurring,
    profit,
    budget,
    technology,
    warnings: profitWarnings(profit, internal),
    separate: true,
  };
}
