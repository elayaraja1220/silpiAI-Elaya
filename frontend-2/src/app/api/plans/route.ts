import { NextResponse } from "next/server";

import { publicModels } from "@/server/ai/catalog";
import { listPlans } from "@/server/subscriptions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/plans - the public price list: the active plans, as stored, and what the AI models cost in credits (credit prices only:
 * never the provider, its price or the markup). Read-only and public by design (prices are advertised).
 */
export async function GET() {
  return NextResponse.json({ success: true, plans: listPlans(), aiPrices: publicModels() }, { headers: { "Cache-Control": "no-store" } });
}
