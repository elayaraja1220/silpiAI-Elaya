import { NextRequest } from "next/server";

import { handle, notFound } from "@/lib/business/http";
import { INSIGHT_DECISIONS, type InsightDecision } from "@/lib/business/clarifications";
import { leadAnalysis } from "@/lib/business/lead-analysis";
import { decideInsight, getLead, stageHistory } from "@/lib/business/store";
import { ValidationError } from "@/lib/business/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * PATCH /api/business/leads/:id/insights - { itemId, decision: "accept" | "reject" | "clarify" | "reset" }.
 * The team decides on a requirement the AI proposed (or an assumption it made). Accepting one that maps to a feature adds the
 * feature and prices the quotation again as a new version.
 */
export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!getLead(id)) return notFound();
  return handle("LEAD INSIGHT DECISION", async () => {
    const body = (await request.json()) as { itemId?: unknown; decision?: unknown };
    if (typeof body.itemId !== "string" || !body.itemId) throw new ValidationError("Choose an item.");
    if (!INSIGHT_DECISIONS.includes(body.decision as InsightDecision)) throw new ValidationError("Unknown decision.");
    const lead = decideInsight(id, body.itemId, body.decision as InsightDecision);
    return {
      lead,
      history: stageHistory(id),
      analysis: leadAnalysis(lead),
    };
  });
}
