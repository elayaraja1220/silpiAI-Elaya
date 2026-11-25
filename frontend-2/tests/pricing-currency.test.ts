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
  type P = { id: string; monthlyCreditUnits: number; active: boolean; trialDays: number | null; prices: { currency: string; period: string; amountMinor: number }[]; monthlyPricePaise: number | null; annualPricePaise: number | null; monthlyPriceUsdCents: number | null; annualPriceUsdCents: number | null; monthlyPriceGbpPence: number | null; annualPriceGbpPence: number | null };
  const all = async () => ((await import("@/server/subscriptions")).listPlans({ includeInactive: true }) as unknown as P[]);
  const price = (p: P, currency: string, period: string) => p.prices.find((x) => x.currency === currency && x.period === period)?.amountMinor ?? null;

  it("sells the brief's six plans and Enterprise, in that order", async () => {
    const { listPlans } = await import("@/server/subscriptions");
    assert.deepEqual(listPlans().map((p) => p.id), ["free", "starter", "creator", "pro", "professional", "studio", "enterprise"]);
  });
  it("each plan has the credits from the brief (one credit = 1,000 units)", async () => {
    const credits = Object.fromEntries((await all()).filter((p) => p.active).map((p) => [p.id, p.monthlyCreditUnits / 1000]));
    assert.deepEqual(credits, { free: 25, starter: 200, creator: 400, pro: 700, professional: 2000, studio: 4500, enterprise: 0 });
  });
  it("each plan has the dollar and rupee prices from the brief, and yearly is ten months", async () => {
    const plans = Object.fromEntries((await all()).map((p) => [p.id, p]));
    const usd = { free: 0, starter: 600, creator: 1200, pro: 1900, professional: 4900, studio: 9900 };
    const inr = { free: 0, starter: 49_900, creator: 99_900, pro: 149_900, professional: 449_900, studio: 899_900 };
    for (const [id, cents] of Object.entries(usd)) {
      assert.equal(price(plans[id]!, "USD", "monthly"), cents, `${id} USD`);
      assert.equal(price(plans[id]!, "USD", "annual"), cents * 10, `${id} USD yearly`);
    }
    for (const [id, paise] of Object.entries(inr)) {
      assert.equal(price(plans[id]!, "INR", "monthly"), paise, `${id} INR`);
      assert.equal(price(plans[id]!, "INR", "annual"), paise * 10, `${id} INR yearly`);
    }
    assert.equal(price(plans.enterprise!, "USD", "monthly"), null, "Enterprise has no list price");
  });
  it("pound prices exist for the UK (proposed figures)", async () => {
    const plans = Object.fromEntries((await all()).map((p) => [p.id, p]));
    assert.deepEqual(["starter", "creator", "pro", "professional", "studio"].map((id) => price(plans[id]!, "GBP", "monthly")), [500, 1000, 1500, 3900, 7900]);
  });
  it("the older rupee, dollar and pound fields on a plan agree with its prices", async () => {
    for (const p of await all()) {
      assert.equal(p.monthlyPricePaise, price(p, "INR", "monthly"), `${p.id} INR`);
      assert.equal(p.annualPriceUsdCents, price(p, "USD", "annual"), `${p.id} USD yearly`);
      assert.equal(p.monthlyPriceGbpPence, price(p, "GBP", "monthly"), `${p.id} GBP`);
    }
  });
  it("the earlier Pro and Professional sizes are retired, not deleted, and no plan has a trial by default", async () => {
    const plans = await all();
    for (const id of ["pro-800", "pro-1600", "pro-3200", "pro-6400", "professional-2400", "professional-4800", "professional-9600", "professional-19200"]) assert.equal(plans.find((p) => p.id === id)?.active, false, id);
    assert.ok(plans.every((p) => p.trialDays === null));
  });
  it("a retired plan cannot be chosen", async () => {
    const { startSubscription } = await import("@/server/subscriptions");
    const { createOrganization } = await import("@/server/tenancy");
    const org = createOrganization({ name: "Currency Org", type: "business" });
    assert.throws(() => startSubscription({ orgId: org.id, planId: "pro-800" }), /not available/);
  });
  it("the administrator can change a price in any currency, and bad values are refused", async () => {
    const { updatePlan, setPlanPrice, getPlan } = await import("@/server/subscriptions");
    assert.equal(updatePlan("pro", { monthlyPriceUsdCents: 2900 }).monthlyPriceUsdCents, 2900);
    assert.equal(price(getPlan("pro") as unknown as P, "USD", "monthly"), 2900, "the price itself moved too");
    assert.equal(getPlan("pro")!.monthlyPricePaise, 149_900, "the rupee price did not move");
    assert.throws(() => updatePlan("pro", { monthlyPriceUsdCents: -1 }), /cents/);
    assert.throws(() => updatePlan("pro", { monthlyPriceUsdCents: 19.5 }), /cents/);
    updatePlan("pro", { monthlyPriceUsdCents: 1900 });
    const euro = setPlanPrice({ planId: "pro", currency: "EUR", period: "monthly", amountMinor: 1800 });
    assert.equal(price(euro as unknown as P, "EUR", "monthly"), 1800, "a new currency needs no code");
    assert.equal(price(setPlanPrice({ planId: "pro", currency: "EUR", period: "monthly", amountMinor: null }) as unknown as P, "EUR", "monthly"), null, "null removes it");
    assert.throws(() => setPlanPrice({ planId: "pro", currency: "XYZ", period: "monthly", amountMinor: 5 }), /currency must be/);
    assert.throws(() => setPlanPrice({ planId: "pro", currency: "USD", period: "weekly", amountMinor: 5 }), /monthly or annual/);
    assert.throws(() => setPlanPrice({ planId: "pro", currency: "USD", period: "monthly", amountMinor: -5 }), /whole number/);
    assert.throws(() => setPlanPrice({ planId: "nope", currency: "USD", period: "monthly", amountMinor: 5 }), /does not exist/);
    assert.throws(() => setPlanPrice({ planId: "free", currency: "USD", period: "monthly", amountMinor: 5 }), /Free plan is free/);
  });
  it("changing a legacy-field price changes the real price, and the old field stays in step when a price is set directly", async () => {
    const { updatePlan, setPlanPrice, getPlan } = await import("@/server/subscriptions");
    setPlanPrice({ planId: "creator", currency: "GBP", period: "monthly", amountMinor: 1100 });
    assert.equal(getPlan("creator")!.monthlyPriceGbpPence, 1100);
    updatePlan("creator", { monthlyPriceGbpPence: 1000 });
    assert.equal(price(getPlan("creator") as unknown as P, "GBP", "monthly"), 1000);
  });
});

describe("5. the public price list", () => {
  it("carries every price, the visitor's country when the host reports it, and never changes anything", async () => {
    const route = await import("@/app/api/plans/route");
    const asked = (h: Record<string, string>) => route.GET(new NextRequest("http://localhost:3000/api/plans", { headers: h }));
    const india = await (await asked({ "x-vercel-ip-country": "IN" })).json();
    assert.equal(india.country, "IN");
    const pro = india.plans.find((p: { id: string }) => p.id === "pro");
    assert.equal(pro.monthlyPriceUsdCents, 1900);
    assert.equal(pro.monthlyPriceGbpPence, 1500);
    assert.ok(Array.isArray(pro.prices) && pro.prices.some((x: { currency: string; period: string; amountMinor: number }) => x.currency === "INR" && x.period === "monthly" && x.amountMinor === 149_900));
    assert.ok(!JSON.stringify(india).includes("pro-800"), "a retired plan is not advertised");
    assert.equal((await (await asked({})).json()).country, null);
    assert.deepEqual(Object.keys(route).filter((k) => ["POST", "PUT", "PATCH", "DELETE"].includes(k)), []);
  });
});
