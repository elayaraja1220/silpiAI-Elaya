import { NextRequest, NextResponse } from "next/server";

import { allowResponse, clientView } from "@/lib/business/client-view";
import { handle } from "@/lib/business/http";
import { publicRunningFor } from "@/lib/business/running-store";
import { getLeadByToken, getRateCard, settleAsClient, type ClientSettle } from "@/lib/business/store";
import { ValidationError } from "@/lib/business/validate";
import { clientDemoInfo } from "@/lib/demo/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ACTIONS: ClientSettle[] = ["agree", "include", "leave-out", "answer"];

/**
 * POST /api/client/:token/settle - { itemId, action: "agree" | "include" | "leave-out" | "answer", answer? }: the client settles one open point of their quotation.
 * Public through the secret link, like the rest of the client's page; limited per link. Returns the updated view.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  if (!getLeadByToken(token)) return NextResponse.json({ success: false, error: "This quotation link is not valid." }, { status: 404 });
  if (!allowResponse(`settle:${token}`, 40)) return NextResponse.json({ success: false, error: "Too many attempts. Please try again later or call us." }, { status: 429 });
  return handle("CLIENT SETTLE", async () => {
    const body = (await request.json()) as Record<string, unknown>;
    const itemId = typeof body.itemId === "string" ? body.itemId.slice(0, 80) : "";
    const action = ACTIONS.find((a) => a === body.action);
    if (!itemId || !action) throw new ValidationError("Choose a point and what to do with it.");
    const lead = settleAsClient(token, itemId, action, typeof body.answer === "string" ? body.answer : "");
    return { view: clientView(lead, getRateCard().business, publicRunningFor(lead.id), clientDemoInfo(lead.id)) };
  });
}
