import { NextRequest } from "next/server";

import { requireAdminOrDevStart } from "@/lib/dev-start"; // TEMP DEV: see dev-start.ts
import { readBody, run } from "@/lib/execution/http";
import { prepareJob } from "@/lib/execution/runner";
import { ExecError, UUID_RE } from "@/lib/execution/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/execution/leads/:id/prepare - { scopeConfirmed: true }. Admin only.
 * The developer confirms the approved scope; SILPI prepares the project folder and the brief.
 * This starts nothing: no AI runs, nothing is spent.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const denied = requireAdminOrDevStart(request);
  if (denied) return denied;
  const { id } = await context.params;
  return run("PREPARE", async () => {
    if (!UUID_RE.test(id)) throw new ExecError("bad-id", "That project id is not valid.", 400);
    const body = await readBody(request);
    return { job: prepareJob(id, { scopeConfirmed: body.scopeConfirmed === true }) };
  });
}
