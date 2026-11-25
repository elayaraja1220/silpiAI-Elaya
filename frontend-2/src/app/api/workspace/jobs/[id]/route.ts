import { NextRequest } from "next/server";

import { aiHandle } from "@/server/ai/http";
import { getJob, getSteps } from "@/server/ai/job-store";
import { estimateRemaining, JobError, reconcileJobs } from "@/server/ai/orchestrator";
import { getWallet } from "@/server/credits";
import { requireSession } from "@/server/session-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/workspace/jobs/:id - the build, its steps, and (while it waits for approval) the most the remaining steps could cost. Any member. */
export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = requireSession(request, "lead:read");
  if ("denied" in auth) return auth.denied;
  const { id } = await ctx.params;
  return aiHandle("JOB GET", () => {
    reconcileJobs(auth.ctx.orgId);
    const job = getJob(auth.ctx.orgId, id);
    if (!job) throw new JobError("not-found", "That build does not exist.");
    const waiting = job.status === "awaiting_approval" || (job.status === "paused" && job.pauseReason === "needs_approval");
    return { job, steps: getSteps(id), estimate: waiting ? estimateRemaining(job) : null, wallet: getWallet(auth.ctx.orgId) };
  });
}
