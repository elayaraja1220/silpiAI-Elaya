import { NextRequest } from "next/server";

import { ValidationError } from "@/lib/business/validate";
import { apiHandle } from "@/server/http";
import { cancelTopupOrder, createTopupOrder, listCreditPackages, listPayments, listTopups } from "@/server/payments/service";
import { RATES, rateLimited } from "@/server/rate-limit";
import { requireSession } from "@/server/session-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/workspace/billing/topup - the packs of credits on sale, and this organization's top-up orders and payments. Owners and admins only. */
export async function GET(request: NextRequest) {
  const auth = requireSession(request, "billing:manage");
  if ("denied" in auth) return auth.denied;
  return apiHandle("TOPUP LIST", () => ({ packages: listCreditPackages(), topups: listTopups(auth.ctx.orgId), payments: listPayments({ orgId: auth.ctx.orgId, limit: 50 }) }));
}

/**
 * POST /api/workspace/billing/topup - { packageId, currency }. Orders a pack of credits. Nothing is bought yet: the credits arrive only when the payment is
 * confirmed (a verified notice from the payment provider, or the administrator recording it). Owners and admins only.
 */
export async function POST(request: NextRequest) {
  const auth = requireSession(request, "billing:manage");
  if ("denied" in auth) return auth.denied;
  const slow = rateLimited(RATES.billingWrite, auth.ctx.orgId);
  if (slow) return slow;
  return apiHandle("TOPUP ORDER", async () => {
    const b = (await request.json()) as { packageId?: unknown; currency?: unknown };
    if (typeof b.packageId !== "string" || typeof b.currency !== "string") throw new ValidationError("packageId and currency are required.");
    return createTopupOrder({ orgId: auth.ctx.orgId, packageId: b.packageId, currency: b.currency, createdBy: auth.ctx.user.id });
  });
}

/** DELETE /api/workspace/billing/topup?id=... - cancels an unpaid order. A paid order is refunded instead. Owners and admins only. */
export async function DELETE(request: NextRequest) {
  const auth = requireSession(request, "billing:manage");
  if ("denied" in auth) return auth.denied;
  const slow = rateLimited(RATES.billingWrite, auth.ctx.orgId);
  if (slow) return slow;
  return apiHandle("TOPUP CANCEL", () => {
    const id = request.nextUrl.searchParams.get("id");
    if (!id) throw new ValidationError("id is required.");
    return { topup: cancelTopupOrder({ orgId: auth.ctx.orgId, topupId: id }) };
  });
}
