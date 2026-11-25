import { NextRequest } from "next/server";

import { aiHandle } from "@/server/ai/http";
import { resumeJob, startJob } from "@/server/ai/orchestrator";
import { requireSession } from "@/server/session-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/workspace/jobs/:id/resume - continue a paused build (not-enough-credits, daily limit, interruption, error). Needs ai:use. */
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = requireSession(request, "ai:use");
  if ("denied" in auth) return auth.denied;
  const { id } = await ctx.params;
  return aiHandle("JOB RESUME", async () => {

    const job = resumeJob(auth.ctx.orgId, id);
    startJob(job.id);
    return { job };
  });
}
