import { NextRequest } from "next/server";

import { requireAdmin } from "@/lib/admin-auth";
import { apiHandle } from "@/server/http";
import { pricingHistory } from "@/server/pricing-data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/admin/pricing/history - every pricing change (rates, settings, switches) with who made it, when and why, newest first. Read only; a viewer may look. */
export async function GET(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  return apiHandle("PRICING HISTORY", () => ({ history: pricingHistory(Number(request.nextUrl.searchParams.get("limit")) || 100) }));
}
