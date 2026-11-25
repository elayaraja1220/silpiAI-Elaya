import { NextRequest } from "next/server";

import { adminActor, requireAdmin } from "@/lib/admin-auth";
import { ValidationError } from "@/lib/business/validate";
import { apiHandle } from "@/server/http";
import { findByNumber, recordManualPayment } from "@/server/payments/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/admin/payments/record - { number (INV-... or TOP-...) | invoiceId | topupId, reference, amountMinor? }: money received outside the system (UPI, bank transfer, cash).
 * Pays the invoice or grants the top-up credits. If amountMinor is given it must equal what was asked for. Repeating the same reference changes nothing. Admin only.
 */
export async function POST(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  return apiHandle("PAYMENT RECORD", async () => {
    const b = (await request.json()) as { invoiceId?: unknown; topupId?: unknown; number?: unknown; reference?: unknown; amountMinor?: unknown };
    if (typeof b.reference !== "string") throw new ValidationError("reference is required.");
    // The customer quotes a printed number; an id is also accepted (scripts).
    const found = b.number !== undefined ? findByNumber(b.number) : null;
    if (b.number !== undefined && !found) throw new ValidationError("No invoice or credit-pack order has that number. It looks like INV-2026-00001 or TOP-2026-00001.");
    const target = found ?? { invoiceId: typeof b.invoiceId === "string" ? b.invoiceId : undefined, topupId: typeof b.topupId === "string" ? b.topupId : undefined };
    return recordManualPayment({ invoiceId: (target as { invoiceId?: string }).invoiceId, topupId: (target as { topupId?: string }).topupId, reference: b.reference, amountMinor: typeof b.amountMinor === "number" ? b.amountMinor : undefined, actor: adminActor(request) });
  });
}
