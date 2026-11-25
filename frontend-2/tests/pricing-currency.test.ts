// Dollar prices, the retired Starter plan, and choosing the currency a visitor sees.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { NextRequest } from "next/server";

import { countryFromHeaders, currencyFromQuery, formatMoney, pickCurrency, priceIn } from "@/lib/geo";

const dir = mkdtempSync(path.join(tmpdir(), "silpi-currency-"));
before(() => { process.env.SILPI_DB_PATH = path.join(dir, "currency.db"); });
after(() => {
  const cached = globalThis as unknown as { silpiDb?: { close(): void } };
  cached.silpiDb?.close();
  delete cached.silpiDb;
  rmSync(dir, { recursive: true, force: true });
});

const headers = (o: Record<string, string>) => ({ get: (n: string) => o[n.toLowerCase()] ?? null });

describe("1. which country the host reports", () => {
  it("reads the common country headers and ignores unknown values", () => {
    assert.equal(countryFromHeaders(headers({ "x-vercel-ip-country": "in" })), "IN");
    assert.equal(countryFromHeaders(headers({ "cf-ipcountry": "US" })), "US");
    assert.equal(countryFromHeaders(headers({ "cloudfront-viewer-country": "GB" })), "GB");
    assert.equal(countryFromHeaders(headers({ "cf-ipcountry": "XX" })), null, "unknown");
    assert.equal(countryFromHeaders(headers({ "cf-ipcountry": "T1" })), null, "Tor");
    assert.equal(countryFromHeaders(headers({ "x-vercel-ip-country": "India" })), null, "not a two-letter code");
    assert.equal(countryFromHeaders(headers({})), null);
  });
});

describe("2. which currency to show", () => {
  it("India sees rupees, the United Kingdom pounds, and every other country (the United States included) dollars", () => {
    assert.equal(pickCurrency({ country: "IN" }), "INR");
    assert.equal(pickCurrency({ country: "GB" }), "GBP");
    assert.equal(pickCurrency({ country: "gb" }), "GBP", "case does not matter");
    for (const c of ["US", "AE", "SG", "DE", "AU", "CA", "FR"]) assert.equal(pickCurrency({ country: c }), "USD", c);
  });
  it("the host's country wins over the browser's guesses", () => {
    assert.equal(pickCurrency({ country: "US", timeZone: "Asia/Kolkata", language: "en-IN" }), "USD");
    assert.equal(pickCurrency({ country: "IN", timeZone: "America/New_York", language: "en-US" }), "INR");
    assert.equal(pickCurrency({ country: "GB", timeZone: "Asia/Kolkata", language: "en-IN" }), "GBP");
  });
  it("with no country, the time zone and then the language decide; the default is dollars", () => {
    assert.equal(pickCurrency({ timeZone: "Asia/Kolkata" }), "INR");
    assert.equal(pickCurrency({ timeZone: "Asia/Calcutta" }), "INR");
    assert.equal(pickCurrency({ timeZone: "Europe/London" }), "GBP");
    assert.equal(pickCurrency({ language: "ta-IN" }), "INR");
    assert.equal(pickCurrency({ language: "en-GB" }), "GBP");
    assert.equal(pickCurrency({ language: "en-US" }), "USD");
    assert.equal(pickCurrency({ timeZone: "Europe/Paris", language: "fr-FR" }), "USD");
    assert.equal(pickCurrency({}), "USD");
  });
  it("a currency named on purpose is accepted only if it is one we sell in", () => {
    assert.equal(currencyFromQuery("gbp"), "GBP");
    assert.equal(currencyFromQuery("INR"), "INR");
    assert.equal(currencyFromQuery("EUR"), null);
    assert.equal(currencyFromQuery(null), null);
    assert.equal(currencyFromQuery("<script>"), null);
  });
});

describe("3. showing a price", () => {
  const plan = { monthlyPricePaise: 149_900, annualPricePaise: 1_499_000, monthlyPriceUsdCents: 2500, annualPriceUsdCents: 25_000, monthlyPriceGbpPence: 1900, annualPriceGbpPence: 19_000 };
  it("picks the amount for the currency and the period, and the sign goes with it", () => {
    assert.equal(priceIn(plan, "USD", false), 2500);
    assert.equal(priceIn(plan, "USD", true), 25_000);
    assert.equal(priceIn(plan, "INR", false), 149_900);
    assert.equal(priceIn(plan, "GBP", false), 1900);
    assert.equal(priceIn(plan, "GBP", true), 19_000);
    assert.equal(priceIn({ ...plan, monthlyPriceUsdCents: null }, "USD", false), null, "a plan not sold in dollars has no dollar price");
    assert.equal(formatMoney(2500, "USD"), "$25");
    assert.equal(formatMoney(137_000, "USD"), "$1,370");
    assert.equal(formatMoney(2550, "USD"), "$25.50");
    assert.equal(formatMoney(149_900, "INR"), "₹1,499");
    assert.equal(formatMoney(1900, "GBP"), "£19");
    assert.equal(formatMoney(55_000, "GBP"), "£550");
    assert.equal(formatMoney(1250, "GBP"), "£12.50");
    assert.equal(formatMoney(0, "USD"), "$0");
  });
});

