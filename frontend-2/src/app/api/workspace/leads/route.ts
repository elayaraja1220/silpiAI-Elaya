import { NextRequest, NextResponse } from "next/server";

import { requireSession } from "@/server/session-auth";
import { listLeadsForOrg } from "@/server/tenancy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/workspace/leads - the signed-in user's organization's leads, and nobody else's.
 * The organization comes from the session, never from the request, so it cannot be asked for by id.
 * A summary only: no internal costs, provider prices or notes, whatever the role.
 */
export async function GET(request: NextRequest) {
  const auth = requireSession(request, "lead:read");
  if ("denied" in auth) return auth.denied;
  const leads = listLeadsForOrg(auth.ctx.orgId).map((l) => ({
    id: l.id,
    stage: l.stage,
    client: l.client.company || l.client.name,
    title: l.requirement.title,
    quotationNumber: l.quotation?.number ?? null,
    total: l.quotation?.grandTotal ?? null,
    updatedAt: l.updatedAt,
  }));
  return NextResponse.json({ success: true, organizationId: auth.ctx.orgId, leads }, { headers: { "Cache-Control": "no-store" } });
}
