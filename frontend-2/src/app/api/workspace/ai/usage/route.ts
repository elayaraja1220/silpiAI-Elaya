import { NextRequest } from "next/server";

import { listRequests, usageSummary } from "@/server/ai/catalog";
import { aiHandle } from "@/server/ai/http";
import { getWallet } from "@/server/credits";
import { requireSession } from "@/server/session-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/workspace/ai/usage - this organization's AI use: today, this month, by model, recent requests. Any member may read it. */
export async function GET(request: NextRequest) {
  const auth = requireSession(request, "lead:read");
  if ("denied" in auth) return auth.denied;
  const { orgId } = auth.ctx;
  return aiHandle("AI USAGE", () => ({ summary: usageSummary(orgId), requests: listRequests(orgId, 30), wallet: getWallet(orgId) }));
}
