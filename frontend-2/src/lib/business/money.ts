/**
 * Money in a quotation, in the client's own currency.
 *
 * Inside the app every amount is in RUPEES (the books, costs, profit, payments, the budget comparison). A quotation for a client abroad is priced from
 * a per-country hourly rate written in THEIR currency (for example 25 pounds an hour), turned into rupees at a fixed "rupees per unit" rate that is
 * stored with the rate card and copied into the quotation. Only when an amount is SHOWN to a person does it go back to their currency. So:
 *   - the foreign price is hours x their rate, whatever the exchange rate does later: a quotation never changes by itself;
 *   - the team's rupee figures stay consistent with each other;
 *   - every amount on a screen or document says which currency it is in.
 * Pure and shared by the browser and the server. No imports from Node.
 */
import { CURRENCIES, currencyOf } from "./currency";

/** A quotation's currency: its code, and how many rupees one unit of it is worth in that quotation. Rupees: { code: "INR", unit: 1 }. */
export type Money = { code: string; unit: number };
export const INR_MONEY: Money = { code: "INR", unit: 1 };

/** The currency a quote (or a saved quotation) is in. Anything older than this feature, or malformed, is rupees. */
export function moneyOf(quote: { currency?: string; inrPerUnit?: number } | null | undefined): Money {
  const code = quote?.currency;
  const unit = quote?.inrPerUnit;
  if (!code || code === "INR" || !CURRENCIES.some((c) => c.code === code) || typeof unit !== "number" || !Number.isFinite(unit) || unit <= 0) return INR_MONEY;
  return { code, unit };
}
export const isForeign = (m: Money): boolean => m.code !== "INR";

const formatters = new Map<string, Intl.NumberFormat>();
function formatter(code: string): Intl.NumberFormat {
  let f = formatters.get(code);
  if (!f) {
    // Rupees keep the lakh grouping and two decimals they always had. Others use the usual grouping and the currency's own decimals.
    f = new Intl.NumberFormat(code === "INR" ? "en-IN" : "en-US", { style: "currency", currency: code, currencyDisplay: "symbol", ...(code === "INR" ? { maximumFractionDigits: 2 } : {}) });
    formatters.set(code, f);
  }
  return f;
}

/** An amount held in rupees, written in the quotation's currency ("£162.50", "₹19,711.00"). */
export function formatMoney(amountInr: number, money: Money = INR_MONEY): string {
  const value = money.unit === 1 ? amountInr : amountInr / money.unit;
  return formatter(money.code).format(Math.abs(value) < 0.005 ? 0 : value);
}

/** The symbol or abbreviation people use for this currency, for labels ("per hour in £"). */
export function symbolOf(code: string): string {
  return formatter(code).formatToParts(1).find((p) => p.type === "currency")?.value ?? currencyOf(code).symbol;
}

/** An amount in the quotation's currency (not rupees) turned into rupees, to keep the books in rupees. Rounded to a whole paisa. */
export const toRupees = (amount: number, money: Money): number => Math.round(amount * money.unit * 100) / 100;
/** Rupees turned into the quotation's currency, rounded to the currency's smallest unit (two decimals). */
export const fromRupees = (amountInr: number, money: Money): number => Math.round((amountInr / money.unit) * 100) / 100;
