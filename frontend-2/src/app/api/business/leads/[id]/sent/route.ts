import { NextRequest } from "next/server";

import { handle, notFound } from "@/lib/business/http";
import { getLead, markSent, stageHistory } from "@/lib/business/store";
import { ValidationError } from "@/lib/business/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/business/leads/:id/sent - { channel }: note that the link was sent. */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!getLead(id)) return notFound();
  return handle("SENT", async () => {
    const { channel } = (await request.json()) as { channel?: unknown };
    if (channel !== "whatsapp" && channel !== "email") throw new ValidationError("Unknown channel.");
    return { lead: markSent(id, channel), history: stageHistory(id) };
  });
}
