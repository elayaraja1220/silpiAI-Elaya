import { NextRequest } from "next/server";

import { countryOf, pickCountry } from "@/lib/business/countries";
import { handle } from "@/lib/business/http";
import { countryFromHeaders } from "@/lib/geo";
import { getPricingConfig, listReference } from "@/server/pricing-data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/business/pricing-reference - the countries, roles and levels a quotation can use, which kind of benchmark powers each mode, and the country
 * this request seemed to come from. That last is only a GUESS (a VPN, a company network or a missing header makes it wrong) and, for a team member
 * filling in a client's details, it is the team's own location: it may pre-fill a choice but never decides one.
 */
export async function GET(request: NextRequest) {
  return handle("PRICING REFERENCE", () => {
    const ref = listReference();
    const config = getPricingConfig();
    const guess = pickCountry({ location: countryFromHeaders(request.headers) });
    return { ...ref, benchmark: config.benchmark, riskAllowanceBp: config.riskAllowanceBp, location: guess && countryOf(guess.code) ? { code: guess.code, source: guess.source } : null };
  });
}
