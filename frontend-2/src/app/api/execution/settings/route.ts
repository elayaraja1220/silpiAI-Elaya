import { NextRequest } from "next/server";

import { requireAdmin } from "@/lib/admin-auth";
import { requireAdminOrDevStart } from "@/lib/dev-start"; // TEMP DEV: see dev-start.ts
import { ValidationError } from "@/lib/business/validate";
import { estimateApiCost } from "@/lib/execution/api-gate";
import { run, readBody } from "@/lib/execution/http";
import { completedApiCosts, getExecutionSettings, saveExecutionSettings } from "@/lib/execution/jobs";
import { readExecutionPatch } from "@/lib/execution/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const view = () => {
  const settings = getExecutionSettings();
  return { settings, apiEstimate: estimateApiCost(completedApiCosts(), settings.apiSpendLimitUsd) };
};

/** GET /api/execution/settings - admin only. Execution settings and the current API cost estimate. */
export async function GET(request: NextRequest) {
  const denied = requireAdminOrDevStart(request);
  if (denied) return denied;
  return run("SETTINGS GET", view);
}

/** PUT /api/execution/settings - admin only. Strict: anything invalid is reported and nothing is saved. */
export async function PUT(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  return run("SETTINGS SAVE", async () => {
    const body = await readBody(request);
    const { patch, problems } = readExecutionPatch(body.settings);
    if (problems.length) throw new ValidationError(`Not saved. ${problems.slice(0, 5).join(" ")}`);
    if (Object.keys(patch).length === 0) throw new ValidationError("Nothing to save: send at least one execution setting.");
    saveExecutionSettings(patch);
    return view();
  });
}
