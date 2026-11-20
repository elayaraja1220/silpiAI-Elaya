import { NextRequest } from "next/server";

import { requireAdminOrDevStart } from "@/lib/dev-start"; // TEMP DEV: see dev-start.ts
import { readBody, run } from "@/lib/execution/http";
import { cancelJob, declineApi, markJobReady, restartJob, reviewJob, startJob } from "@/lib/execution/runner";
import { ExecError, UUID_RE, type ApiApprovalRequest } from "@/lib/execution/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Only these actions exist. Nothing in the request becomes a command. */
const ACTIONS = ["start", "cancel", "decline-api", "restart", "review", "ready"] as const;

const approvalFrom = (value: unknown): ApiApprovalRequest | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : null);
  const limit = num(v.limitUsd);
  if (limit === null) return undefined;
  return { confirmed: v.confirmed === true, estimateUsd: num(v.estimateUsd), limitUsd: limit, acceptUnreliable: v.acceptUnreliable === true };
};

/**
 * POST /api/execution/jobs/:jobId/:action - admin only.
 *   start       { mode: "local" | "api", withoutAdvance?, reason?, apiApproval? }
 *   cancel | decline-api
 *   restart     { scopeConfirmed: true }
 *   review      { decision: "approved" | "changes-requested", note?, overrideVerification? }
 *   ready       (only after an approved review)
 */
export async function POST(request: NextRequest, context: { params: Promise<{ jobId: string; action: string }> }) {
  const { jobId, action } = await context.params;
  // TEMP DEV: localhost works without the admin token while the dev flag is on (see dev-start.ts).
  const denied = requireAdminOrDevStart(request);
  if (denied) return denied;
  return run(`JOB ${action}`, async () => {
    if (!UUID_RE.test(jobId)) throw new ExecError("bad-id", "That job id is not valid.", 400);
    if (!(ACTIONS as readonly string[]).includes(action)) throw new ExecError("unknown-action", "Unknown action.", 404);
    const body = await readBody(request);
    switch (action) {
      case "start":
        return { job: await startJob(jobId, { mode: body.mode === "api" ? "api" : body.mode === "local" ? "local" : (undefined as never), withoutAdvance: body.withoutAdvance === true, reason: typeof body.reason === "string" ? body.reason : "", apiApproval: approvalFrom(body.apiApproval) }) };
      case "cancel":
        return { job: cancelJob(jobId) };
      case "decline-api":
        return { job: declineApi(jobId) };
      case "restart":
        return { job: restartJob(jobId, body.scopeConfirmed === true) };
      case "review":
        return { job: reviewJob(jobId, { decision: body.decision as "approved", note: typeof body.note === "string" ? body.note : "", overrideVerification: body.overrideVerification === true }) };
      default:
        return markJobReady(jobId);
    }
  });
}
