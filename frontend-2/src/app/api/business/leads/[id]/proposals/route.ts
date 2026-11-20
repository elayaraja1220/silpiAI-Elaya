import { NextRequest } from "next/server";

import { handle, notFound } from "@/lib/business/http";
import { buildProposals, compareProposals } from "@/lib/business/proposals";
import { chooseTier, getLead, getRateCard, stageHistory } from "@/lib/business/store";
import { TIERS, type Tier } from "@/lib/business/types";
import { ValidationError } from "@/lib/business/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** GET /api/business/leads/:id/proposals - Basic, Standard and Premium for this requirement. */
export async function GET(_request: NextRequest, context: Context) {
  const { id } = await context.params;
  const lead = getLead(id);
  if (!lead) return notFound();
  return handle("PROPOSALS", () => {
    const rates = getRateCard();
    const proposals = buildProposals(lead.requirement, lead.client, rates);
    return { proposals, comparison: compareProposals(proposals, rates) };
  });
}

/** POST /api/business/leads/:id/proposals - { tier }: make that proposal the quotation. */
export async function POST(request: NextRequest, context: Context) {
  const { id } = await context.params;
  if (!getLead(id)) return notFound();
  return handle("CHOOSE PROPOSAL", async () => {
    const { tier } = (await request.json()) as { tier?: unknown };
    if (!TIERS.includes(tier as Tier)) throw new ValidationError("Choose basic, standard or premium.");
    return { lead: chooseTier(id, tier as Tier), history: stageHistory(id) };
  });
}
