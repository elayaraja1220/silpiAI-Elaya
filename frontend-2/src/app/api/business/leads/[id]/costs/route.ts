import { NextRequest } from "next/server";

import { estimateCosts } from "@/lib/business/cost-estimate";
import { suggestRecurringItems } from "@/lib/business/cost-recurring";
import { handle, notFound } from "@/lib/business/http";
import { getCostConfig, getLead, getRateCard, getTechCatalog } from "@/lib/business/store";
import { recommendTechnology } from "@/lib/business/tech-recommend";
import { ValidationError } from "@/lib/business/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/business/leads/:id/costs[?internalBudget=NUMBER]
 * The three costs of the lead's latest quotation, kept apart: client development cost,
 * internal delivery cost and profit, and the running costs the client pays separately
 * (suggested items with unknown amounts). Read-only: nothing is saved or recalculated.
 */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const lead = getLead(id);
  if (!lead) return notFound();
  return handle("LEAD COSTS", () => {
    const quotation = lead.quotation;
    if (!quotation) throw new ValidationError("This project has no quotation yet.");
    const rates = getRateCard();
    const requirement = quotation.requirement ?? lead.requirement;
    const raw = request.nextUrl.searchParams.get("internalBudget");
    const internalBudget = raw !== null && Number.isFinite(Number(raw)) && Number(raw) > 0 ? Number(raw) : undefined;

    // The stack comes from the technology recommendation, which already respects the client's own choice.
    const recommendation = recommendTechnology(requirement, requirement.budget, getTechCatalog(), rates, { client: lead.client });
    const top = recommendation.options[0];
    const hoursWorked = lead.workLog.reduce((sum, entry) => sum + entry.hours, 0);
    const costs = estimateCosts({
      quote: quotation,
      rates,
      config: getCostConfig(),
      requirement,
      recommendation: top,
      actualHours: hoursWorked > 0 ? hoursWorked : undefined,
      internalBudget,
    });
    return { costs, suggestedRunningCosts: suggestRecurringItems(costs.technology.stackIds, requirement) };
  });
}
