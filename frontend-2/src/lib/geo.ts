/**
 * Which currency to show a visitor. Pure functions, no network: the country comes from a header the hosting platform adds, and
 * when there is none (local development, or a host that does not add one) the browser's time zone and language are the guide.
 *
 *   India          -> rupees   (₹)
 *   United Kingdom -> pounds   (£)
 *   everywhere else, the United States included -> US dollars ($)
 */

export type Currency = "USD" | "INR" | "GBP";
export const CURRENCIES: readonly Currency[] = ["USD", "INR", "GBP"];

/** Headers the common hosts add with the visitor's two-letter country: Vercel, Cloudflare, CloudFront, and a generic one. */
const COUNTRY_HEADERS = ["x-vercel-ip-country", "cf-ipcountry", "cloudfront-viewer-country", "x-country-code"];

export function countryFromHeaders(headers: { get(name: string): string | null }): string | null {
  for (const name of COUNTRY_HEADERS) {
    const v = headers.get(name)?.trim().toUpperCase();
    // "XX" (unknown) and "T1" (Tor) are not countries.
    if (v && /^[A-Z]{2}$/.test(v) && v !== "XX" && v !== "T1") return v;
  }
  return null;
}

const currencyOfCountry = (country: string): Currency => (country === "IN" ? "INR" : country === "GB" || country === "UK" ? "GBP" : "USD");
const currencyOfTimeZone = (tz: string): Currency | null => (tz === "Asia/Kolkata" || tz === "Asia/Calcutta" ? "INR" : tz === "Europe/London" || tz === "Europe/Belfast" ? "GBP" : null);

export function pickCurrency(input: { country?: string | null; timeZone?: string | null; language?: string | null }): Currency {
  if (input.country) return currencyOfCountry(input.country.toUpperCase());
  const byZone = input.timeZone ? currencyOfTimeZone(input.timeZone) : null;
  if (byZone) return byZone;
  const region = /^[a-z]{2,3}-([A-Za-z]{2})\b/.exec(input.language ?? "")?.[1]?.toUpperCase();
  return region ? (region === "IN" ? "INR" : region === "GB" ? "GBP" : "USD") : "USD";
}

/** A currency named on purpose, for example by a support person checking what a customer sees: ?currency=GBP. */
export function currencyFromQuery(value: string | null | undefined): Currency | null {
  const v = value?.trim().toUpperCase();
  return (CURRENCIES as readonly string[]).includes(v ?? "") ? (v as Currency) : null;
}

export type PriceInput = {
  monthlyPricePaise: number | null; annualPricePaise: number | null;
  monthlyPriceUsdCents: number | null; annualPriceUsdCents: number | null;
  monthlyPriceGbpPence: number | null; annualPriceGbpPence: number | null;
};

/** The amount in the smallest unit of the chosen currency (paise, cents or pence), or null when the plan is not sold in it. */
export function priceIn(plan: PriceInput, currency: Currency, annual: boolean): number | null {
  if (currency === "USD") return annual ? plan.annualPriceUsdCents : plan.monthlyPriceUsdCents;
  if (currency === "GBP") return annual ? plan.annualPriceGbpPence : plan.monthlyPriceGbpPence;
  return annual ? plan.annualPricePaise : plan.monthlyPricePaise;
}

const SIGN: Record<Currency, string> = { USD: "$", INR: "₹", GBP: "£" };
const LOCALE: Record<Currency, string> = { USD: "en-US", INR: "en-IN", GBP: "en-GB" };

/** "$25", "$1,370", "₹1,499", "£19". Whole amounts show no decimals; anything else shows two. */
export function formatMoney(minor: number, currency: Currency): string {
  const major = minor / 100;
  const digits = Number.isInteger(major) ? 0 : 2;
  return `${SIGN[currency]}${major.toLocaleString(LOCALE[currency], { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}
