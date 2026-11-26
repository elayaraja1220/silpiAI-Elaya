/**
 * Reference data: the countries SILPI can quote for, with the currency each uses, and the smallest-unit size of each currency.
 * These are facts (ISO 3166 and ISO 4217), not prices. Market rates are separate, kept in the database with a source for every figure.
 * Pure, shared by the browser and the server.
 */
export type Country = { code: string; name: string; currency: string };

export const COUNTRIES: readonly Country[] = [
  { code: "IN", name: "India", currency: "INR" },
  { code: "US", name: "United States", currency: "USD" },
  { code: "GB", name: "United Kingdom", currency: "GBP" },
  { code: "DE", name: "Germany", currency: "EUR" },
  { code: "FR", name: "France", currency: "EUR" },
  { code: "IT", name: "Italy", currency: "EUR" },
  { code: "ES", name: "Spain", currency: "EUR" },
  { code: "NL", name: "Netherlands", currency: "EUR" },
  { code: "IE", name: "Ireland", currency: "EUR" },
  { code: "BE", name: "Belgium", currency: "EUR" },
  { code: "AT", name: "Austria", currency: "EUR" },
  { code: "PT", name: "Portugal", currency: "EUR" },
  { code: "FI", name: "Finland", currency: "EUR" },
  { code: "GR", name: "Greece", currency: "EUR" },
  { code: "CA", name: "Canada", currency: "CAD" },
  { code: "AU", name: "Australia", currency: "AUD" },
  { code: "NZ", name: "New Zealand", currency: "NZD" },
  { code: "SG", name: "Singapore", currency: "SGD" },
  { code: "HK", name: "Hong Kong", currency: "HKD" },
  { code: "AE", name: "United Arab Emirates", currency: "AED" },
  { code: "SA", name: "Saudi Arabia", currency: "SAR" },
  { code: "QA", name: "Qatar", currency: "QAR" },
  { code: "KW", name: "Kuwait", currency: "KWD" },
  { code: "OM", name: "Oman", currency: "OMR" },
  { code: "BH", name: "Bahrain", currency: "BHD" },
  { code: "MY", name: "Malaysia", currency: "MYR" },
  { code: "TH", name: "Thailand", currency: "THB" },
  { code: "ID", name: "Indonesia", currency: "IDR" },
  { code: "PH", name: "Philippines", currency: "PHP" },
  { code: "JP", name: "Japan", currency: "JPY" },
  { code: "CN", name: "China", currency: "CNY" },
  { code: "KR", name: "South Korea", currency: "KRW" },
  { code: "CH", name: "Switzerland", currency: "CHF" },
  { code: "ZA", name: "South Africa", currency: "ZAR" },
  { code: "LK", name: "Sri Lanka", currency: "LKR" },
  { code: "NP", name: "Nepal", currency: "NPR" },
  { code: "BD", name: "Bangladesh", currency: "BDT" },
];

export const countryOf = (code: string | null | undefined): Country | null => COUNTRIES.find((c) => c.code === String(code ?? "").toUpperCase()) ?? null;
export const currencyOfCountry = (code: string | null | undefined): string | null => countryOf(code)?.currency ?? null;

/** The flag as an emoji, from the two letters of the country code. */
export const flagOf = (code: string): string => (/^[A-Za-z]{2}$/.test(code) ? String.fromCodePoint(...code.toUpperCase().split("").map((c) => 0x1f1e6 + c.charCodeAt(0) - 65)) : "");

/** Digits after the decimal point in the smallest unit of a currency (ISO 4217): the yen and won have none, three Gulf dinars/rials have three. */
const ZERO = new Set(["JPY", "KRW"]);
const THREE = new Set(["KWD", "OMR", "BHD"]);
export const minorDigits = (currency: string): number => (ZERO.has(currency) ? 0 : THREE.has(currency) ? 3 : 2);

/**
 * The country to use for a quotation, in order of trust: what a person chose on purpose, then the account profile, then a verified billing country, then
 * the country a request seemed to come from. The last is only a guess (a VPN, a company network, a missing header), so it only ever PRE-FILLS the choice:
 * the person confirms it. Time zone and language are not used. A code that is not a supported country is skipped.
 */
export type CountrySource = "chosen" | "profile" | "billing" | "location";
export function pickCountry(input: { chosen?: string | null; profile?: string | null; billing?: string | null; location?: string | null }): { code: string; source: CountrySource } | null {
  const order: [CountrySource, string | null | undefined][] = [["chosen", input.chosen], ["profile", input.profile], ["billing", input.billing], ["location", input.location]];
  for (const [source, code] of order) {
    const c = countryOf(code);
    if (c) return { code: c.code, source };
  }
  return null;
}
