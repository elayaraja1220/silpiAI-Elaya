import { NextRequest } from "next/server";

import { ValidationError } from "@/lib/business/validate";
import { apiHandle } from "@/server/http";
import { RATES, rateLimited } from "@/server/rate-limit";
import { requireSession } from "@/server/session-auth";
import { changePlan, getBilling, startSubscription, type Period } from "@/server/subscriptions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/workspace/billing/plan - { planId, period?, currency?, couponCode? }. Owners and admins only.
 * Starts the first subscription, or changes the plan. A paid plan answers with an open invoice: it becomes active when the
 * payment is recorded. Nothing is charged by this call.
 */
export async function POST(request: NextRequest) {
  const auth = requireSession(request, "billing:manage");
  if ("denied" in auth) return auth.denied;
  const slow = rateLimited(RATES.billingWrite, auth.ctx.orgId);
  if (slow) return slow;
  return apiHandle("BILLING PLAN", async () => {
    const body = (await request.json()) as { planId?: unknown; period?: unknown; currency?: unknown; couponCode?: unknown };
    if (typeof body.planId !== "string") throw new ValidationError("planId is required.");
    const period = body.period === undefined ? undefined : (body.period as Period);
    const currency = body.currency === undefined ? undefined : String(body.currency);
    const couponCode = body.couponCode === undefined || body.couponCode === "" ? undefined : String(body.couponCode);
    const current = getBilling(auth.ctx.orgId);
    const result =
      current.running || current.pending
        ? changePlan({ orgId: auth.ctx.orgId, planId: body.planId, period, currency, couponCode })
        : { kind: "started" as const, ...startSubscription({ orgId: auth.ctx.orgId, planId: body.planId, period, currency, couponCode }) };
    return { result, billing: getBilling(auth.ctx.orgId) };
  });
}
