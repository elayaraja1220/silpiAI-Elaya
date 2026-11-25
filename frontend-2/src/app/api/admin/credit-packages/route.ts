import { NextRequest } from "next/server";

import { auditAdmin } from "@/server/audit";
import { requireAdmin } from "@/lib/admin-auth";
import { apiHandle } from "@/server/http";
import { listCreditPackages, saveCreditPackage } from "@/server/payments/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/admin/credit-packages - every pack of credits on sale (or not), with its prices. Admin only. */
export async function GET(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  return apiHandle("PACKAGES LIST", () => ({ packages: listCreditPackages({ includeInactive: true }) }));
}

/** PUT /api/admin/credit-packages - { id, name?, credits?, active?, sortOrder? }: creates a pack or changes one. Orders already made keep what they were made at. Admin only. */
export async function PUT(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  return apiHandle("PACKAGE SAVE", async () => {
    const input = (await request.json()) as Parameters<typeof saveCreditPackage>[0];
    const pack = saveCreditPackage(input);
    auditAdmin("credit_package.saved", "credit_package", pack.id, { sent: input });
    return { package: pack };
  });
}
