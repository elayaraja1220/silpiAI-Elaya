import { NextRequest } from "next/server";

import { apiHandle } from "@/server/http";
import { recordAudit } from "@/server/audit";
import { requireSession } from "@/server/session-auth";
import { getBillingProfile, saveBillingProfile } from "@/server/tax";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/workspace/billing/profile - who this organization's invoices are made out to. Owners and admins only. */
export async function GET(request: NextRequest) {
  const auth = requireSession(request, "billing:manage");
  if ("denied" in auth) return auth.denied;
  return apiHandle("BILLING PROFILE GET", () => ({ profile: getBillingProfile(auth.ctx.orgId) }));
}

/**
 * PUT /api/workspace/billing/profile - { legalName, country, addressLine1, addressLine2?, city, region?, postalCode?, taxId?, taxIdType? }.
 * Applies to invoices raised AFTER it is saved; invoices already raised keep the details they were raised with. Owners and admins only.
 */
export async function PUT(request: NextRequest) {
  const auth = requireSession(request, "billing:manage");
  if ("denied" in auth) return auth.denied;
  return apiHandle("BILLING PROFILE SAVE", async () => {
    const profile = saveBillingProfile(auth.ctx.orgId, (await request.json()) as Record<string, unknown>, auth.ctx.user.id);
    recordAudit({ actor: `user:${auth.ctx.user.id}`, action: "billing_profile.saved", entityType: "organization", entityId: auth.ctx.orgId, orgId: auth.ctx.orgId, detail: { country: profile.country, taxIdType: profile.taxIdType, hasTaxId: profile.taxId !== "" } });
    return { profile };
  });
}
