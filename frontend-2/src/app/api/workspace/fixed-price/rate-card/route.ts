import { NextRequest } from "next/server";

import { clientRateCard } from "@/lib/business/client-rate-card";
import { getRateCard } from "@/lib/business/store";
import { apiHandle } from "@/server/http";
import { requireSession } from "@/server/session-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/workspace/fixed-price/rate-card - the prices the requirement form needs to show an estimate, without the studio's bank, contact or discount details. A signed-in client only. */
export async function GET(request: NextRequest) {
  const auth = requireSession(request, "lead:read");
  if ("denied" in auth) return auth.denied;
  return apiHandle("CLIENT RATE CARD", () => ({ rateCard: clientRateCard(getRateCard()) }));
}
