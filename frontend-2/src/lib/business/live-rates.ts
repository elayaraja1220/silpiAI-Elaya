import { FALLBACK_INR_PER_UNIT, inrPerUnitFrom } from "./currency";

/**
 * The market exchange rate: rupees for one unit of each currency.
 * Asks a free public rate service (no key; nothing about any client or project is sent). Cached for six hours. When the service cannot be reached the
 * approximate table is returned and SAYS so ("approximate"), so nothing ever claims a live rate it does not have, and a caller can refuse to use it.
 * Server only (it fetches).
 */
export type LiveRates = { source: "live" | "approximate"; asOf: string; inrPerUnit: Record<string, number> };

const TTL_MS = 6 * 60 * 60 * 1000;
const memory = globalThis as unknown as { silpiRates?: { at: number; value: LiveRates } };

export async function getLiveInrPerUnit(now = Date.now()): Promise<LiveRates> {
  const cached = memory.silpiRates;
  if (cached && now - cached.at < TTL_MS) return cached.value;
  try {
    const response = await fetch("https://open.er-api.com/v6/latest/INR", { cache: "no-store", signal: AbortSignal.timeout(4000) });
    const data = (await response.json()) as { result?: string; rates?: Record<string, unknown>; time_last_update_utc?: string };
    if (!response.ok || data.result !== "success" || !data.rates) throw new Error("rate service answered without rates");
    const value: LiveRates = { source: "live", asOf: data.time_last_update_utc ? new Date(data.time_last_update_utc).toISOString() : new Date(now).toISOString(), inrPerUnit: { ...FALLBACK_INR_PER_UNIT, ...inrPerUnitFrom(data.rates) } };
    memory.silpiRates = { at: now, value };
    return value;
  } catch {
    // Not cached, so the next request tries the live service again.
    return { source: "approximate", asOf: "", inrPerUnit: FALLBACK_INR_PER_UNIT };
  }
}
