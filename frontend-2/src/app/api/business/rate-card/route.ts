import { NextRequest } from "next/server";

import { handle } from "@/lib/business/http";
import { DEFAULT_RATE_CARD } from "@/lib/business/rate-card";
import { getRateCard, refreshAutoRates, saveRateCard } from "@/lib/business/store";
import { parseRateCard } from "@/lib/business/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/business/rate-card - current prices, GST rate and business details. */
export async function GET() {
  return handle("RATE CARD GET", async () => {
    // Country prices that follow the market are brought up to today's rate first (at most one lookup in six hours).
    await refreshAutoRates().catch(() => undefined);
    return { rateCard: getRateCard() };
  });
}

/** PUT /api/business/rate-card - save an edited rate card (new quotations use it). */
export async function PUT(request: NextRequest) {
  return handle("RATE CARD SAVE", async () => {
    const card = parseRateCard(await request.json(), DEFAULT_RATE_CARD);
    saveRateCard(card);
    return { rateCard: card };
  });
}
