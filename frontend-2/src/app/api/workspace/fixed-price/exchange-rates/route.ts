import { NextRequest, NextResponse } from "next/server";

import { getLiveInrPerUnit } from "@/lib/business/live-rates";
import { requireSession } from "@/server/session-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/workspace/fixed-price/exchange-rates - rupees for one unit of each currency, so a budget typed in another currency can be shown in rupees. A signed-in client only. */
export async function GET(request: NextRequest) {
  const auth = requireSession(request, "lead:read");
  if ("denied" in auth) return auth.denied;
  return NextResponse.json({ success: true, ...(await getLiveInrPerUnit()) }, { headers: { "Cache-Control": "no-store" } });
}
