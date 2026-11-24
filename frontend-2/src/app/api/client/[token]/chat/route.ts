import { NextRequest, NextResponse } from "next/server";

import { addChatMessage, readChat } from "@/lib/business/chat";
import { allowResponse } from "@/lib/business/client-view";
import { handle } from "@/lib/business/http";
import { getLeadByToken } from "@/lib/business/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ token: string }> };
const gone = () => NextResponse.json({ success: false, error: "This quotation link is not valid." }, { status: 404 });

/** GET /api/client/:token/chat?after=ID - the conversation (only the messages after ID when given). Public, by the private link. */
export async function GET(request: NextRequest, context: Context) {
  const { token } = await context.params;
  const lead = getLeadByToken(token);
  if (!lead) return gone();
  const after = Number(request.nextUrl.searchParams.get("after")) || 0;
  const peek = request.nextUrl.searchParams.get("peek") === "1";
  return handle("CLIENT CHAT READ", () => ({ messages: readChat(lead.id, "client", after, !peek) }));
}

/** POST /api/client/:token/chat - { text }. The client writes as themselves; the name comes from the quotation, never from the browser. */
export async function POST(request: NextRequest, context: Context) {
  const { token } = await context.params;
  const lead = getLeadByToken(token);
  if (!lead) return gone();
  if (!allowResponse(`chat:${token}`, 30, 10 * 60 * 1000)) {
    return NextResponse.json({ success: false, error: "You are sending messages very fast. Please wait a few minutes." }, { status: 429 });
  }
  return handle("CLIENT CHAT SEND", async () => {
    const body = (await request.json()) as { text?: unknown };
    const message = addChatMessage(lead.id, "client", lead.client.name || "Client", body.text);
    return { message };
  });
}
