import { NextRequest } from "next/server";

import { requireAdmin } from "@/lib/admin-auth";
import { ValidationError } from "@/lib/business/validate";
import { apiHandle } from "@/server/http";
import { recordManualPayment } from "@/server/payments/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/admin/payments/record - { invoiceId | topupId, reference, amountMinor? }: money received outside the system (UPI, bank transfer, cash).
 * Pays the invoice or grants the top-up credits. If amountMinor is given it must equal what was asked for. Repeating the same reference changes nothing. Admin only.
 */
export async function POST(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  return apiHandle("PAYMENT RECORD", async () => {
    const b = (await request.json()) as { invoiceId?: unknown; topupId?: unknown; reference?: unknown; amountMinor?: unknown };
    if (typeof b.reference !== "string") throw new ValidationError("reference is required.");
    return recordManualPayment({ invoiceId: typeof b.invoiceId === "string" ? b.invoiceId : undefined, topupId: typeof b.topupId === "string" ? b.topupId : undefined, reference: b.reference, amountMinor: typeof b.amountMinor === "number" ? b.amountMinor : undefined });
  });
}
