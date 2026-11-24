import { NextRequest } from "next/server";

import { isTier, parseTechSelection, previewTech, techChoices } from "@/lib/business/client-tech";
import { handle, notFound } from "@/lib/business/http";
import { isHourly } from "@/lib/business/hourly";
import { getLead, getRateCard, setTechnology, stageHistory } from "@/lib/business/store";
import { ValidationError } from "@/lib/business/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

const tierOf = (raw: unknown, fallback: string | undefined) => (isTier(raw) ? raw : isTier(fallback) ? fallback : "standard");

function leadFor(id: string) {
  const lead = getLead(id);
  if (!lead) return null;
  if (isHourly(lead.requirement)) throw new ValidationError("An hourly engagement has no website technology to choose.");
  return lead;
}

/** GET /api/business/leads/:id/technology?tier= - the options for each layer, with what each does to the price. */
export async function GET(request: NextRequest, context: Context) {
  const { id } = await context.params;
  if (!getLead(id)) return notFound();
  return handle("TECH CHOICES", () => {
    const lead = leadFor(id)!;
    return techChoices(lead.requirement, lead.client, getRateCard(), tierOf(request.nextUrl.searchParams.get("tier"), lead.quotation?.tier));
  });
}

/** POST /api/business/leads/:id/technology - { tier?, tech }: the new price for a selection. Changes nothing. */
export async function POST(request: NextRequest, context: Context) {
  const { id } = await context.params;
  if (!getLead(id)) return notFound();
  return handle("TECH PREVIEW", async () => {
    const lead = leadFor(id)!;
    const body = (await request.json().catch(() => ({}))) as { tier?: unknown; tech?: unknown };
    const rates = getRateCard();
    return { preview: previewTech(lead.requirement, lead.client, rates, tierOf(body.tier, lead.quotation?.tier), parseTechSelection(body.tech ?? {}, lead.requirement, rates)) };
  });
}

/** PUT /api/business/leads/:id/technology - { tech }: sets the technology and prices the quotation again (only while it is open). */
export async function PUT(request: NextRequest, context: Context) {
  const { id } = await context.params;
  if (!getLead(id)) return notFound();
  return handle("TECH SET", async () => {
    leadFor(id);
    const body = (await request.json().catch(() => ({}))) as { tech?: unknown };
    return { lead: setTechnology(id, (body.tech ?? {}) as Record<string, string>), history: stageHistory(id) };
  });
}
