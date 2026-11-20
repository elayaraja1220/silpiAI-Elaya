import { NextRequest } from "next/server";

import { handle } from "@/lib/business/http";
import { DEFAULT_RATE_CARD } from "@/lib/business/rate-card";
import { getRateCard, saveRateCard } from "@/lib/business/store";
import { parseRateCard } from "@/lib/business/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/business/rate-card - current prices, GST rate and business details. */
export async function GET() {
  return handle("RATE CARD GET", () => ({ rateCard: getRateCard() }));
}

/** PUT /api/business/rate-card - save an edited rate card (new quotations use it). */
export async function PUT(request: NextRequest) {
  return handle("RATE CARD SAVE", async () => {
    const card = parseRateCard(await request.json(), DEFAULT_RATE_CARD);
    saveRateCard(card);
    return { rateCard: card };
  });
}
