import { NextRequest } from "next/server";

import { directApiBlocked } from "@/lib/execution/direct-api-blocked";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * This route used to start API-funded generation directly. It no longer does: generation goes through the
 * execution workflow (/api/execution/*), where Local Claude Code is the default and the API needs its own approval.
 */
export async function POST(request: NextRequest) {
  return directApiBlocked(request);
}
