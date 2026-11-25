import { NextRequest } from "next/server";

import { aiHandle } from "@/server/ai/http";
import { getFiles } from "@/server/ai/job-store";
import { JobError } from "@/server/ai/orchestrator";
import { requireSession } from "@/server/session-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/workspace/jobs/:id/files - the files generated so far, with their contents. Any member of the organization. */
export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = requireSession(request, "lead:read");
  if ("denied" in auth) return auth.denied;
  const { id } = await ctx.params;
  return aiHandle("JOB FILES", () => {
    const files = getFiles(auth.ctx.orgId, id);
    if (!files) throw new JobError("not-found", "That build does not exist.");
    return { files };
  });
}
