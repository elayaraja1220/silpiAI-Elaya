import { NextRequest } from "next/server";

import { auditAdmin } from "@/server/audit";
import { requireAdmin } from "@/lib/admin-auth";
import { ValidationError } from "@/lib/business/validate";
import { apiHandle } from "@/server/http";
import { listPlans, updatePlan } from "@/server/subscriptions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/admin/plans - every plan, switched off ones included. Admin only. */
export async function GET(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  return apiHandle("PLANS LIST", () => ({ plans: listPlans({ includeInactive: true }) }));
}

/** PUT /api/admin/plans - { id, ...fields to change }. Prices are whole paise; credits are whole units (1 credit = 1000). Admin only. */
export async function PUT(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  return apiHandle("PLANS UPDATE", async () => {
    const { id, ...patch } = (await request.json()) as { id?: unknown } & Record<string, unknown>;
    if (typeof id !== "string") throw new ValidationError("id is required.");
    const plan = updatePlan(id, patch);
    auditAdmin(request, "plan.updated", "plan", id, { sent: patch });
    return { plan };
  });
}
