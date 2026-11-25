import { NextRequest } from "next/server";

import { requireAdmin } from "@/lib/admin-auth";
import { auditAdmin } from "@/server/audit";
import { listRates, rateHistory, setRate } from "@/server/fx";
import { apiHandle } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/admin/fx[?currency=INR] - the newest exchange rate of each currency (and one currency's history). Used only for adding up reports. Admin only. */
export async function GET(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  return apiHandle("FX LIST", () => {
    const c = request.nextUrl.searchParams.get("currency");
    return { rates: listRates(), ...(c ? { history: rateHistory(c) } : {}) };
  });
}

/** PUT /api/admin/fx - { currency, perUsd, source, confirm? }: 1 US dollar = perUsd of the currency. A move of more than 30% needs confirm: true. Admin only. */
export async function PUT(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  return apiHandle("FX SET", async () => {
    const b = (await request.json()) as { currency?: unknown; perUsd?: unknown; source?: unknown; confirm?: unknown };
    const rate = setRate({ currency: b.currency, perUsd: b.perUsd, source: b.source, confirm: b.confirm === true });
    auditAdmin(request, "fx.rate_set", "currency", rate.currency, { perUsdMicro: rate.perUsdMicro, source: rate.source });
    return { rate, rates: listRates() };
  });
}
