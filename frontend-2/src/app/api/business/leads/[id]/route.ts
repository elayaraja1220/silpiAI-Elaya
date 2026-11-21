import { NextRequest } from "next/server";

import { handle, notFound } from "@/lib/business/http";
import { removeLeadFiles } from "@/lib/business/asset-store";
import { removeLeadDemos } from "@/lib/demo/service";
import { deleteLead, getLead, setStage, stageHistory } from "@/lib/business/store";
import { STAGES, type Stage } from "@/lib/business/types";
import { ValidationError } from "@/lib/business/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** GET /api/business/leads/:id - lead, latest quotation and stage history. */
export async function GET(_request: NextRequest, context: Context) {
  const { id } = await context.params;
  const lead = getLead(id);
  if (!lead) return notFound();
  return handle("LEAD GET", () => ({ lead, history: stageHistory(id) }));
}

/** PATCH /api/business/leads/:id - { stage, note? }: manual stage change (approve, lost, reopen). */
export async function PATCH(request: NextRequest, context: Context) {
  const { id } = await context.params;
  if (!getLead(id)) return notFound();
  return handle("LEAD STAGE", async () => {
    const body = (await request.json()) as { stage?: unknown; note?: unknown };
    if (!STAGES.includes(body.stage as Stage)) throw new ValidationError("Unknown stage.");
    const note = typeof body.note === "string" ? body.note.trim().slice(0, 300) : "";
    return { lead: setStage(id, body.stage as Stage, note), history: stageHistory(id) };
  });
}

/** DELETE /api/business/leads/:id - permanently removes the lead and its quotations. */
export async function DELETE(_request: NextRequest, context: Context) {
  const { id } = await context.params;
  if (!getLead(id)) return notFound();
  return handle("LEAD DELETE", () => { removeLeadDemos(id); deleteLead(id); removeLeadFiles(id); return { deleted: true }; });
}
