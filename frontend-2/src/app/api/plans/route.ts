import { NextResponse } from "next/server";

import { countryFromHeaders } from "@/lib/geo";
import { publicModels } from "@/server/ai/catalog";
import { listPlans } from "@/server/subscriptions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/plans - the public price list: the active plans as stored (prices in rupees and in US dollars), what the AI models cost in
 * credits (credit prices only: never the provider, its price or the markup), and the visitor's country when the host reports one.
 * Read-only and public by design (prices are advertised).
 */
export async function GET(request: Request) {
  return NextResponse.json({ success: true, plans: listPlans(), aiPrices: publicModels(), country: countryFromHeaders(request.headers) }, { headers: { "Cache-Control": "no-store" } });
}
