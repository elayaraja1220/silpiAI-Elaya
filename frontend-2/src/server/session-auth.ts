import { NextRequest, NextResponse } from "next/server";

import { sameSite } from "@/lib/admin-auth";
import { resolveSession, SESSION_COOKIE, SESSION_DAYS, type SessionUser } from "./sessions";
import { can, type Permission, type Role } from "./tenancy";

/**
 * The one door for signed-in user routes (server only).
 *
 *   const auth = requireSession(request, "lead:read");
 *   if ("denied" in auth) return auth.denied;
 *   // auth.ctx.orgId is the only organization this request may touch
 *
 * 401 = not signed in. 403 = signed in but not allowed (no active organization, role lacks the permission, or a
 * cross-site request that would change something).
 */

export type RequestContext = { user: SessionUser; orgId: string; role: Role };

const refuse = (status: number, error: string) => NextResponse.json({ success: false, error }, { status, headers: { "Cache-Control": "no-store" } });

export function requireSession(request: NextRequest, permission?: Permission): { ctx: RequestContext } | { denied: NextResponse } {
  const session = resolveSession(request.cookies.get(SESSION_COOKIE)?.value);
  if (!session) return { denied: refuse(401, "Sign-in required.") };
  const reads = request.method === "GET" || request.method === "HEAD";
  if (!reads && !sameSite(request)) return { denied: refuse(403, "Cross-site request blocked.") };
  if (!session.orgId || !session.role) return { denied: refuse(403, "Your account has no active organization.") };
  if (permission && !can(session.role, permission)) return { denied: refuse(403, "Your role is not allowed to do this.") };
  return { ctx: { user: session.user, orgId: session.orgId, role: session.role } };
}

export function sessionCookie(request: NextRequest, value: string) {
  return { name: SESSION_COOKIE, value, httpOnly: true, sameSite: "strict" as const, path: "/", maxAge: value ? SESSION_DAYS * 86_400 : 0, secure: request.nextUrl.protocol === "https:" };
}
