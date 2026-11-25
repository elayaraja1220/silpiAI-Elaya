import type { DatabaseSync } from "node:sqlite";

import { getDb, transaction } from "@/lib/business/db";
import { CURRENCY_INFO, isCurrency, type CurrencyCode } from "@/lib/currencies";
import { ValidationError } from "@/lib/business/validate";

/**
 * Exchange rates, used ONLY to add up reports in one currency (the finance view). Customers are always billed in the currency of their plan and pay
 * exactly that: no rate ever changes what an invoice says. A rate is "1 US dollar = N units of the currency", kept as a whole number of millionths so
 * the maths is exact. Rates are typed in by the administrator with where they came from; nothing is fetched from the internet and nothing is guessed:
 * a currency with no rate is reported as missing, never converted at a made-up figure. Every rate ever set is kept (append-only).
 */
export type Rate = { currency: CurrencyCode; perUsdMicro: number; source: string; setAt: string; setBy: string };
const bad = (m: string) => new ValidationError(m);
const MAX_MICRO = 10_000_000_000_000; // 10 million units to the dollar: far beyond any real currency, stops a stray digit from slipping in
const BIG_CHANGE = 0.3; // a rate that moves by more than 30% needs an explicit confirmation

/** "83.5" -> 83_500_000. Up to 6 decimals, digits only: no floating point. */
export function parseRate(value: unknown): number {
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  const m = /^(\d{1,7})(?:\.(\d{1,6}))?$/.exec(text);
  if (!m) throw bad("The rate must be a plain number with up to 6 decimals, for example 83.5.");
  const micro = Number(m[1]) * 1_000_000 + Number((m[2] ?? "").padEnd(6, "0"));
  if (micro < 1 || micro > MAX_MICRO) throw bad("That rate is outside the believable range.");
  return micro;
}

type Row = { currency: string; per_usd_micro: number; source: string; created_by: string; created_at: string };
const toRate = (r: Row): Rate => ({ currency: r.currency as CurrencyCode, perUsdMicro: r.per_usd_micro, source: r.source, setAt: r.created_at, setBy: r.created_by });

/** The newest rate of each currency (US dollars are always 1 and not listed). */
export function listRates(db: DatabaseSync = getDb()): Rate[] {
  const rows = db.prepare("SELECT e.* FROM exchange_rates e WHERE e.id = (SELECT MAX(id) FROM exchange_rates WHERE currency = e.currency) ORDER BY e.currency").all() as Row[];
  return rows.map(toRate);
}
export const rateHistory = (currency: string, limit = 20): Rate[] =>
  (getDb().prepare("SELECT * FROM exchange_rates WHERE currency = ? ORDER BY id DESC LIMIT ?").all(currency, Math.min(Math.max(limit, 1), 100)) as Row[]).map(toRate);

export function setRate(input: { currency: unknown; perUsd: unknown; source: unknown; confirm?: boolean; setBy?: string; at?: string }): Rate {
  if (!isCurrency(input.currency)) throw bad("That is not a currency this system supports.");
  const currency: CurrencyCode = input.currency;
  if (currency === "USD") throw bad("The US dollar is the base: its rate is always 1.");
  const source = typeof input.source === "string" ? input.source.trim() : "";
  if (source.length < 3 || source.length > 200) throw bad("Say where the rate comes from (3 to 200 characters), for example the date and the website or bank.");
  const micro = parseRate(input.perUsd);
  return transaction((db) => {
    const last = db.prepare("SELECT per_usd_micro FROM exchange_rates WHERE currency = ? ORDER BY id DESC LIMIT 1").get(currency) as { per_usd_micro: number } | undefined;
    if (last && Math.abs(micro - last.per_usd_micro) / last.per_usd_micro > BIG_CHANGE && input.confirm !== true) {
      throw bad(`That moves the rate by more than ${BIG_CHANGE * 100}% (from ${last.per_usd_micro / 1_000_000} to ${micro / 1_000_000}). Check for a typing mistake, then confirm.`);
    }
    db.prepare("INSERT INTO exchange_rates (currency, per_usd_micro, source, created_by, created_at) VALUES (?, ?, ?, ?, ?)").run(currency, micro, source, String(input.setBy ?? "admin").slice(0, 80), input.at ?? new Date().toISOString());
    return toRate(db.prepare("SELECT * FROM exchange_rates WHERE currency = ? ORDER BY id DESC LIMIT 1").get(currency) as Row);
  });
}

export type RateMap = Map<string, number>;
export function rateMap(db: DatabaseSync = getDb()): RateMap {
  const m: RateMap = new Map([["USD", 1_000_000]]);
  for (const r of listRates(db)) m.set(r.currency, r.perUsdMicro);
  return m;
}

/**
 * Converts an amount in the smallest unit of one currency to the smallest unit of another, rounding half away from zero. Exact (whole numbers only).
 * Returns null when either currency has no rate: the caller must say so rather than invent one.
 */
export function convertMinor(minor: number, from: string, to: string, rates: RateMap): number | null {
  if (from === to) return minor;
  const rf = rates.get(from);
  const rt = rates.get(to);
  if (!rf || !rt || !isCurrency(from) || !isCurrency(to)) return null;
  const ten = BigInt(10);
  const num = BigInt(Math.abs(minor)) * BigInt(rt) * ten ** BigInt(CURRENCY_INFO[to].exponent);
  const den = BigInt(rf) * ten ** BigInt(CURRENCY_INFO[from].exponent);
  const two = BigInt(2);
  const q = (num * two + den) / (den * two); // round half up on the magnitude
  return Number(minor < 0 ? -q : q);
}

export type Consolidated = { currency: string; total: number; missing: string[]; ratesFrom: string | null };
/** Adds up amounts held in several currencies in one currency. Currencies without a rate are listed as missing and are NOT in the total. */
export function consolidate(amounts: Record<string, number>, target: string, rates: RateMap, db: DatabaseSync = getDb()): Consolidated {
  let total = 0;
  const missing: string[] = [];
  let oldest: string | null = null;
  for (const [c, n] of Object.entries(amounts)) {
    if (n === 0) continue;
    const v = convertMinor(n, c, target, rates);
    if (v === null) { missing.push(c); continue; }
    total += v;
    if (c !== target && c !== "USD") {
      const at = (db.prepare("SELECT created_at FROM exchange_rates WHERE currency = ? ORDER BY id DESC LIMIT 1").get(c) as { created_at: string } | undefined)?.created_at;
      if (at && (oldest === null || at < oldest)) oldest = at;
    }
  }
  return { currency: target, total, missing: missing.sort(), ratesFrom: oldest };
}
