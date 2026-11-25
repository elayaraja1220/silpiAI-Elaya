import { NextRequest, NextResponse } from "next/server";

import { ADMIN_COOKIE, adminConfigured, adminIdentity, allowLoginAttempt, checkAdminToken, createSession, sameSite, sessionCookie } from "@/lib/admin-auth";
import { authenticateAdmin } from "@/server/admin-accounts";
import { recordAudit } from "@/server/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const json = (body: object, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

/** GET /api/admin/session - is admin sign-in set up, and who (if anyone) is signed in in this browser? (reveals nothing else) */
export async function GET(request: NextRequest) {
  const who = adminIdentity(request);
  return json({ success: true, configured: adminConfigured(), authenticated: who !== null, ...(who ? { identity: { name: who.name, role: who.role, actor: who.actor } } : {}) });
}

/**
 * POST /api/admin/session - sign in with { token } (the administrator token) or { email, password } (a named administrator account).
 * The secret is checked here and never stored or echoed back. Attempts are limited per client address and, for accounts, per email.
 */
export async function POST(request: NextRequest) {
  if (!adminConfigured()) return json({ success: false, error: "Admin sign-in is not configured. Set SILPI_ADMIN_TOKEN in frontend-2/.env.local and restart." }, 503);
  if (!sameSite(request)) return json({ success: false, error: "Cross-site request blocked." }, 403);
  const client = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("host") || "local";
  if (!allowLoginAttempt(client)) return json({ success: false, error: "Too many attempts. Try again in a few minutes." }, 429);
  let body: { token?: unknown; email?: unknown; password?: unknown } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ success: false, error: "Request body must be JSON." }, 400);
  }
  let accountId: string | undefined;
  let actor = "admin";
  if (typeof body.email === "string" && body.email !== "") {
    // Several tries against one account are limited even when they come from many addresses.
    if (!allowLoginAttempt(`account:${body.email.trim().toLowerCase()}`, Date.now(), 10)) return json({ success: false, error: "Too many attempts. Try again in a few minutes." }, 429);
    const account = await authenticateAdmin(body.email, body.password);
    if (!account) {
      recordAudit({ actor: "anonymous", action: "admin.sign_in_failed", entityType: "session", entityId: "account", detail: { method: "password" } });
      return json({ success: false, error: "That email or password is not correct." }, 401);
    }
    accountId = account.id;
    actor = `admin:${account.email}`;
  } else if (!checkAdminToken(body.token)) {
    recordAudit({ actor: "anonymous", action: "admin.sign_in_failed", entityType: "session", entityId: "token", detail: { method: "token" } });
    return json({ success: false, error: "That admin token is not correct." }, 401);
  }
  recordAudit({ actor, action: "admin.signed_in", entityType: "session", entityId: accountId ?? "admin", detail: { method: accountId ? "password" : "token" } });
  const session = createSession(Date.now(), accountId);
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
