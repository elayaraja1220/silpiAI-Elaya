import { NextRequest } from "next/server";

import { adminActor, requireAdmin } from "@/lib/admin-auth";
import { ValidationError } from "@/lib/business/validate";
import { apiHandle } from "@/server/http";
import { recordManualPayment } from "@/server/payments/service";
import { getInvoice, getSubscription, listInvoices } from "@/server/subscriptions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/admin/invoices?orgId=... - one organization's subscription invoices. Admin only. */
export async function GET(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  return apiHandle("INVOICES GET", () => {
    const orgId = request.nextUrl.searchParams.get("orgId");
    if (!orgId) throw new ValidationError("orgId is required.");
    return { invoices: listInvoices(orgId) };
  });
}

/**
 * POST /api/admin/invoices - { invoiceId, providerRef }: record that the money arrived (UPI / bank reference).
 * Records the payment, activates the plan and grants its credits. Repeating it with the same reference changes nothing. Admin only.
 * (The same as POST /api/admin/payments/record for an invoice; kept for the existing screens.)
 */
export async function POST(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  return apiHandle("INVOICE PAID", async () => {
    const b = (await request.json()) as { invoiceId?: unknown; providerRef?: unknown };
    if (typeof b.invoiceId !== "string" || typeof b.providerRef !== "string") throw new ValidationError("invoiceId and providerRef are required.");
    const { payment } = recordManualPayment({ invoiceId: b.invoiceId, reference: b.providerRef, actor: adminActor(request) });
    const invoice = getInvoice(b.invoiceId)!;
    return { invoice, subscription: getSubscription(invoice.subscriptionId)!, payment };
  });
}
