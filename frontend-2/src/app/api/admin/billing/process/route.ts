import { NextRequest } from "next/server";

import { requireAdmin } from "@/lib/admin-auth";
import { expireCredits } from "@/server/credits";
import { apiHandle } from "@/server/http";
import { processSubscriptions } from "@/server/subscriptions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/admin/billing/process - move every subscription along as of now (renewal invoices, period ends, grace, Free renewals) and remove credits that have expired.
 * Safe to call any number of times. Nothing calls it on a timer yet: run it daily from a scheduler. Admin only.
 */
export async function POST(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  return apiHandle("BILLING PROCESS", () => ({ processed: processSubscriptions(), expired: expireCredits() }));
}
