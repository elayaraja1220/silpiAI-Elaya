import { NextRequest } from "next/server";

import { requireAdmin } from "@/lib/admin-auth";
import { apiHandle } from "@/server/http";
import { setPlanPrice } from "@/server/subscriptions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * PUT /api/admin/plans/prices - { planId, currency, period: "monthly" | "annual", amountMinor | null }.
 * Sets, changes or removes (null) one plan's price in one currency, in that currency's smallest unit (paise, cents, pence). It affects only
 * organizations that subscribe AFTER the change: existing subscriptions keep the price they were sold at. Admin only.
 */
export async function PUT(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  return apiHandle("PLAN PRICE", async () => ({ plan: setPlanPrice((await request.json()) as Parameters<typeof setPlanPrice>[0]) }));
}
