import { NextRequest } from "next/server";

import { requireAdmin } from "@/lib/admin-auth";
import { apiHandle } from "@/server/http";
import { listPayments, listRefunds } from "@/server/payments/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/admin/payments?orgId=&status=&limit= - payments, newest first, each with its refunds. Admin only. */
export async function GET(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  return apiHandle("PAYMENTS LIST", () => {
    const q = request.nextUrl.searchParams;
    const payments = listPayments({ orgId: q.get("orgId") ?? undefined, status: q.get("status") ?? undefined, limit: Number(q.get("limit") ?? 50) || 50 });
    return { payments: payments.map((p) => ({ ...p, refunds: listRefunds(p.id) })) };
  });
}
