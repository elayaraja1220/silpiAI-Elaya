import { NextRequest } from "next/server";

import { auditAdmin } from "@/server/audit";
import { requireAdmin } from "@/lib/admin-auth";
import { setDailyCap } from "@/server/ai/catalog";
import { aiHandle } from "@/server/ai/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** PUT /api/admin/ai/limits - { orgId, dailyCapUnits }: the most AI one organization may use per UTC day. null removes the cap, 0 blocks AI. Admin only. */
export async function PUT(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  return aiHandle("AI LIMITS", async () => {
    const body = (await request.json()) as { orgId?: unknown; dailyCapUnits?: unknown };
    const dailyCapUnits = setDailyCap(String(body.orgId ?? ""), body.dailyCapUnits === null ? null : (body.dailyCapUnits as number));
    auditAdmin("ai.daily_cap_set", "organization", String(body.orgId), { dailyCapUnits }, String(body.orgId));
    return { orgId: body.orgId, dailyCapUnits };
  });
}
