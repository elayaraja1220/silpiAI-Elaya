import { NextRequest } from "next/server";

import { handle, notFound } from "@/lib/business/http";
import { getLead } from "@/lib/business/store";
import { leadFinancials } from "@/server/financials";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/business/leads/:id/financials - the five figures of the project's latest quotation, kept apart: A human-equivalent value, B customer price, C AI cost,
 * D infrastructure cost, E margin. Internal only: never shown to the client. Read only.
 */
export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const lead = getLead(id);
  if (!lead) return notFound();
  return handle("FINANCIALS", () => ({ financials: leadFinancials(lead) }));
}
