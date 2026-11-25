import { NextRequest } from "next/server";

import { requireAdmin } from "@/lib/admin-auth";
import { adminOverview } from "@/server/ai/catalog";
import { aiHandle } from "@/server/ai/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/admin/ai - models with their real provider prices and markup, the credit conversion, and this month's cost versus charges per organization. Admin only. */
export async function GET(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  return aiHandle("AI ADMIN", () => ({ overview: adminOverview() }));
}
