import { NextRequest, NextResponse } from "next/server";

import { ADMIN_COOKIE, adminConfigured, allowLoginAttempt, checkAdminToken, createSession, sameSite, sessionCookie, verifySession } from "@/lib/admin-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const json = (body: object, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

/** GET /api/admin/session - is admin sign-in set up, and is this browser signed in? (reveals nothing else) */
export async function GET(request: NextRequest) {
  return json({ success: true, configured: adminConfigured(), authenticated: verifySession(request.cookies.get(ADMIN_COOKIE)?.value) });
}

/** POST /api/admin/session - { token }: sign in. The secret is checked here and never stored or echoed back. */
export async function POST(request: NextRequest) {
  if (!adminConfigured()) return json({ success: false, error: "Admin sign-in is not configured. Set SILPI_ADMIN_TOKEN in frontend-2/.env.local and restart." }, 503);
  if (!sameSite(request)) return json({ success: false, error: "Cross-site request blocked." }, 403);
  const client = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("host") || "local";
  if (!allowLoginAttempt(client)) return json({ success: false, error: "Too many attempts. Try again in a few minutes." }, 429);
  let body: { token?: unknown } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ success: false, error: "Request body must be JSON." }, 400);
  }
  if (!checkAdminToken(body.token)) return json({ success: false, error: "That admin token is not correct." }, 401);
  const session = createSession();
  const response = json({ success: true, configured: true, authenticated: true });
  response.cookies.set(sessionCookie(request, session.value, session.maxAgeSeconds));
  return response;
}

/** DELETE /api/admin/session - sign out. */
export async function DELETE(request: NextRequest) {
  if (!sameSite(request)) return json({ success: false, error: "Cross-site request blocked." }, 403);
  const response = json({ success: true, configured: adminConfigured(), authenticated: false });
  response.cookies.set(sessionCookie(request, "", 0));
  return response;
}
