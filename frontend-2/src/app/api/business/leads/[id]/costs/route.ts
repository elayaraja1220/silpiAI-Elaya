import { NextRequest } from "next/server";

import { handle, notFound } from "@/lib/business/http";
import { computeLeadCosts } from "@/lib/business/lead-costs";
import { getLead } from "@/lib/business/store";

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
    const raw = request.nextUrl.searchParams.get("internalBudget");
    const internalBudget = raw !== null && Number.isFinite(Number(raw)) && Number(raw) > 0 ? Number(raw) : undefined;
    return computeLeadCosts(lead, internalBudget);
  });
}
