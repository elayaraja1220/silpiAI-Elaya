import { NextRequest } from "next/server";

import { aiHandle } from "@/server/ai/http";
import { cancelJob } from "@/server/ai/orchestrator";
import { RATES, rateLimited } from "@/server/rate-limit";
import { requireSession } from "@/server/session-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/workspace/jobs/:id/cancel - stop a build. Steps that did not run are never charged. Needs ai:use. */
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = requireSession(request, "ai:use");
  if ("denied" in auth) return auth.denied;
  const slow = rateLimited(RATES.jobWrite, auth.ctx.orgId);
  if (slow) return slow;
  const { id } = await ctx.params;
  return aiHandle("JOB CANCEL", async () => {

    const job = cancelJob(auth.ctx.orgId, id);

    return { job };
  });
}
