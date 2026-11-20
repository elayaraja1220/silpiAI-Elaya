import { estimateCosts } from "./cost-estimate";
import { calcRecurring, suggestRecurringItems } from "./cost-recurring";
import { getCostConfig, getRateCard, getTechCatalog } from "./store";
import { recommendTechnology } from "./tech-recommend";
import type { Lead } from "./types";
import { ValidationError } from "./validate";

/**
 * Server only. The costs of a lead's latest quotation, kept apart: client development cost, internal delivery cost
 * and profit, and the running costs. Read-only. Shared by the costs route and the running-services route so the
 * two can never disagree.
 */
export function computeLeadCosts(lead: Lead, internalBudget?: number) {
  const quotation = lead.quotation;
  if (!quotation) throw new ValidationError("This project has no quotation yet.");
  const rates = getRateCard();
  const requirement = quotation.requirement ?? lead.requirement;

  // The stack comes from the technology recommendation, which already respects the client's own choice.
  const recommendation = recommendTechnology(requirement, requirement.budget, getTechCatalog(), rates, { client: lead.client });
  const top = recommendation.options[0];
  const hoursWorked = lead.workLog.reduce((sum, entry) => sum + entry.hours, 0);
  const config = getCostConfig();
  const costs = estimateCosts({
    quote: quotation,
    rates,
    config,
    requirement,
    recommendation: top,
    actualHours: hoursWorked > 0 ? hoursWorked : undefined,
    internalBudget,
  });
  // The running costs the client will pay separately, from the studio's own reference prices (unknown where none is set).
  const suggestedRunningCosts = suggestRecurringItems(costs.technology.stackIds, requirement, config.runningCosts);
  return { costs, config, suggestedRunningCosts, runningCosts: calcRecurring(suggestedRunningCosts, config) };
}
