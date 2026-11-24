/**
 * Currencies a client's budget can be given in, and conversion to Indian rupees (pure).
 *
 * Every price in SILPI is in rupees. A client abroad may state a budget in their own money; it is converted to rupees for the
 * comparison and nothing else changes. The rate is only an aid for the conversation: live when it can be fetched (see
 * /api/business/exchange-rates), otherwise the approximate table below, and the screen says which.
 */

export type Currency = { code: string; symbol: string; name: string; countries: string[] };

export const CURRENCIES: readonly Currency[] = [
  { code: "INR", symbol: "₹", name: "Indian rupee", countries: ["India"] },
  { code: "USD", symbol: "$", name: "US dollar", countries: ["USA", "United States", "America", "Puerto Rico"] },
  { code: "GBP", symbol: "£", name: "British pound", countries: ["UK", "United Kingdom", "England", "Scotland", "Wales"] },
  { code: "EUR", symbol: "€", name: "Euro", countries: ["Germany", "France", "Italy", "Spain", "Netherlands", "Ireland", "Belgium", "Austria", "Portugal", "Finland", "Greece", "Eurozone"] },
  { code: "CAD", symbol: "$", name: "Canadian dollar", countries: ["Canada"] },
  { code: "AUD", symbol: "$", name: "Australian dollar", countries: ["Australia"] },
  { code: "NZD", symbol: "$", name: "New Zealand dollar", countries: ["New Zealand"] },
  { code: "SGD", symbol: "$", name: "Singapore dollar", countries: ["Singapore"] },
  { code: "HKD", symbol: "$", name: "Hong Kong dollar", countries: ["Hong Kong"] },
  { code: "AED", symbol: "د.إ", name: "UAE dirham", countries: ["UAE", "United Arab Emirates", "Dubai", "Abu Dhabi"] },
  { code: "SAR", symbol: "﷼", name: "Saudi riyal", countries: ["Saudi Arabia"] },
  { code: "QAR", symbol: "﷼", name: "Qatari riyal", countries: ["Qatar"] },
  { code: "KWD", symbol: "د.ك", name: "Kuwaiti dinar", countries: ["Kuwait"] },
  { code: "OMR", symbol: "﷼", name: "Omani rial", countries: ["Oman"] },
  { code: "BHD", symbol: ".د.ب", name: "Bahraini dinar", countries: ["Bahrain"] },
  { code: "MYR", symbol: "RM", name: "Malaysian ringgit", countries: ["Malaysia"] },
  { code: "THB", symbol: "฿", name: "Thai baht", countries: ["Thailand"] },
  { code: "IDR", symbol: "Rp", name: "Indonesian rupiah", countries: ["Indonesia"] },
  { code: "PHP", symbol: "₱", name: "Philippine peso", countries: ["Philippines"] },
  { code: "JPY", symbol: "¥", name: "Japanese yen", countries: ["Japan"] },
  { code: "CNY", symbol: "¥", name: "Chinese yuan", countries: ["China"] },
  { code: "KRW", symbol: "₩", name: "South Korean won", countries: ["South Korea", "Korea"] },
  { code: "CHF", symbol: "Fr", name: "Swiss franc", countries: ["Switzerland"] },
  { code: "ZAR", symbol: "R", name: "South African rand", countries: ["South Africa"] },
  { code: "LKR", symbol: "Rs", name: "Sri Lankan rupee", countries: ["Sri Lanka"] },
  { code: "NPR", symbol: "Rs", name: "Nepalese rupee", countries: ["Nepal"] },
  { code: "BDT", symbol: "৳", name: "Bangladeshi taka", countries: ["Bangladesh"] },
];

/** Rupees for one unit of each currency, as a last resort when no live rate can be fetched. Approximate (taken 23 Nov 2026). */
export const FALLBACK_INR_PER_UNIT: Record<string, number> = {
  INR: 1,
  USD: 92.8,
  GBP: 121.3,
  EUR: 101.7,
  CAD: 64.6,
  AUD: 61.6,
  NZD: 50.8,
  SGD: 71.8,
  HKD: 11.8,
  AED: 25.3,
  SAR: 24.7,
  QAR: 25.5,
  KWD: 299.2,
  OMR: 241.3,
  BHD: 246.7,
  MYR: 22.5,
  THB: 2.73,
  IDR: 0.0051,
  PHP: 1.45,
  JPY: 0.58,
  CNY: 13.9,
  KRW: 0.069,
  CHF: 110.3,
  ZAR: 5.29,
  LKR: 0.28,
  NPR: 0.63,
  BDT: 0.74,
};

export const currencyOf = (code: string): Currency => CURRENCIES.find((c) => c.code === code) ?? CURRENCIES[0];

/** Matches country, currency name, code or symbol, ignoring case. An empty search matches everything. */
export function searchCurrencies(query: string): Currency[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...CURRENCIES];
  return CURRENCIES.filter((c) => [c.code, c.symbol, c.name, ...c.countries].some((t) => t.toLowerCase().includes(q)));
}

/** Whole rupees for an amount in another currency; 0 when the amount or the rate is not usable. */
export function toInr(amount: number, code: string, inrPerUnit: Record<string, number>): number {
  const rate = code === "INR" ? 1 : inrPerUnit[code];
  if (!Number.isFinite(amount) || amount <= 0 || !Number.isFinite(rate) || !rate || rate <= 0) return 0;
  return Math.round(amount * rate);
}

/** Reads the rates answer of the exchange-rate service into rupees per unit, for the currencies we list (units per rupee in, rupees per unit out). */
export function inrPerUnitFrom(unitsPerInr: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = { INR: 1 };
  for (const { code } of CURRENCIES) {
    const perInr = Number(unitsPerInr[code]);
    if (code !== "INR" && Number.isFinite(perInr) && perInr > 0) out[code] = 1 / perInr;
  }
  return out;
}
