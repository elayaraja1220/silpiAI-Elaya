import { NextRequest } from "next/server";

import { requireAdmin } from "@/lib/admin-auth";
import { apiHandle } from "@/server/http";
import { setPackagePrice } from "@/server/payments/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** PUT /api/admin/credit-packages/prices - { packageId, currency, amountMinor | null }: sets or removes a pack's price in one currency. Admin only. */
export async function PUT(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  return apiHandle("PACKAGE PRICE", async () => ({ package: setPackagePrice((await request.json()) as Parameters<typeof setPackagePrice>[0]) }));
}
