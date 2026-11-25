import { NextRequest, NextResponse } from "next/server";

import { WebhookError } from "@/server/payments/provider";
import { ingestWebhook } from "@/server/payments/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY = 256 * 1024;

/**
 * POST /api/webhooks/:provider - the payment provider's notices (a payment arrived, failed, was refunded, was disputed).
 *
 * This address is public: the provider is not signed in. The ONLY thing that makes a notice believable is its signature, checked by the provider's adapter
 * against the raw body and a secret only the provider and this server know. A notice with no valid signature changes nothing. A provider that is not set up
 * answers "not found", so with no provider connected this address does nothing at all.
 */
export async function POST(request: NextRequest, ctx: { params: Promise<{ provider: string }> }) {
  const { provider } = await ctx.params;
  const raw = await request.text();
  if (raw.length > MAX_BODY) return NextResponse.json({ success: false, error: "The notice is too large." }, { status: 413 });
  const headers: Record<string, string> = {};
  request.headers.forEach((value, name) => { headers[name.toLowerCase()] = value; });
  try {
    return NextResponse.json({ success: true, ...ingestWebhook(provider, raw, headers) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof WebhookError) return NextResponse.json({ success: false, error: error.message }, { status: error.status, headers: { "Cache-Control": "no-store" } });
    console.error("SILPI WEBHOOK ERROR:", error);
    return NextResponse.json({ success: false, error: "The notice could not be processed. Please send it again." }, { status: 500 });
  }
}
