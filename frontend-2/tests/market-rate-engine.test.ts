// The market rate engine and the country reference data: pure, exact, and honest about what it does not know.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { COUNTRIES, countryOf, currencyOfCountry, flagOf, minorDigits, pickCountry } from "@/lib/business/countries";
import { CURRENCIES } from "@/lib/business/currency";
import { ANY_ROLE, applyBilling, DEFAULT_PRICING_CONFIG, hourlyFromAnnual, mulDiv, rateProblems, resolveRate, type MarketRate, type PricingConfig } from "@/lib/business/market-rates";

let id = 0;
const row = (over: Partial<MarketRate> = {}): MarketRate => ({ id: ++id, country: "GB", roleId: "full-stack", levelId: "mid", kind: "freelancer", currency: "GBP", minMinor: 4000, medianMinor: 5500, maxMinor: 8000, source: "Test survey 2026, table 4", sourceUrl: "", effectiveDate: "2026-01-01", enteredBy: "t", enteredAt: "2026-01-01T00:00:00Z", enabled: true, illustrative: false, note: "", ...over });
const cfg = (over: Partial<PricingConfig> = {}): PricingConfig => ({ ...DEFAULT_PRICING_CONFIG, ...over });
const q = (over: Partial<{ country: string; roleId: string; levelId: string; kind: "employee" | "freelancer" | "agency" }> = {}) => ({ country: "GB", roleId: "full-stack", levelId: "mid", kind: "freelancer" as const, ...over });
const TODAY = "2026-11-26";

describe("1. exact money arithmetic", () => {
  it("multiplies and divides in whole numbers, rounding half up, however large", () => {
    assert.equal(mulDiv(10, 3, 2), 15);
    assert.equal(mulDiv(7, 1, 2), 4, "3.5 rounds up");
    assert.equal(mulDiv(5, 1, 3), 2, "1.67 rounds up");
    assert.equal(mulDiv(4, 1, 3), 1, "1.33 rounds down");
    assert.equal(mulDiv(9_007_199_254_740, 25_000, 10_000), 22_517_998_136_850, "no floating point loss at the top of the range");
    assert.equal(mulDiv(0, 5, 3), 0);
  });
  it("turns a yearly salary into an hourly figure the way the brief describes: salary / 2,080 hours", () => {
    assert.equal(hourlyFromAnnual(600_000 * 100, 2080), 28_846, "Rs 6,00,000 -> Rs 288.46");
    assert.equal(hourlyFromAnnual(1_500_000 * 100, 2080), 72_115, "Rs 15,00,000 -> Rs 721.15");
    assert.equal(hourlyFromAnnual(3_000_000 * 100, 2080), 144_231, "Rs 30,00,000 -> Rs 1,442.31");
  });
  it("applies the multiplier, then the overhead, then the margin, each rounded to the smallest unit", () => {
    const b = { multiplierBp: 25_000, overheadBp: 1_000, marginBp: 2_000 };
    assert.equal(applyBilling(28_846, b), 95_192, "28,846 x 2.5 = 72,115; +10% = 79,326.5 -> 79,327; +20% = 95,192.4 -> 95,192");
    assert.equal(applyBilling(28_846, { multiplierBp: 10_000, overheadBp: 0, marginBp: 0 }), 28_846, "x1.00 changes nothing");
    assert.equal(applyBilling(1, { multiplierBp: 10_000, overheadBp: 0, marginBp: 5_000 }), 2, "half a unit rounds up");
  });
});

