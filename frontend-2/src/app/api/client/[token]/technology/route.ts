import { NextRequest, NextResponse } from "next/server";

import { isTier, parseTechSelection, previewTech, techChoices } from "@/lib/business/client-tech";
import { allowResponse } from "@/lib/business/client-view";
import { handle } from "@/lib/business/http";
import { isHourly } from "@/lib/business/hourly";
import { getLeadByToken, getRateCard } from "@/lib/business/store";
import { ValidationError } from "@/lib/business/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ token: string }> };
const gone = () => NextResponse.json({ success: false, error: "This quotation link is not valid." }, { status: 404 });

/** Technology can be chosen only while the quotation is open, and not for an hourly engagement (no website stack to choose). */
function openLead(token: string) {
  const lead = getLeadByToken(token);
  if (!lead || !lead.quotation) return null;
  const open = lead.stage === "quoted" && new Date(lead.quotation.validUntil).getTime() >= Date.now();
  if (!open) throw new ValidationError("This quotation is no longer open, so the technology cannot be changed here.");
  if (isHourly(lead.requirement)) throw new ValidationError("An hourly engagement has no website technology to choose.");
  return lead;
}

/**
 * GET /api/client/:token/technology?tier= - frontend, backend and database options, each with what it does to the price.
 * Public and read-only: it shows labels and totals only, nothing internal.
 */
export async function GET(request: NextRequest, context: Context) {
  const { token } = await context.params;
  if (!getLeadByToken(token)) return gone();
  if (!allowResponse(`tech:${token}`, 200)) return NextResponse.json({ success: false, error: "Too many requests. Please try again later." }, { status: 429 });
  return handle("CLIENT TECH CHOICES", () => {
    const lead = openLead(token)!;
    const tier = request.nextUrl.searchParams.get("tier");
    return techChoices(lead.requirement, lead.client, getRateCard(), isTier(tier) ? tier : lead.quotation!.tier ?? "standard");
  });
}

/**
 * POST /api/client/:token/technology - { tier?, tech: { frontend?, backend?, database? } }.
 * A preview only: it works out the new price and changes nothing. The choice is saved when the client approves.
 */
export async function POST(request: NextRequest, context: Context) {
  const { token } = await context.params;
  if (!getLeadByToken(token)) return gone();
  if (!allowResponse(`tech:${token}`, 200)) return NextResponse.json({ success: false, error: "Too many requests. Please try again later." }, { status: 429 });
  return handle("CLIENT TECH PREVIEW", async () => {
    const lead = openLead(token)!;
    const body = (await request.json().catch(() => ({}))) as { tier?: unknown; tech?: unknown };
    const rates = getRateCard();
    const tech = parseTechSelection(body.tech ?? {}, lead.requirement, rates);
    return { preview: previewTech(lead.requirement, lead.client, rates, isTier(body.tier) ? body.tier : lead.quotation!.tier ?? "standard", tech) };
  });
}
