import { NextRequest } from "next/server";

import { minorDigits } from "@/lib/business/countries";
import { handle } from "@/lib/business/http";
import { ValidationError } from "@/lib/business/validate";
import { rateFor } from "@/server/pricing-data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/business/market-rate?country=IN&role=full-stack&level=mid&mode=hourly|fixed
 * The verified market rate for a quotation, from the benchmark the administrator chose for that mode, with its source, date and warnings.
 * Read only: nobody can change a rate from here. With no verified row the answer says so and the screen falls back to what the team types.
 */
export async function GET(request: NextRequest) {
  return handle("MARKET RATE", () => {
    const q = request.nextUrl.searchParams;
    const mode = q.get("mode") === "fixed" ? "fixed" : "hourly";
    const role = q.get("role") ?? "";
    const level = q.get("level") ?? "";
    if (!/^[a-z0-9-]{2,41}$/.test(role) || !/^[a-z0-9-]{2,20}$/.test(level)) throw new ValidationError("Choose a role and an experience level.");
    const rate = rateFor({ country: q.get("country"), roleId: role, levelId: level, mode });
    return { rate, ...(rate.ok ? { minorDigits: minorDigits(rate.currency) } : {}) };
  });
}
