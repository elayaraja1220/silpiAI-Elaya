import { NextRequest } from "next/server";

import { requireAdmin } from "@/lib/admin-auth";
import { financeOverview } from "@/server/finance";
import { apiHandle } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/admin/finance - revenue, subscriptions, credits owed, AI cost against what customers were billed, and health checks. Never mixes currencies. Admin only. */
export async function GET(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  return apiHandle("FINANCE", () => ({ finance: financeOverview() }));
}
