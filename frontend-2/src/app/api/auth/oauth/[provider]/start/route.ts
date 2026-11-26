import { NextRequest, NextResponse } from "next/server";

import { isOAuthProvider } from "@/lib/oauth-providers";
import { CLIENT_HOME } from "@/lib/client-auth";
import { safeNext } from "@/lib/safe-next";
import { publicBaseUrl } from "@/server/auth-http";
import { beginOAuth, OAUTH_COOKIE } from "@/server/oauth";
import { resolveSession, SESSION_COOKIE } from "@/server/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const back = (request: NextRequest, error: string, next: string) => {
  const to = new URL("/sign-in", request.nextUrl.origin);
  to.searchParams.set("error", error);
  to.searchParams.set("next", next);
  return NextResponse.redirect(to, 302);
};

/**
 * GET /api/auth/oauth/google|facebook/start?next=/path[&link=1] - sends the person to Google or Facebook to say yes.
 * A random one-time state is kept here and also in a short-lived cookie of this browser, so the answer can only complete the sign-in that started it.
 * With link=1 the person must already be signed in: the identity is then connected to that account instead of signing anyone in.
 */
export async function GET(request: NextRequest, context: { params: Promise<{ provider: string }> }) {
  const { provider } = await context.params;
  if (!isOAuthProvider(provider)) return NextResponse.json({ success: false, error: "Unknown sign-in method." }, { status: 404 });
  const next = safeNext(request.nextUrl.searchParams.get("next"), CLIENT_HOME);
  const base = publicBaseUrl(request);
  if (!base) return back(request, "not-configured", next);

  let linkUserId: string | undefined;
  if (request.nextUrl.searchParams.get("link") === "1") {
    const session = resolveSession(request.cookies.get(SESSION_COOKIE)?.value);
    if (!session) return NextResponse.redirect(new URL(`/sign-in?next=${encodeURIComponent(next)}`, request.nextUrl.origin), 302);
    linkUserId = session.user.id;
  }

  const begun = beginOAuth(provider, { base, next, linkUserId });
  if (!begun) return back(request, "not-configured", next);
  const response = NextResponse.redirect(begun.url, 302);
  // Lax, not Strict: the provider sends the person back from another site, and a Strict cookie would not come along.
  response.cookies.set({ name: OAUTH_COOKIE, value: begun.state, httpOnly: true, sameSite: "lax", path: "/api/auth/oauth", maxAge: 600, secure: request.nextUrl.protocol === "https:" });
  response.headers.set("Cache-Control", "no-store");
  return response;
}
