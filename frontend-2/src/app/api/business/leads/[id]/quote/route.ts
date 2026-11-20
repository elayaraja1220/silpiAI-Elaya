import { NextRequest } from "next/server";

import { handle, notFound } from "@/lib/business/http";
import { getLead, requote, stageHistory } from "@/lib/business/store";
import { ValidationError } from "@/lib/business/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/business/leads/:id/quote - { discount } -> new quotation with current rates. */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!getLead(id)) return notFound();
  return handle("REQUOTE", async () => {
    const body = (await request.json()) as { discount?: unknown };
    const discount = Number(body.discount ?? 0);
    if (!Number.isFinite(discount) || discount < 0) throw new ValidationError("Discount must be 0 or more.");
    return { lead: requote(id, discount), history: stageHistory(id) };
  });
}
