import { NextRequest, NextResponse } from "next/server";

import { requireAdmin } from "@/lib/admin-auth";
import { localAccessAllowed, PROXY_ONLY_HEADERS } from "@/lib/api-access";

/**
 * Every /api/business/* and /api/projects* route is gated here, in one place, so a route added later cannot be forgotten.
 * Rules and their one limitation: src/lib/api-access.ts. The public client routes (/api/client/[token]) are not
 * matched; they have their own secret links. Execution and demo routes already check the admin themselves.
 */
export function middleware(request: NextRequest) {
  const open = localAccessAllowed({
    host: request.headers.get("host"),
    forwardedFor: request.headers.get("x-forwarded-for"),
    proxyHeader: PROXY_ONLY_HEADERS.some((name) => request.headers.has(name)),
    env: process.env,
  });
  if (open) return NextResponse.next();
  return requireAdmin(request) ?? NextResponse.next();
}

export const config = { matcher: ["/api/business/:path*", "/api/projects", "/api/projects/:path*"], runtime: "nodejs" };
