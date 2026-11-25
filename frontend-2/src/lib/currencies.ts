/**
 * The currencies a plan can be sold in, with how each one is written. Money is always stored as a whole number of the currency's
 * smallest unit (paise, cents, pence...). "Exponent" is how many digits that unit is below the main one: 2 for most, 0 for yen.
 */
export const CURRENCY_CODES = ["USD", "INR", "GBP", "EUR", "AED", "SGD", "AUD", "CAD", "JPY", "SAR"] as const;
export type CurrencyCode = (typeof CURRENCY_CODES)[number];

export const CURRENCY_INFO: Record<CurrencyCode, { name: string; symbol: string; exponent: number; locale: string }> = {
  USD: { name: "US dollar", symbol: "$", exponent: 2, locale: "en-US" },
  INR: { name: "Indian rupee", symbol: "₹", exponent: 2, locale: "en-IN" },
  GBP: { name: "Pound sterling", symbol: "£", exponent: 2, locale: "en-GB" },
  EUR: { name: "Euro", symbol: "€", exponent: 2, locale: "de-DE" },
  AED: { name: "UAE dirham", symbol: "AED ", exponent: 2, locale: "en-AE" },
  SGD: { name: "Singapore dollar", symbol: "S$", exponent: 2, locale: "en-SG" },
  AUD: { name: "Australian dollar", symbol: "A$", exponent: 2, locale: "en-AU" },
  CAD: { name: "Canadian dollar", symbol: "CA$", exponent: 2, locale: "en-CA" },
  JPY: { name: "Japanese yen", symbol: "¥", exponent: 0, locale: "ja-JP" },
  SAR: { name: "Saudi riyal", symbol: "SAR ", exponent: 2, locale: "en-SA" },
};

export const isCurrency = (v: unknown): v is CurrencyCode => typeof v === "string" && (CURRENCY_CODES as readonly string[]).includes(v);

/** "$25", "₹1,499", "£19", "¥3,000": the amount in the smallest unit written the way people in that currency write it. */
export function formatAmount(minor: number, currency: CurrencyCode): string {
  const info = CURRENCY_INFO[currency];
  const major = minor / 10 ** info.exponent;
  const digits = Number.isInteger(major) ? 0 : info.exponent;
  return `${info.symbol}${major.toLocaleString(info.locale, { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}
