import { NextRequest } from "next/server";

import { requireAdmin } from "@/lib/admin-auth";
import { computeLeadCosts } from "@/lib/business/lead-costs";
import { getRunningServices, saveRunningServices } from "@/lib/business/running-store";
import { adminRunningSummary, parseRunningServices, publicRunningServices, seedRunningServices, serviceMarkup, type RunningService } from "@/lib/business/running-services";
import { getLead } from "@/lib/business/store";
import { ValidationError } from "@/lib/business/validate";
import { ExecError, UUID_RE } from "@/lib/execution/types";
import { run } from "@/lib/execution/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** The full internal record, what the client would see from it, and a summary. Admin only. */
function adminView(services: RunningService[], saved: boolean) {
  return {
    saved,
    services,
    markups: Object.fromEntries(services.flatMap((s) => { const m = serviceMarkup(s); return m ? [[s.id, m]] : []; })),
    summary: adminRunningSummary(services),
    // Built by the same function the public routes use, so this is exactly what the client sees.
    clientPreview: publicRunningServices(services),
  };
}

function leadOrThrow(id: string) {
  if (!UUID_RE.test(id)) throw new ExecError("bad-id", "That project id is not valid.", 400);
  const lead = getLead(id);
  if (!lead) throw new ExecError("not-found", "Project not found.", 404);
  return lead;
}

/**
 * GET /api/business/leads/:id/running-services - ADMIN ONLY (signed-in administrator).
 * The saved arrangements, or a starting list from the running costs the cost engine already suggests (nothing is
 * shown to the client until it is approved and saved).
 */
export async function GET(request: NextRequest, context: Context) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const { id } = await context.params;
  return run("RUNNING SERVICES GET", () => {
    const lead = leadOrThrow(id);
    const saved = getRunningServices(lead.id);
    if (saved) return adminView(saved, true);
    if (!lead.quotation) throw new ValidationError("This project has no quotation yet.");
    return adminView(seedRunningServices(computeLeadCosts(lead).runningCosts), false);
  });
}

/** PUT /api/business/leads/:id/running-services - { services: [...] } replaces the list. Admin only; strictly validated. */
export async function PUT(request: NextRequest, context: Context) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const { id } = await context.params;
  return run("RUNNING SERVICES PUT", async () => {
    const lead = leadOrThrow(id);
    const body = (await request.json()) as { services?: unknown };
    return adminView(saveRunningServices(lead.id, parseRunningServices(body?.services)), true);
  });
}
