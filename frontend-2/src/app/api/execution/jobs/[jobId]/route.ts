import { NextRequest } from "next/server";

import { requireAdminOrDevStart } from "@/lib/dev-start"; // TEMP DEV: see dev-start.ts
import { run } from "@/lib/execution/http";
import { jobWithEvents } from "@/lib/execution/runner";
import { ExecError, UUID_RE } from "@/lib/execution/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/execution/jobs/:jobId?after=N - admin only. The job and its progress log after event N (private). */
export async function GET(request: NextRequest, context: { params: Promise<{ jobId: string }> }) {
  const denied = requireAdminOrDevStart(request);
  if (denied) return denied;
  const { jobId } = await context.params;
  return run("JOB", () => {
    if (!UUID_RE.test(jobId)) throw new ExecError("bad-id", "That job id is not valid.", 400);
    const after = Number(request.nextUrl.searchParams.get("after") ?? 0);
    return jobWithEvents(jobId, Number.isFinite(after) ? after : 0);
  });
}