describe("2. finding the rate", () => {
  it("returns the figures, what to charge, where they come from and how old they are", () => {
    const r = resolveRate([row()], q(), cfg(), TODAY);
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.deepEqual([r.currency, r.minMinor, r.medianMinor, r.maxMinor, r.billedMinor, r.matchedRole, r.source, r.effectiveDate, r.ageDays, r.stale, r.illustrative], ["GBP", 4000, 5500, 8000, 5500, "full-stack", "Test survey 2026, table 4", "2026-01-01", 329, false, false]);
  });
  it("charges the median with the settings applied, and the low and high ends move the same way", () => {
    const r = resolveRate([row({ kind: "agency" })], q({ kind: "agency" }), cfg({ billing: { ...DEFAULT_PRICING_CONFIG.billing, agency: { multiplierBp: 12_000, overheadBp: 0, marginBp: 0 } } }), TODAY);
    assert.ok(r.ok);
    if (r.ok) assert.deepEqual([r.billedMinMinor, r.billedMinor, r.billedMaxMinor, r.billsAtCost], [4800, 6600, 9600, false]);
  });
  it("uses the newest figure that has started, ignores one that has not, and ignores a switched-off one", () => {
    const rows = [row({ effectiveDate: "2025-01-01", medianMinor: 4000 }), row({ effectiveDate: "2026-06-01", medianMinor: 5000 }), row({ effectiveDate: "2027-01-01", medianMinor: 9000 }), row({ effectiveDate: "2026-09-01", medianMinor: 7000, enabled: false })];
    const r = resolveRate(rows, q(), cfg(), TODAY);
    assert.ok(r.ok && r.medianMinor === 5000, "2026-06-01 is the newest enabled figure that has started");
    const same = resolveRate([row({ effectiveDate: "2026-06-01", medianMinor: 5000 }), row({ effectiveDate: "2026-06-01", medianMinor: 5200 })], q(), cfg(), TODAY);
    assert.ok(same.ok && same.medianMinor === 5200, "on the same day the one entered later wins");
  });
  it("falls back to the any-role figure for the same country, level and kind, but never to another level, kind or country", () => {
    const anyRow = row({ roleId: ANY_ROLE, medianMinor: 3000 });
    const r = resolveRate([anyRow], q(), cfg(), TODAY);
    assert.ok(r.ok && r.matchedRole === ANY_ROLE && r.medianMinor === 3000);
    for (const other of [q({ levelId: "senior" }), q({ kind: "employee" }), q({ country: "DE" })]) assert.equal(resolveRate([anyRow], other, cfg(), TODAY).ok, false, JSON.stringify(other));
    const exact = resolveRate([anyRow, row({ medianMinor: 6000 })], q(), cfg(), TODAY);
    assert.ok(exact.ok && exact.matchedRole === "full-stack", "a figure for the exact role beats the any-role one");
  });
  it("says there is no rate rather than guessing, and says why", () => {
    const none = resolveRate([], q(), cfg(), TODAY);
    assert.deepEqual([none.ok, !none.ok && none.reason], [false, "no-rate"]);
    assert.match(!none.ok ? none.message : "", /no verified freelancer billing rate/i);
    for (const country of ["", "  ", "India", "I", null, undefined]) assert.deepEqual([resolveRate([row()], q({ country: country as string }), cfg(), TODAY).ok], [false], String(country));
    assert.equal(resolveRate([row()], q({ country: "gb" }), cfg(), TODAY).ok, true, "case does not matter");
  });
  it("flags a figure that is out of date without hiding it, and one that is an assumption", () => {
    const old = resolveRate([row({ effectiveDate: "2024-01-01" })], q(), cfg({ staleAfterDays: 365 }), TODAY);
    assert.ok(old.ok && old.stale && old.ageDays > 365);
    const fresh = resolveRate([row({ effectiveDate: "2024-01-01" })], q(), cfg({ staleAfterDays: 1500 }), TODAY);
    assert.ok(fresh.ok && !fresh.stale, "the limit is the administrator's");
    const illustrative = resolveRate([row({ illustrative: true })], q(), cfg(), TODAY);
    assert.ok(illustrative.ok && illustrative.illustrative);
  });
  it("says when an employee wage would be charged as it is, earning nothing above cost", () => {
    const wage = row({ kind: "employee" });
    const plain = resolveRate([wage], q({ kind: "employee" }), cfg(), TODAY);
    assert.ok(plain.ok && plain.billsAtCost, "x1.00, no overhead, no margin: bills at cost");
    const priced = resolveRate([wage], q({ kind: "employee" }), cfg({ billing: { ...DEFAULT_PRICING_CONFIG.billing, employee: { multiplierBp: 25_000, overheadBp: 0, marginBp: 0 } } }), TODAY);
    assert.ok(priced.ok && !priced.billsAtCost && priced.billedMinor === 13_750);
  });
});

describe("3. checking a rate before it is kept", () => {
  const ok = { min: 4000, median: 5500, max: 8000, source: "Office for National Statistics, ASHE 2025", effectiveDate: "2026-01-01" };
  it("accepts a complete, ordered rate", () => assert.deepEqual(rateProblems(ok, TODAY), []));
  it("refuses figures that are missing, fractional, non-positive, out of order or absurd", () => {
    for (const bad of [{ min: 0 }, { median: -1 }, { max: 12.5 }, { min: "4000" }, { min: 6000 }, { max: 5000 }, { max: 2_000_000_000 }]) assert.ok(rateProblems({ ...ok, ...bad } as never, TODAY).length > 0, JSON.stringify(bad));
  });
  it("insists on a source and a start date that is real and not in the future", () => {
    for (const bad of [{ source: "" }, { source: "ONS" }, { source: 5 }, { effectiveDate: "" }, { effectiveDate: "26/11/2026" }, { effectiveDate: "2026-13-40" }, { effectiveDate: "2027-01-01" }]) assert.ok(rateProblems({ ...ok, ...bad } as never, TODAY).length > 0, JSON.stringify(bad));
  });
});

describe("4. countries", () => {
  it("every country is unique, has a supported currency, and the main markets in the brief are there", () => {
    assert.equal(new Set(COUNTRIES.map((c) => c.code)).size, COUNTRIES.length);
    const known = new Set(CURRENCIES.map((c) => c.code));
    for (const c of COUNTRIES) assert.ok(known.has(c.currency), `${c.code} uses ${c.currency}`);
    for (const [code, currency] of [["US", "USD"], ["IN", "INR"], ["GB", "GBP"], ["DE", "EUR"], ["AU", "AUD"], ["CA", "CAD"], ["SG", "SGD"]]) assert.equal(currencyOfCountry(code), currency, code);
    assert.equal(countryOf("us")?.name, "United States");
    assert.equal(countryOf("ZZ"), null);
  });
  it("writes a flag from the two letters and knows how many decimals each currency has", () => {
    assert.equal(flagOf("IN"), "🇮🇳");
    assert.equal(flagOf("gb"), "🇬🇧");
    assert.equal(flagOf("India"), "");
    assert.deepEqual(["USD", "JPY", "KRW", "KWD", "INR"].map(minorDigits), [2, 0, 0, 3, 2]);
  });
  it("trusts what a person chose over a profile, a billing country, and where the request seemed to come from, which only pre-fills", () => {
    assert.deepEqual(pickCountry({ chosen: "DE", profile: "US", billing: "GB", location: "IN" }), { code: "DE", source: "chosen" });
    assert.deepEqual(pickCountry({ profile: "us", billing: "GB", location: "IN" }), { code: "US", source: "profile" });
    assert.deepEqual(pickCountry({ billing: "GB", location: "IN" }), { code: "GB", source: "billing" });
    assert.deepEqual(pickCountry({ location: "in" }), { code: "IN", source: "location" });
    assert.deepEqual(pickCountry({ chosen: "ZZ", profile: "", billing: null, location: "XX" }), null, "unknown codes are skipped, and nothing is invented");
    assert.equal(pickCountry({}), null);
  });
});
