import { NextRequest, NextResponse } from "next/server";

import { sameSite } from "@/lib/admin-auth";
import { destroySession, SESSION_COOKIE } from "@/server/sessions";
import { sessionCookie } from "@/server/session-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/auth/logout - ends this browser's session on the server (not just the cookie). Safe to call when signed out. */
export async function POST(request: NextRequest) {
  if (!sameSite(request)) return NextResponse.json({ success: false, error: "Cross-site request blocked." }, { status: 403, headers: { "Cache-Control": "no-store" } });
  destroySession(request.cookies.get(SESSION_COOKIE)?.value);
  const response = NextResponse.json({ success: true }, { headers: { "Cache-Control": "no-store" } });
  response.cookies.set(sessionCookie(request, ""));
  return response;
}
