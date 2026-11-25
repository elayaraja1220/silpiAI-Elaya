import { NextRequest } from "next/server";

import { adminActor, requireAdmin } from "@/lib/admin-auth";
import { ValidationError } from "@/lib/business/validate";
import { apiHandle } from "@/server/http";
import { getPayment, refundPayment } from "@/server/payments/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/admin/payments/refund - { paymentId, amountMinor?, reason, idempotencyKey? }. Refunds all of a payment or part of it, and takes back the credits it
 * bought as far as they are unspent. With a payment provider that can refund, the provider is asked first. Repeating a request with the same idempotencyKey
 * refunds nothing more. Admin only.
 */
export async function POST(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  return apiHandle("PAYMENT REFUND", async () => {
    const b = (await request.json()) as { paymentId?: unknown; amountMinor?: unknown; reason?: unknown; idempotencyKey?: unknown };
    if (typeof b.paymentId !== "string") throw new ValidationError("paymentId is required.");
    const refund = await refundPayment({ paymentId: b.paymentId, amountMinor: typeof b.amountMinor === "number" ? b.amountMinor : undefined, reason: String(b.reason ?? ""), requestedBy: adminActor(request), idempotencyKey: typeof b.idempotencyKey === "string" ? b.idempotencyKey : undefined });
    return { refund, payment: getPayment(b.paymentId) };
  });
}
