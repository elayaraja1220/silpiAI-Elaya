import { NextResponse } from "next/server";

import { listPlans } from "@/server/subscriptions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/plans - the public price list: the active plans, as stored. Read-only and public by design (prices are advertised). */
export async function GET() {
  return NextResponse.json({ success: true, plans: listPlans() }, { headers: { "Cache-Control": "no-store" } });
}
