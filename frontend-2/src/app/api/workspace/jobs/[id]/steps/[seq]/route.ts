import { NextRequest } from "next/server";

import { aiHandle } from "@/server/ai/http";
import { getJob, getStepOutput } from "@/server/ai/job-store";
import { JobError } from "@/server/ai/orchestrator";
import { requireSession } from "@/server/session-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/workspace/jobs/:id/steps/:seq - the saved output of one step (the plan or the review). Any member of the organization. */
export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string; seq: string }> }) {
  const auth = requireSession(request, "lead:read");
  if ("denied" in auth) return auth.denied;
  const { id, seq } = await ctx.params;
  return aiHandle("JOB STEP", () => {
    if (!getJob(auth.ctx.orgId, id) || !/^\d{1,4}$/.test(seq)) throw new JobError("not-found", "That step does not exist.");
    return { output: getStepOutput(id, Number(seq)) };
  });
}
