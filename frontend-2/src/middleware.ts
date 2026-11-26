import { NextRequest, NextResponse } from "next/server";

import { adminIdentity, requireAdmin } from "@/lib/admin-auth";
import { safeNext } from "@/lib/safe-next";

/**
 * The studio is for administrators only, and this is the one place that says so, on the server, for every request:
 *
 *   - /api/business/*, /api/projects*  -> an administrator sign-in (cookie or token header), always. No address, host or setting opens them.
 *   - the studio pages (Overview, Clients & quotes, My projects, Existing projects, Agent activity, Business & pricing, Plans, Settings,
 *     Recurring income) -> an administrator session, otherwise a redirect to /admin/sign-in that comes back here afterwards.
 *
 * Not matched here, on purpose: /q/[token] and /api/client/[token] (a client's own secret quotation link), /ai/* and /api/workspace/* (customer
 * accounts, with their own checks), /api/admin/* and /api/execution|demo (they check the administrator themselves), the sign-in pages.
 * A route added under /api/business later is protected without anyone remembering to.
 */
export function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  if (pathname.startsWith("/api/")) return requireAdmin(request) ?? NextResponse.next();
  if (adminIdentity(request)) return NextResponse.next();
  const to = request.nextUrl.clone();
  to.pathname = "/admin/sign-in";
  to.search = "";
  to.searchParams.set("next", safeNext(pathname + search));
  return NextResponse.redirect(to);
}

// The matcher must be a plain literal: Next.js reads it without running this file, and a computed one makes it fall back to the edge runtime.
export const config = { matcher: ["/", "/clients", "/clients/:path*", "/projects", "/existing", "/activity", "/pricing", "/plans", "/settings", "/recurring-income", "/api/business/:path*", "/api/projects", "/api/projects/:path*"], runtime: "nodejs" };
