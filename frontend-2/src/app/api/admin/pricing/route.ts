import { NextRequest } from "next/server";

import { requireAdmin } from "@/lib/admin-auth";
import { apiHandle } from "@/server/http";
import { getPricingConfig, listRates, listReference } from "@/server/pricing-data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/admin/pricing[?country=GB] - the lists, the pricing settings and every market rate ever entered (newest first), with its source. Admin only. */
export async function GET(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  return apiHandle("PRICING OVERVIEW", () => ({ reference: listReference({ includeInactive: true }), config: getPricingConfig(), rates: listRates({ country: request.nextUrl.searchParams.get("country") ?? undefined }) }));
}
