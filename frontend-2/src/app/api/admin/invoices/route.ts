import { NextRequest } from "next/server";

import { requireAdmin } from "@/lib/admin-auth";
import { ValidationError } from "@/lib/business/validate";
import { apiHandle } from "@/server/http";
import { listInvoices, markInvoicePaid } from "@/server/subscriptions";

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
 * Activates the plan and grants its credits. Repeating it with the same reference changes nothing. Admin only.
 */
export async function POST(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  return apiHandle("INVOICE PAID", async () => {
    const b = (await request.json()) as { invoiceId?: unknown; providerRef?: unknown };
    if (typeof b.invoiceId !== "string" || typeof b.providerRef !== "string") throw new ValidationError("invoiceId and providerRef are required.");
    return markInvoicePaid({ invoiceId: b.invoiceId, providerRef: b.providerRef });
  });
}
