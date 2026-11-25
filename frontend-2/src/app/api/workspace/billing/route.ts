import { NextRequest } from "next/server";

import { listLedger } from "@/server/credits";
import { apiHandle } from "@/server/http";
import { requireSession } from "@/server/session-auth";
import { getBilling, listInvoices } from "@/server/subscriptions";
import { can } from "@/server/tenancy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/workspace/billing - this organization's plan, credits and (for owners and admins) invoices and credit history.
 * The organization comes from the session. Any member may see the plan and the balance.
 */
export async function GET(request: NextRequest) {
  const auth = requireSession(request);
  if ("denied" in auth) return auth.denied;
  const { orgId, role } = auth.ctx;
  return apiHandle("BILLING GET", () => {
    const manage = can(role, "billing:manage");
    return { organizationId: orgId, canManage: manage, billing: getBilling(orgId), ...(manage ? { invoices: listInvoices(orgId), ledger: listLedger(orgId, { limit: 20 }) } : {}) };
  });
}
