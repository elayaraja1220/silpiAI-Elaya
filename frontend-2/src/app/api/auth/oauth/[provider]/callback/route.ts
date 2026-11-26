import { NextRequest, NextResponse } from "next/server";

import { isOAuthProvider } from "@/lib/oauth-providers";
import { publicBaseUrl } from "@/server/auth-http";
import { finishOAuth, OAUTH_COOKIE } from "@/server/oauth";
import { sessionCookie } from "@/server/session-auth";
import { createSession } from "@/server/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/auth/oauth/google|facebook/callback?code=...&state=... - where the provider sends the person back.
 * Nothing in this address is trusted: the state must match the cookie of this browser and a record that works once, and the destination comes from that record.
 * On any failure the person lands on the sign-in page with a short error code (never text from the address).
 */
export async function GET(request: NextRequest, context: { params: Promise<{ provider: string }> }) {
  const { provider } = await context.params;
  if (!isOAuthProvider(provider)) return NextResponse.json({ success: false, error: "Unknown sign-in method." }, { status: 404 });
  const q = request.nextUrl.searchParams;
  const base = publicBaseUrl(request);
  const finish = (to: URL, setSession?: string) => {
    const response = NextResponse.redirect(to, 302);
    response.cookies.set({ name: OAUTH_COOKIE, value: "", httpOnly: true, sameSite: "lax", path: "/api/auth/oauth", maxAge: 0, secure: request.nextUrl.protocol === "https:" });
    if (setSession) response.cookies.set(sessionCookie(request, setSession));
    response.headers.set("Cache-Control", "no-store");
    return response;
  };
  const failed = (code: string, next: string) => {
    const to = new URL("/sign-in", request.nextUrl.origin);
    to.searchParams.set("error", code);
    to.searchParams.set("next", next);
    return finish(to);
  };
  if (!base) return failed("not-configured", "/");

  const result = await finishOAuth(provider, { code: q.get("code"), state: q.get("state"), cookieState: request.cookies.get(OAUTH_COOKIE)?.value ?? null, providerError: q.get("error"), base });
  if (!result.ok) return failed(result.code, result.next);
  const to = new URL(result.next, request.nextUrl.origin);
  // Connecting an identity to someone already signed in changes nothing about their session; a sign-in starts one.
  return finish(to, result.linked ? undefined : createSession(result.userId).token);
}
