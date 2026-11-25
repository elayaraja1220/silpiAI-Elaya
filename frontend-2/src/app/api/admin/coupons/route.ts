import { NextRequest } from "next/server";

import { auditAdmin } from "@/server/audit";
import { requireAdmin } from "@/lib/admin-auth";
import { listCoupons, saveCoupon, type CouponInput } from "@/server/coupons";
import { apiHandle } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/admin/coupons - every coupon, with how many organizations have used it. Admin only. */
export async function GET(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  return apiHandle("COUPONS LIST", () => ({ coupons: listCoupons() }));
}

/**
 * PUT /api/admin/coupons - creates a coupon, or changes the one with the same code.
 * { code, name?, percentBasisPoints | (fixedAmountMinor + fixedCurrency), duration: once | repeating | forever, durationMonths?, validFrom?, validUntil?, maxRedemptions?, planIds?, active? }
 * percentBasisPoints 2000 = 20% off. Once a coupon has been used its discount and duration cannot change; switch it off and make a new one. Admin only.
 */
export async function PUT(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  return apiHandle("COUPON SAVE", async () => {
    const coupon = saveCoupon((await request.json()) as CouponInput);
    auditAdmin(request, "coupon.saved", "coupon", coupon.code, { ...coupon });
    return { coupon };
  });
}
