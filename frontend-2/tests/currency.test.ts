// A client abroad gives a budget in their own money; it is converted to rupees. Run: npm test
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CURRENCIES, FALLBACK_INR_PER_UNIT, currencyOf, inrPerUnitFrom, searchCurrencies, toInr } from "@/lib/business/currency";

describe("finding a currency", () => {
  const codes = (q: string) => searchCurrencies(q).map((c) => c.code);
  it("by country, currency name, code or symbol, in any case", () => {
    assert.deepEqual(codes("usa"), ["USD"]);
    assert.ok(codes("united").includes("USD") && codes("united").includes("GBP") && codes("united").includes("AED"));
    assert.deepEqual(codes("CANADA"), ["CAD"]);
    assert.deepEqual(codes("pound"), ["GBP"]);
    assert.deepEqual(codes("£"), ["GBP"]);
    assert.ok(codes("$").length >= 6, "several countries share the dollar sign");
    assert.ok(codes("dubai").includes("AED"));
    assert.ok(codes("germany").includes("EUR"));
  });
  it("an empty search lists every currency, and nonsense lists none", () => {
    assert.equal(searchCurrencies("").length, CURRENCIES.length);
    assert.deepEqual(searchCurrencies("zzzz"), []);
  });
  it("every listed currency has a fallback rate, and rupees come first", () => {
    for (const c of CURRENCIES) assert.ok(FALLBACK_INR_PER_UNIT[c.code] > 0, c.code);
    assert.equal(CURRENCIES[0].code, "INR");
    assert.equal(currencyOf("nope").code, "INR");
  });
});

describe("converting to rupees", () => {
  const rates = { INR: 1, USD: 88, GBP: 112 };
  it("multiplies by the rate and rounds to whole rupees", () => {
    assert.equal(toInr(1000, "USD", rates), 88_000);
    assert.equal(toInr(1500.5, "GBP", rates), Math.round(1500.5 * 112));
    assert.equal(toInr(250_000, "INR", rates), 250_000);
  });
  it("gives 0 (no budget) for nothing usable, never a wrong amount", () => {
    assert.equal(toInr(0, "USD", rates), 0);
    assert.equal(toInr(-5, "USD", rates), 0);
    assert.equal(toInr(Number.NaN, "USD", rates), 0);
    assert.equal(toInr(100, "XYZ", rates), 0, "unknown currency");
    assert.equal(toInr(100, "USD", { USD: 0 }), 0);
  });
  it("reads the service's 'units per rupee' into rupees per unit, ignoring bad values", () => {
    const r = inrPerUnitFrom({ USD: 0.0125, GBP: "0.01", EUR: -1, CAD: "x", INR: 1 });
    assert.equal(r.INR, 1);
    assert.ok(Math.abs(r.USD - 80) < 1e-9);
    assert.ok(Math.abs(r.GBP - 100) < 1e-9);
    assert.ok(!("EUR" in r) && !("CAD" in r), "unusable rates are left out so the approximate ones are used");
  });
});