describe("4. the catalogue in the database", () => {
  it("Starter is retired, the others carry dollar prices, and Professional has 1,200 credits", async () => {
    const { listPlans } = await import("@/server/subscriptions");
    const plans = listPlans();
    assert.deepEqual(plans.map((p) => p.id), ["free", "pro", "professional", "enterprise"]);
    const by = Object.fromEntries(plans.map((p) => [p.id, p]));
    assert.deepEqual([by.free!.monthlyPriceUsdCents, by.pro!.monthlyPriceUsdCents, by.professional!.monthlyPriceUsdCents, by.enterprise!.monthlyPriceUsdCents], [0, 2500, 7000, null]);
    assert.deepEqual([by.pro!.annualPriceUsdCents, by.professional!.annualPriceUsdCents], [25_000, 70_000], "annual is ten months, as in rupees");
    assert.deepEqual([by.free!.monthlyPriceGbpPence, by.pro!.monthlyPriceGbpPence, by.professional!.monthlyPriceGbpPence, by.enterprise!.monthlyPriceGbpPence], [0, 1900, 5500, null], "pound prices for the UK");
    assert.deepEqual([by.pro!.annualPriceGbpPence, by.professional!.annualPriceGbpPence], [19_000, 55_000]);
    assert.equal(by.professional!.monthlyCreditUnits, 1_200_000);
    assert.equal(by.pro!.monthlyPricePaise, 149_900, "rupee prices are untouched");
    assert.ok(listPlans({ includeInactive: true }).some((p) => p.id === "starter" && !p.active), "kept for history, not offered");
  });
  it("a retired plan cannot be chosen", async () => {
    const { startSubscription } = await import("@/server/subscriptions");
    const { createOrganization } = await import("@/server/tenancy");
    const org = createOrganization({ name: "Currency Org", type: "business" });
    assert.throws(() => startSubscription({ orgId: org.id, planId: "starter" }), /not available/);
  });
  it("the administrator can change a dollar price, and bad values are refused", async () => {
    const { updatePlan, getPlan } = await import("@/server/subscriptions");
    assert.equal(updatePlan("pro", { monthlyPriceUsdCents: 2900 }).monthlyPriceUsdCents, 2900);
    assert.equal(getPlan("pro")!.monthlyPricePaise, 149_900, "the rupee price did not move");
    assert.throws(() => updatePlan("pro", { monthlyPriceUsdCents: -1 }), /cents/);
    assert.throws(() => updatePlan("pro", { monthlyPriceUsdCents: 19.5 }), /cents/);
    assert.equal(updatePlan("pro", { monthlyPriceUsdCents: 2500 }).monthlyPriceUsdCents, 2500);
    assert.equal(updatePlan("pro", { monthlyPriceGbpPence: 2000 }).monthlyPriceGbpPence, 2000);
    assert.throws(() => updatePlan("pro", { monthlyPriceGbpPence: -1 }), /pence/);
    assert.equal(updatePlan("pro", { monthlyPriceGbpPence: 1900 }).monthlyPriceGbpPence, 1900);
  });
});

describe("5. the public price list", () => {
  it("carries all three currencies and the visitor's country when the host reports it, and never changes anything", async () => {
    const route = await import("@/app/api/plans/route");
    const asked = (h: Record<string, string>) => route.GET(new NextRequest("http://localhost:3000/api/plans", { headers: h }));
    const india = await (await asked({ "x-vercel-ip-country": "IN" })).json();
    assert.equal(india.country, "IN");
    assert.ok(india.plans.every((p: { monthlyPriceUsdCents?: number | null; monthlyPriceGbpPence?: number | null }) => "monthlyPriceUsdCents" in p && "monthlyPriceGbpPence" in p));
    assert.equal(india.plans.find((p: { id: string }) => p.id === "pro").monthlyPriceGbpPence, 1900);
    assert.equal(india.plans.find((p: { id: string }) => p.id === "pro").monthlyPriceUsdCents, 2500);
    assert.ok(!JSON.stringify(india).includes("starter"), "a retired plan is not advertised");
    assert.equal((await (await asked({})).json()).country, null);
    assert.deepEqual(Object.keys(route).filter((k) => ["POST", "PUT", "PATCH", "DELETE"].includes(k)), []);
  });
});
