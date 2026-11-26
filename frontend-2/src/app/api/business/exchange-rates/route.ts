import { NextResponse } from "next/server";

import { getLiveInrPerUnit } from "@/lib/business/live-rates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/business/exchange-rates - rupees for one unit of each currency.
 * Asks a free public rate service (no key, and nothing about the client or the project is sent). If it cannot be reached the
 * approximate table is returned and says so, so the screen never claims a live rate it does not have.
 */
export async function GET() {
  return NextResponse.json({ success: true, ...(await getLiveInrPerUnit()) });
}
