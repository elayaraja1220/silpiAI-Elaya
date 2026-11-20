import { NextRequest } from "next/server";

import { costConfigPatchProblems, readCostPatch } from "@/lib/business/cost-config";
import { handle } from "@/lib/business/http";
import { getCostConfig, saveCostConfig } from "@/lib/business/store";
import { ValidationError } from "@/lib/business/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/business/cost-config - the studio's cost rates (empty values are "not configured"). */
export async function GET() {
  return handle("COST CONFIG GET", () => ({ config: getCostConfig() }));
}

/**
 * PUT /api/business/cost-config - { config: { roleRates: { frontend: 400 }, ... } }.
 * Strict: anything invalid is reported and nothing is saved. null removes a value; other saved values stay.
 */
export async function PUT(request: NextRequest) {
  return handle("COST CONFIG SAVE", async () => {
    const body = (await request.json()) as { config?: unknown };
    const problems = costConfigPatchProblems(body.config);
    if (problems.length) throw new ValidationError(`Not saved. ${problems.slice(0, 5).join(" ")}`);
    const { patch } = readCostPatch(body.config);
    if (Object.keys(patch).length === 0) throw new ValidationError("Nothing to save: send at least one cost setting.");
    return { config: saveCostConfig(patch) };
  });
}
