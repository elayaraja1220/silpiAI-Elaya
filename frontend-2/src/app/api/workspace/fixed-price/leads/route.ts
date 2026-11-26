import { NextRequest } from "next/server";

import { apiHandle } from "@/server/http";
import { createClientRequest } from "@/server/client-fixed-price";
import { rateLimited, RATES } from "@/server/rate-limit";
import { requireSession } from "@/server/session-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/workspace/fixed-price/leads - { client, requirement, tier? }: the client's fixed-price request. The studio's quotation engine prices it, the request belongs to
 * the client's own workspace (from the session), and the answer is only what the client needs to open their quotation: { leadId, token, quotationNumber }. No cost, margin or
 * other internal figure is returned.
 */
export async function POST(request: NextRequest) {
  const auth = requireSession(request, "lead:write");
  if ("denied" in auth) return auth.denied;
  const limited = rateLimited(RATES.clientLead, auth.ctx.orgId);
  if (limited) return limited;
  return apiHandle("CLIENT LEAD", async () => ({ request: await createClientRequest({ user: auth.ctx.user, orgId: auth.ctx.orgId }, (await request.json()) as { client?: unknown; requirement?: unknown; tier?: unknown }) }));
}
