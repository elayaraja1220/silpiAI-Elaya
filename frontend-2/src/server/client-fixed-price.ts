// A client's own fixed-price request (server only): the existing quotation engine, run for the client's workspace.
//
// What is the client's: their requirement, their contact details, and which package they prefer.
// What stays the studio's, whatever the browser sends: every price (the quotation is worked out again here from the real rate card), the market-rate basis, hourly
// engagements, discounts, and the organization the request belongs to (it comes from the session, never from the request).
import { listLeadsForOrg } from "@/server/tenancy";
import { createLead, getRateCard, refreshAutoRates, shareToken } from "@/lib/business/store";
import { TIERS, type Tier } from "@/lib/business/types";
import { parseClient, parseRequirement, ValidationError } from "@/lib/business/validate";

/** How many requests that are still open one workspace may have at once. A real client has a handful; more than this is a script. */
export const MAX_OPEN_REQUESTS = 25;
const OPEN = new Set(["requirement", "quoted"]);

export type ClientRequestResult = { leadId: string; token: string; quotationNumber: string | null };

export async function createClientRequest(session: { user: { id: string; email: string }; orgId: string }, body: { client?: unknown; requirement?: unknown; tier?: unknown }): Promise<ClientRequestResult> {
  const open = listLeadsForOrg(session.orgId).filter((l) => OPEN.has(l.stage)).length;
  if (open >= MAX_OPEN_REQUESTS) throw new ValidationError(`You already have ${open} requests waiting. Please approve or close some before adding more.`);
  const client = parseClient(body.client);
  await refreshAutoRates().catch(() => undefined);
  const raw = body.requirement && typeof body.requirement === "object" ? ({ ...(body.requirement as Record<string, unknown>) } as Record<string, unknown>) : {};
  // Only a fixed-price project, priced by the studio: no hourly engagement and no market basis chosen by the client.
  if (raw.billing === "hourly" || raw.hourly) throw new ValidationError("This form is for fixed-price projects.");
  delete raw.fixedBasis;
  delete raw.hourly;
  delete raw.billing;
  const requirement = parseRequirement(raw, getRateCard());
  const tier = TIERS.includes(body.tier as Tier) ? (body.tier as Tier) : undefined;
  const lead = createLead(client, requirement, tier, session.orgId);
  return { leadId: lead.id, token: shareToken(lead.id), quotationNumber: lead.quotation?.number ?? null };
}
