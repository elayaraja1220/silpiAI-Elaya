import { NextRequest } from "next/server";

import { ValidationError } from "@/lib/business/validate";
import { apiHandle } from "@/server/http";
import { requireSession } from "@/server/session-auth";
import { cancelSubscription, getBilling, keepSubscription } from "@/server/subscriptions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/workspace/billing/cancel - { action: "cancel" | "keep" }. Owners and admins only. Cancelling keeps access to the end of the period. */
export async function POST(request: NextRequest) {
  const auth = requireSession(request, "billing:manage");
  if ("denied" in auth) return auth.denied;
  return apiHandle("BILLING CANCEL", async () => {
    const body = (await request.json()) as { action?: unknown };
    if (body.action !== "cancel" && body.action !== "keep") throw new ValidationError('action must be "cancel" or "keep".');
    if (body.action === "cancel") cancelSubscription({ orgId: auth.ctx.orgId });
    else keepSubscription({ orgId: auth.ctx.orgId });
    return { billing: getBilling(auth.ctx.orgId) };
  });
}
