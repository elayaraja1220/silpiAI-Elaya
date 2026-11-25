import { NextRequest } from "next/server";

import { aiHandle } from "@/server/ai/http";
import { listJobs } from "@/server/ai/job-store";
import { createJob, reconcileJobs, startJob } from "@/server/ai/orchestrator";
import { requireSession } from "@/server/session-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/workspace/jobs - this organization's builds, newest first. Any member. */
export async function GET(request: NextRequest) {
  const auth = requireSession(request, "lead:read");
  if ("denied" in auth) return auth.denied;
  return aiHandle("JOBS LIST", () => { reconcileJobs(auth.ctx.orgId); return { jobs: listJobs(auth.ctx.orgId) }; });
}

/**
 * POST /api/workspace/jobs - { brief, title?, quality?: economy | standard | high | demo, review?: boolean }.
 * Creates a build and starts planning in the background. The plan costs credits like any AI call; nothing more is spent until the plan is approved.
 */
export async function POST(request: NextRequest) {
  const auth = requireSession(request, "ai:use");
  if ("denied" in auth) return auth.denied;
  return aiHandle("JOB CREATE", async () => {
    const b = (await request.json()) as { brief?: unknown; title?: unknown; quality?: unknown; review?: unknown };
    const job = createJob({ orgId: auth.ctx.orgId, userId: auth.ctx.user.id, brief: b.brief, title: b.title, quality: b.quality, review: b.review === true });
    startJob(job.id);
    return { job };
  });
}
