import { NextRequest } from "next/server";

import { addChatMessage, readChat } from "@/lib/business/chat";
import { handle, notFound } from "@/lib/business/http";
import { getRateCard, getLead } from "@/lib/business/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** GET /api/business/leads/:id/chat?after=ID - the conversation with the client (reading marks the client's messages as seen). */
export async function GET(request: NextRequest, context: Context) {
  const { id } = await context.params;
  if (!getLead(id)) return notFound();
  const after = Number(request.nextUrl.searchParams.get("after")) || 0;
  // ?peek=1 only looks (to count what is new while another tab is open); it does not mark anything as seen.
  const peek = request.nextUrl.searchParams.get("peek") === "1";
  return handle("CHAT READ", () => ({ messages: readChat(id, "team", after, !peek) }));
}

/** POST /api/business/leads/:id/chat - { text }: a reply from the team. */
export async function POST(request: NextRequest, context: Context) {
  const { id } = await context.params;
  if (!getLead(id)) return notFound();
  return handle("CHAT SEND", async () => {
    const body = (await request.json()) as { text?: unknown };
    return { message: addChatMessage(id, "team", getRateCard().business.name || "Team", body.text) };
  });
}
