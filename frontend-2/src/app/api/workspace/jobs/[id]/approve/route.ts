import { NextRequest } from "next/server";

import { aiHandle } from "@/server/ai/http";
import { approveJob, startJob } from "@/server/ai/orchestrator";
import { RATES, rateLimited } from "@/server/rate-limit";
import { requireSession } from "@/server/session-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/workspace/jobs/:id/approve - { budgetUnits? }. Sets (or raises) the budget the build may spend and runs it. Without a figure: what is spent plus the worst case of every remaining step. Needs ai:use. */
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = requireSession(request, "ai:use");
  if ("denied" in auth) return auth.denied;
  const slow = rateLimited(RATES.jobWrite, auth.ctx.orgId);
  if (slow) return slow;
  const { id } = await ctx.params;
  return aiHandle("JOB APPROVE", async () => {
    const body = (await request.json().catch(() => ({}))) as { budgetUnits?: unknown };
    const job = approveJob(auth.ctx.orgId, id, body.budgetUnits);
    startJob(job.id);
    return { job };
  });
}
