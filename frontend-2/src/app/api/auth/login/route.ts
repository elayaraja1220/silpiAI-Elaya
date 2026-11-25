import { NextRequest, NextResponse } from "next/server";

import { allowLoginAttempt, sameSite } from "@/lib/admin-auth";
import { createSession } from "@/server/sessions";
import { sessionCookie } from "@/server/session-auth";
import { authenticate, getOrganization } from "@/server/tenancy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const json = (body: object, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

/**
 * POST /api/auth/login - { email, password }. Public by design: it is the door.
 * - Must come from this same site (stops another website signing someone in on purpose).
 * - A few attempts per ten minutes per address AND per email (held in memory: reset when the server restarts).
 * - One message for every failure, so it never says whether the email exists.
 */
export async function POST(request: NextRequest) {
  if (!sameSite(request)) return json({ success: false, error: "Cross-site request blocked." }, 403);
  let body: { email?: unknown; password?: unknown } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ success: false, error: "Request body must be JSON." }, 400);
  }
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const address = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("host") || "local";
  if (!allowLoginAttempt(`user-login-ip:${address}`) || !allowLoginAttempt(`user-login-email:${email}`)) {
    return json({ success: false, error: "Too many attempts. Try again in a few minutes." }, 429);
  }
  const user = await authenticate(email, password);
  if (!user) return json({ success: false, error: "Invalid email or password." }, 401);
  const session = createSession(user.id);
  const org = session.orgId ? getOrganization(session.orgId) : null;
  const response = json({ success: true, user: { id: user.id, email: user.email, name: user.name }, organization: org ? { id: org.id, name: org.name, type: org.type } : null });
  response.cookies.set(sessionCookie(request, session.token));
  return response;
}
