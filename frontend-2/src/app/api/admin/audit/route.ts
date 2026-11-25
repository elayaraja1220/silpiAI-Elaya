import { NextRequest } from "next/server";

import { requireAdmin } from "@/lib/admin-auth";
import { listAudit } from "@/server/audit";
import { apiHandle } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/admin/audit?limit=&before=&action=&orgId=&actor= - the audit trail, newest first. `action` matches a prefix (payment. finds every payment event). Admin only. */
export async function GET(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  return apiHandle("AUDIT", () => {
    const q = request.nextUrl.searchParams;
    const before = Number(q.get("before"));
    return { entries: listAudit({ limit: Number(q.get("limit") ?? 100) || 100, before: Number.isSafeInteger(before) && before > 0 ? before : undefined, action: q.get("action") || undefined, orgId: q.get("orgId") || undefined, actor: q.get("actor") || undefined }) };
  });
}
