import { NextRequest } from "next/server";

import { handleAnalyze } from "@/lib/business/analyze-request";
import { clientAddress, rateLimited, RATES } from "@/server/rate-limit";
import { requireSession } from "@/server/session-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * POST /api/workspace/fixed-price/analyze (multipart: files[], notes, manifest) - the client's own document analysis, the same reading the studio uses.
 * Signed-in clients only, a few an hour per workspace (it uses the studio's AI), never a forced re-read, and the answer carries no model or cost.
 */
export async function POST(request: NextRequest) {
  const auth = requireSession(request, "lead:write");
  if ("denied" in auth) return auth.denied;
  const limited = rateLimited(RATES.clientAnalyze, auth.ctx.orgId) ?? rateLimited(RATES.clientAnalyze, `ip:${clientAddress(request)}`);
  if (limited) return limited;
  return handleAnalyze(request, { hideCost: true, allowFresh: false });
}
