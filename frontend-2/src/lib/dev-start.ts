import { NextRequest, NextResponse } from "next/server";

import { requireAdmin, sameSite } from "@/lib/admin-auth";
import { DEV_START_HEADER, DEV_START_WITHOUT_PAYMENT } from "@/lib/dev-flags";

/**
 * TEMPORARY, FOR DEVELOPMENT ONLY. Delete this file and dev-flags.ts when "Start without payment" is no longer needed.
 * Quickest off switch: set DEV_START_WITHOUT_PAYMENT to false in dev-flags.ts.
 *
 * While the switch is on, the "Start without payment" checkbox and the generation panel on a lead can prepare,
 * start and review a run without the admin token. It is limited on purpose:
 *   - only on localhost (this computer), never on a deployed host
 *   - the execution panel calls (jobs, prepare, start, review, status); settings changes stay admin-only
 *   - only from this same site, and only when the request carries the checkbox's header
 * Every other execution API still needs the admin token.
 *
 * To remove it: delete this file, restore requireAdmin in the routes that import it (search "dev-start"),
 * and delete the checkbox in proposals-panel.tsx (search "TEMP DEV").
 */

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

export function devStartAllowed(request: NextRequest): boolean {
  if (!DEV_START_WITHOUT_PAYMENT) return false;
  if (request.headers.get(DEV_START_HEADER) !== "1") return false;
  if (!LOCAL_HOST.test(request.headers.get("host") ?? "")) return false;
  const reads = request.method === "GET" || request.method === "HEAD";
  return reads || sameSite(request);
}

/** Same as requireAdmin, except the dev "Start without payment" checkbox is let through on localhost. */
export function requireAdminOrDevStart(request: NextRequest): NextResponse | null {
  return devStartAllowed(request) ? null : requireAdmin(request);
}
