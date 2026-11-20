import { NextRequest } from "next/server";

import { requireAdminOrDevStart } from "@/lib/dev-start"; // TEMP DEV: see dev-start.ts
import { run } from "@/lib/execution/http";
import { jobsForLead } from "@/lib/execution/runner";
import { ExecError, UUID_RE } from "@/lib/execution/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/execution/leads/:id - admin only. The generation jobs of a project, newest first. */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const denied = requireAdminOrDevStart(request);
  if (denied) return denied;
  const { id } = await context.params;
  return run("LEAD JOBS", () => {
    if (!UUID_RE.test(id)) throw new ExecError("bad-id", "That project id is not valid.", 400);
    return { jobs: jobsForLead(id) };
  });
}
