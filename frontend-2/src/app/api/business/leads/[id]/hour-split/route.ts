import { NextRequest } from "next/server";

import { handle, notFound } from "@/lib/business/http";
import { getLead } from "@/lib/business/store";
import { ValidationError } from "@/lib/business/validate";
import { decideSplit, listEstimates, suggestSplit } from "@/server/hour-split";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** GET /api/business/leads/:id/hour-split - the suggestions made for this project, newest first. */
export async function GET(_request: NextRequest, context: Context) {
  const { id } = await context.params;
  if (!getLead(id)) return notFound();
  return handle("HOUR SPLIT LIST", () => ({ estimates: listEstimates(id) }));
}

/** POST /api/business/leads/:id/hour-split - asks for a suggestion on how the hours might be shared between roles. It changes no hours and no price. */
export async function POST(_request: NextRequest, context: Context) {
  const { id } = await context.params;
  if (!getLead(id)) return notFound();
  return handle("HOUR SPLIT", async () => ({ estimate: await suggestSplit(id, "team"), estimates: listEstimates(id) }));
}

/** PUT /api/business/leads/:id/hour-split - { id, status: "accepted" | "dismissed" }. */
export async function PUT(request: NextRequest, context: Context) {
  const { id } = await context.params;
  if (!getLead(id)) return notFound();
  return handle("HOUR SPLIT DECIDE", async () => {
    const b = (await request.json()) as { id?: unknown; status?: unknown };
    if (typeof b.id !== "number" || (b.status !== "accepted" && b.status !== "dismissed")) throw new ValidationError("id and a status of accepted or dismissed are required.");
    return { estimate: decideSplit(id, b.id, b.status, "team"), estimates: listEstimates(id) };
  });
}
