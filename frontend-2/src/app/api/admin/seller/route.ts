import { NextRequest } from "next/server";

import { requireAdmin } from "@/lib/admin-auth";
import { auditAdmin } from "@/server/audit";
import { apiHandle } from "@/server/http";
import { getSeller, saveSeller } from "@/server/tax";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/admin/seller - who invoices are issued by (legal name, address, tax number). Admin only. */
export async function GET(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  return apiHandle("SELLER GET", () => ({ seller: getSeller() }));
}

/** PUT /api/admin/seller - { legalName?, address?, country?, taxId?, taxIdType?, email? }. Printed on every invoice document. Admin only. */
export async function PUT(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  return apiHandle("SELLER SAVE", async () => {
    const seller = saveSeller((await request.json()) as Parameters<typeof saveSeller>[0]);
    auditAdmin(request, "seller.saved", "settings", "seller", { ...seller });
    return { seller };
  });
}
