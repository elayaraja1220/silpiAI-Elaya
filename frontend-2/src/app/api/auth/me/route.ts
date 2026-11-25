import { NextRequest, NextResponse } from "next/server";

import { requireSession } from "@/server/session-auth";
import { getOrganization, organizationsOf } from "@/server/tenancy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/auth/me - who is signed in, in which organization, with what role. 401 when nobody is. */
export async function GET(request: NextRequest) {
  const auth = requireSession(request);
  if ("denied" in auth) return auth.denied;
  const { user, orgId, role } = auth.ctx;
  const org = getOrganization(orgId)!;
  return NextResponse.json(
    { success: true, user, organization: { id: org.id, name: org.name, type: org.type }, role, organizations: organizationsOf(user.id).map((o) => ({ id: o.org.id, name: o.org.name, role: o.role })) },
    { headers: { "Cache-Control": "no-store" } },
  );
}
