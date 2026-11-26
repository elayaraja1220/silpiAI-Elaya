import { NextRequest } from "next/server";

import { handle } from "@/lib/business/http";
import { createLead, getRateCard, listLeads, refreshAutoRates } from "@/lib/business/store";
import { TIERS, type Tier } from "@/lib/business/types";
import { parseClient, parseRequirement } from "@/lib/business/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/business/leads - every client requirement with its latest quotation. */
export async function GET() {
  return handle("LEADS LIST", () => ({ leads: listLeads() }));
}

/** POST /api/business/leads - { client, requirement, tier? } -> saved lead + first quotation. */
export async function POST(request: NextRequest) {
  return handle("LEAD CREATE", async () => {
    const body = (await request.json()) as { client?: unknown; requirement?: unknown; tier?: unknown };
    const client = parseClient(body.client);
    // A new quotation uses today's market rate for the rupee value of a price in another currency.
    await refreshAutoRates().catch(() => undefined);
    const requirement = parseRequirement(body.requirement, getRateCard());
    // The package finalised with the client; otherwise the one suggested for the budget.
    const tier = TIERS.includes(body.tier as Tier) ? (body.tier as Tier) : undefined;
    return { lead: createLead(client, requirement, tier) };
  });
}
