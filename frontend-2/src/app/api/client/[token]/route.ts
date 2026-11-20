import { NextRequest, NextResponse } from "next/server";

import { allowResponse, clientView } from "@/lib/business/client-view";
import { handle } from "@/lib/business/http";
import { getLeadByToken, getRateCard, respondAsClient } from "@/lib/business/store";
import { TIERS, type Tier } from "@/lib/business/types";
import { ValidationError } from "@/lib/business/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ token: string }> };
const gone = () => NextResponse.json({ success: false, error: "This quotation link is not valid." }, { status: 404 });

/** GET /api/client/:token - the client's view of their quotation. Public. */
export async function GET(_request: NextRequest, context: Context) {
  const { token } = await context.params;
  const lead = getLeadByToken(token);
  const view = lead && clientView(lead, getRateCard().business);
  if (!view) return gone();
  return handle("CLIENT VIEW", () => ({ view }));
}

/**
 * POST /api/client/:token - { action: "approved" | "changes_requested", tier?, name, message, agree? }.
 * Public: everything is validated here; the client cannot change prices.
 */
export async function POST(request: NextRequest, context: Context) {
  const { token } = await context.params;
  if (!getLeadByToken(token)) return gone();
  if (!allowResponse(token)) {
    return NextResponse.json({ success: false, error: "Too many attempts. Please try again later or call us." }, { status: 429 });
  }
  return handle("CLIENT RESPOND", async () => {
    const body = (await request.json()) as Record<string, unknown>;
    const action = body.action === "approved" || body.action === "changes_requested" ? body.action : null;
    const name = typeof body.name === "string" ? body.name.trim().slice(0, 120) : "";
    const message = typeof body.message === "string" ? body.message.trim().slice(0, 2000) : "";
    if (!action) throw new ValidationError("Unknown action.");
    if (name.length < 2) throw new ValidationError("Please type your full name.");
    if (action === "approved" && body.agree !== true) throw new ValidationError("Please accept the payment terms to approve.");
    if (action === "changes_requested" && message.length < 5) throw new ValidationError("Tell us what you would like to change.");
    const tier = TIERS.includes(body.tier as Tier) ? (body.tier as Tier) : undefined;
    const lead = respondAsClient(token, { action, tier, name, message });
    return { view: clientView(lead, getRateCard().business) };
  });
}
