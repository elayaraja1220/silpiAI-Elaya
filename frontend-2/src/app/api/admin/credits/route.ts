import { NextRequest } from "next/server";

import { requireAdmin } from "@/lib/admin-auth";
import { ValidationError } from "@/lib/business/validate";
import { addCredits, adjustCredits, getWallet, listLedger } from "@/server/credits";
import { apiHandle } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/admin/credits?orgId=... - one organization's wallet and recent ledger. Admin only. */
export async function GET(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  return apiHandle("CREDITS GET", () => {
    const orgId = request.nextUrl.searchParams.get("orgId");
    if (!orgId) throw new ValidationError("orgId is required.");
    return { wallet: getWallet(orgId), ledger: listLedger(orgId, { limit: 50 }) };
  });
}

/**
 * POST /api/admin/credits - { orgId, action: "grant" | "adjust", units | deltaUnits, idempotencyKey, note }.
 * Units are whole numbers (1 credit = 1000 units). A note is required: every change is permanent history.
 */
export async function POST(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  return apiHandle("CREDITS POST", async () => {
    const b = (await request.json()) as { orgId?: string; action?: string; units?: number; deltaUnits?: number; idempotencyKey?: string; note?: string };
    if (typeof b.orgId !== "string") throw new ValidationError("orgId is required.");
    if (b.action !== "grant" && b.action !== "adjust") throw new ValidationError('action must be "grant" or "adjust".');
    const entry =
      b.action === "grant"
        ? addCredits({ orgId: b.orgId, units: b.units as number, kind: "grant", idempotencyKey: b.idempotencyKey as string, note: b.note, createdBy: "admin" })
        : adjustCredits({ orgId: b.orgId, deltaUnits: b.deltaUnits as number, idempotencyKey: b.idempotencyKey as string, note: b.note as string, createdBy: "admin" });
    return { entry, wallet: getWallet(b.orgId) };
  });
}
