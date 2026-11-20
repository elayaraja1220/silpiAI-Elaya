import { NextRequest } from "next/server";

import { handle } from "@/lib/business/http";
import { getTechCatalog, getTechOverrides, saveTechOverrides } from "@/lib/business/store";
import { parseTechOverrides, techPatchProblems } from "@/lib/business/tech-catalog";
import { ValidationError } from "@/lib/business/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/business/tech-catalog - the catalog with the administrator's availability and settings applied. */
export async function GET() {
  return handle("TECH CATALOG GET", () => ({ catalog: getTechCatalog(), overrides: getTechOverrides() }));
}

/**
 * PUT /api/business/tech-catalog - { overrides: { "<id>": { enabled, devFactor, ... } } }.
 * Only known ids and editable fields are kept; other saved entries stay as they are.
 */
export async function PUT(request: NextRequest) {
  return handle("TECH CATALOG SAVE", async () => {
    const body = (await request.json()) as { overrides?: unknown };
    const problems = techPatchProblems(body.overrides);
    if (problems.length) throw new ValidationError(`Not saved. ${problems.slice(0, 5).join(" ")}`);
    const patch = parseTechOverrides(body.overrides);
    if (Object.keys(patch).length === 0) throw new ValidationError("Nothing to save: use a known technology id with enabled, devFactor, maintenance, scalability, projectTypes or security.");
    saveTechOverrides(patch);
    return { catalog: getTechCatalog(), overrides: getTechOverrides() };
  });
}
