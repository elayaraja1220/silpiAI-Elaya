import { NextRequest, NextResponse } from "next/server";

import { requireAdmin } from "@/lib/admin-auth";

/**
 * The older routes that started API-funded generation directly (no approval, no cost record, no admin check)
 * now answer with this refusal. A project is generated from an approved quotation through the execution workflow:
 * Local Claude Code by default, and the API only after a separate, recorded cost approval.
 */
export function directApiBlocked(request: NextRequest): NextResponse {
  const denied = requireAdmin(request);
  if (denied) return denied;
  return NextResponse.json(
    {
      success: false,
      code: "direct-api-disabled",
      error:
        "Direct API generation is turned off. Generate a project from an approved quotation (Clients & quotes, then Generate project): it runs on Local Claude Code by default, and the API needs its own cost approval.",
    },
    { status: 403, headers: { "Cache-Control": "no-store" } },
  );
}
