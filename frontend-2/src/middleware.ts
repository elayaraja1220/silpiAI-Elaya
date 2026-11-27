import { NextRequest, NextResponse } from "next/server";

import { adminIdentity, requireAdmin } from "@/lib/admin-auth";
import { safeNext } from "@/lib/safe-next";
import { resolveSession, SESSION_COOKIE } from "@/server/sessions";

/**
 * The studio is for administrators only, and this is the one place that says so, on the server, for every request:
 *
 *   - /api/business/*, /api/projects*  -> an administrator sign-in (cookie or token header), always. No address, host or setting opens them.
 *   - the site's address "/": the studio's Overview for an administrator; for anyone else the client sign-in page (a signed-in client: their dashboard).
 *   - the other studio pages (Overview, Clients & quotes, My projects, Existing projects, Agent activity, Business & pricing, Plans, Settings,
 *     Recurring income) -> an administrator session, otherwise a redirect to /admin/sign-in that comes back here afterwards.
 *
 * /clients/new and below it belong to the client interface (a client signs in with an account, not as an administrator); the studio's own quotation form is /clients/quote.
 * Not matched here, on purpose: /q/[token] and /api/client/[token] (a client's own secret quotation link), /ai/* and /api/workspace/* (customer
 * accounts, with their own checks), /api/admin/* and /api/execution|demo (they check the administrator themselves), the sign-in pages.
 * A route added under /api/business later is protected without anyone remembering to.
 */
export function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  if (pathname.startsWith("/api/")) return requireAdmin(request) ?? NextResponse.next();
  // The client's own pages (choose a development model). They check the client sign-in themselves and show nothing of the studio.
  if (pathname === "/clients/new" || pathname.startsWith("/clients/new/")) return NextResponse.next();
  if (adminIdentity(request)) return NextResponse.next();
  // The site's own address opens on the client sign-in page (a signed-in client goes to their dashboard). Administrators open the studio from /admin/sign-in.
  if (pathname === "/") {
    const home = request.nextUrl.clone();
    home.search = "";
    home.pathname = resolveSession(request.cookies.get(SESSION_COOKIE)?.value) ? "/client/dashboard" : "/sign-in";
    return NextResponse.redirect(home);
  }
  const to = request.nextUrl.clone();
  to.pathname = "/admin/sign-in";
  to.search = "";
  to.searchParams.set("next", safeNext(pathname + search));
  return NextResponse.redirect(to);
}

// The matcher must be a plain literal: Next.js reads it without running this file, and a computed one makes it fall back to the edge runtime.
export const config = { matcher: ["/", "/clients", "/clients/:path*", "/projects", "/existing", "/activity", "/pricing", "/plans", "/settings", "/recurring-income", "/api/business/:path*", "/api/projects", "/api/projects/:path*"], runtime: "nodejs" };
