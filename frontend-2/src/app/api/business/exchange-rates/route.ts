import { NextResponse } from "next/server";

import { FALLBACK_INR_PER_UNIT, inrPerUnitFrom } from "@/lib/business/currency";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** One lookup every six hours is plenty for a budget conversation. */
const TTL_MS = 6 * 60 * 60 * 1000;
type Rates = { source: "live" | "approximate"; asOf: string; inrPerUnit: Record<string, number> };
const memory = globalThis as unknown as { silpiRates?: { at: number; value: Rates } };

/**
 * GET /api/business/exchange-rates - rupees for one unit of each currency.
 * Asks a free public rate service (no key, and nothing about the client or the project is sent). If it cannot be reached the
 * approximate table is returned and says so, so the screen never claims a live rate it does not have.
 */
export async function GET() {
  const cached = memory.silpiRates;
  if (cached && Date.now() - cached.at < TTL_MS) return NextResponse.json({ success: true, ...cached.value });
  try {
    const response = await fetch("https://open.er-api.com/v6/latest/INR", { cache: "no-store", signal: AbortSignal.timeout(4000) });
    const data = (await response.json()) as { result?: string; rates?: Record<string, unknown>; time_last_update_utc?: string };
    if (!response.ok || data.result !== "success" || !data.rates) throw new Error("rate service answered without rates");
    const inrPerUnit = { ...FALLBACK_INR_PER_UNIT, ...inrPerUnitFrom(data.rates) };
    const value: Rates = { source: "live", asOf: data.time_last_update_utc ? new Date(data.time_last_update_utc).toISOString() : new Date().toISOString(), inrPerUnit };
    memory.silpiRates = { at: Date.now(), value };
    return NextResponse.json({ success: true, ...value });
  } catch {
    // Not cached, so the next request tries the live service again.
    const value: Rates = { source: "approximate", asOf: "", inrPerUnit: FALLBACK_INR_PER_UNIT };
    return NextResponse.json({ success: true, ...value });
  }
}
