import { NextRequest } from "next/server";

import { handle, notFound } from "@/lib/business/http";
import { leadAnalysis } from "@/lib/business/lead-analysis";
import { getLead } from "@/lib/business/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/business/leads/:id/analysis - the requirement analysis and the estimate explained: confirmed requirements, open
 * questions by priority, proposals, module-wise effort, every version of the estimate with what changed, confidence and the
 * consistency checks. Always worked out from the saved data, never stored.
 */
export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const lead = getLead(id);
  if (!lead) return notFound();
  return handle("LEAD ANALYSIS", () => ({ analysis: leadAnalysis(lead) }));
}
