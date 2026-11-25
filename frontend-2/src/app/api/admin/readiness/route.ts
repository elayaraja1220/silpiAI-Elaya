import { NextRequest } from "next/server";

import { requireAdmin } from "@/lib/admin-auth";
import { apiHandle } from "@/server/http";
import { readiness } from "@/server/readiness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/admin/readiness - a checklist of what is and is not ready for real customers, with how to fix each item. Admin only. */
export async function GET(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const secure = request.nextUrl.protocol === "https:" || request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() === "https";
  return apiHandle("READINESS", () => ({ readiness: readiness({ secure }) }));
}
