import { NextRequest } from "next/server";

import { adminActor, requireAdmin } from "@/lib/admin-auth";
import { apiHandle } from "@/server/http";
import { requireReason, savePricingConfig } from "@/server/pricing-data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** PUT /api/admin/pricing/config - { reason, benchmark?, billing?, riskAllowanceBp?, staleAfterDays?, hoursPerYear? }. A reason is required. The before and after are written to the audit log. Admin only. */
export async function PUT(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  return apiHandle("PRICING CONFIG", async () => {
    const { reason, ...input } = (await request.json()) as Parameters<typeof savePricingConfig>[0] & { reason?: unknown };
    return { config: savePricingConfig(input, adminActor(request), requireReason(reason)) };
  });
}
