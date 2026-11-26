// Quotations for clients abroad: priced from an hourly rate in THEIR currency, held in rupees, shown in their currency, never moved by the exchange rate.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatMoney, fromRupees, INR_MONEY, moneyOf, symbolOf, toRupees } from "@/lib/business/money";
import { buildQuote, quoteMoney } from "@/lib/business/pricing";
import { buildProposals } from "@/lib/business/proposals";
import { DEFAULT_RATE_CARD } from "@/lib/business/rate-card";
import type { Client, ModuleId, RateCard, Requirement } from "@/lib/business/types";
import { parseClient, parseCountryPricing, parseRateCard } from "@/lib/business/validate";

const withPrices = (unit = 121.3, hourly = 25): RateCard => ({ ...DEFAULT_RATE_CARD, countryPricing: { GBP: { hourlyRate: hourly, inrPerUnit: unit }, USD: { hourlyRate: 30, inrPerUnit: 92.8 } } });
const rates = withPrices();
const india: Pick<Client, "state" | "currency"> = { state: "Tamil Nadu" };
const uk: Pick<Client, "state" | "currency"> = { state: "Outside India", currency: "GBP" };
const SIX = ["Home", "About Us", "Services", "Products / Portfolio", "Gallery", "Contact Us"];
function req(modules: ModuleId[] = ["contact-form"]): Requirement {
  return { title: "Site", summary: "A website.", scope: "full", existingProject: "", version: "", projectType: "business-website", complexity: "basic", pages: SIX, modules, design: "ai", references: "", domain: { needed: false, choice: "self", name: "", tld: ".com", years: 1 }, hosting: { needed: false, choice: "self", plan: "static", years: 1 }, deadlineWeeks: 0, budget: 0 };
}
const pounds = (quote: { inrPerUnit?: number }, inr: number) => fromRupees(inr, { code: "GBP", unit: quote.inrPerUnit ?? 1 });

describe("1. which currency a quotation is in", () => {
  it("is the client's own currency only for a client outside India whose country has a price; otherwise rupees", () => {
    assert.deepEqual(quoteMoney(uk, rates), { code: "GBP", unit: 121.3 });
    assert.deepEqual(quoteMoney({ state: "Tamil Nadu", currency: "GBP" }, rates), INR_MONEY, "a client in India is always rupees");
    assert.deepEqual(quoteMoney({ state: "Outside India", currency: "EUR" }, rates), INR_MONEY, "no EUR price set: rupees, not a guess");
    assert.deepEqual(quoteMoney({ state: "Outside India" }, rates), INR_MONEY);
    assert.deepEqual(quoteMoney({ state: "Outside India", currency: "INR" }, rates), INR_MONEY);
    assert.deepEqual(quoteMoney(uk, DEFAULT_RATE_CARD), INR_MONEY, "an untouched rate card never changes anything");
  });
  it("a saved quote says how to show itself; old and rupee quotes say nothing", () => {
    const q = buildQuote(req(), uk, rates);
    assert.deepEqual([q.currency, q.inrPerUnit], ["GBP", 121.3]);
    const old = buildQuote(req(), india, rates);
    assert.ok(!("currency" in old) && !("inrPerUnit" in old), "rupee quotes are exactly what they always were");
    assert.deepEqual(moneyOf(q), { code: "GBP", unit: 121.3 });
    for (const junk of [undefined, null, {}, { currency: "GBP" }, { currency: "GBP", inrPerUnit: 0 }, { currency: "ZZZ", inrPerUnit: 5 }, { currency: "GBP", inrPerUnit: NaN }, { currency: "INR", inrPerUnit: 9 }]) assert.deepEqual(moneyOf(junk as never), INR_MONEY, JSON.stringify(junk));
  });
});

describe("2. the price", () => {
  it("every development line is hours x the pound rate, exactly, and the lines add up to the total", () => {
    const q = buildQuote(req(), uk, rates);
    const hourly = q.items.filter((i) => i.unit === "hour");
    assert.ok(hourly.length > 5);
    for (const i of hourly) {
      assert.equal(pounds(q, i.rate), 25, "the hourly price is 25 pounds");
      assert.equal(pounds(q, i.amount), Math.round(i.qty * 25 * 100) / 100, `${i.description}: ${i.qty} h`);
    }
    const lines = q.items.reduce((n, i) => n + pounds(q, i.amount), 0);
    assert.equal(Math.round(lines * 100) / 100, pounds(q, q.subtotal), "the lines add up to the subtotal");
    assert.equal(pounds(q, q.grandTotal), Math.round(pounds(q, q.grandTotal)), "the total is a whole pound, as the rupee total is a whole rupee");
    assert.equal(Math.round((pounds(q, q.subtotal) - pounds(q, q.discount) + pounds(q, q.gst.total) + pounds(q, q.roundOff)) * 100) / 100, pounds(q, q.grandTotal), "subtotal + round-off = total");
  });
  it("there is no Indian GST on an export, and the advance and balance add up to the total in pounds", () => {
    const q = buildQuote(req(), uk, rates);
    assert.deepEqual([q.gst.mode, q.gst.total], ["export", 0]);
    const [advance, balance] = q.schedule.map((s) => pounds(q, s.amount));
    assert.equal(advance! + balance!, pounds(q, q.grandTotal));
    assert.equal(advance, Math.round(pounds(q, q.grandTotal) * 0.5), "the advance is half, to a whole pound");
  });
  it("the price in pounds does NOT move when the exchange rate does: only the rupee figures do", () => {
    const a = buildQuote(req(["contact-form", "booking"]), uk, withPrices(121.3));
    const b = buildQuote(req(["contact-form", "booking"]), uk, withPrices(95));
    assert.equal(pounds(a, a.grandTotal), pounds(b, b.grandTotal), "the same pounds");
    assert.notEqual(a.grandTotal, b.grandTotal, "the books in rupees do follow the rate");
    assert.ok(Math.abs(a.grandTotal / 121.3 - b.grandTotal / 95) < 1e-6);
  });
  it("a different hourly price changes the pounds in proportion", () => {
    const cheap = buildQuote(req(), uk, withPrices(121.3, 20));
    const dear = buildQuote(req(), uk, withPrices(121.3, 40));
    assert.ok(Math.abs(pounds(dear, dear.subtotal) / pounds(cheap, cheap.subtotal) - 2) < 0.01);
  });
  it("the same project quoted in rupees is unchanged by any of this", () => {
    const a = buildQuote(req(), india, rates);
    const b = buildQuote(req(), india, DEFAULT_RATE_CARD);
    assert.deepEqual(a, b);
    assert.equal(a.items[0]!.rate, 500);
  });
  it("a discount and Phase 2 prices are in the same currency", () => {
    const q = buildQuote({ ...req(["contact-form"]), deferredModules: ["booking"] }, uk, rates, toRupees(50, { code: "GBP", unit: 121.3 }));
    assert.equal(pounds(q, q.discount), 50);
    assert.ok(q.deferred!.amount > 0, "a Phase 2 price is shown too");
    const hours = Math.round(24 * 0.85 * 2) / 2;
    assert.equal(pounds(q, q.deferred!.amount), hours * 25, "in pounds: its hours at the pound rate");
  });
  it("all three packages are in the client's currency and are in order of price", () => {
    const proposals = buildProposals(req(["contact-form", "booking", "seo-setup"]), uk, rates);
    const [basic, standard, premium] = ["basic", "standard", "premium"].map((t) => proposals.find((p) => p.tier === t)!);
    for (const p of [basic!, standard!, premium!]) assert.deepEqual([p.quote.currency, p.quote.inrPerUnit], ["GBP", 121.3]);
    assert.ok(basic!.grandTotal <= standard!.grandTotal && standard!.grandTotal <= premium!.grandTotal);
  });
  it("domain and hosting renewals are written in the client's currency", () => {
    const q = buildQuote({ ...req(), domain: { needed: true, choice: "arrange", name: "acme", tld: ".com", years: 2 }, hosting: { needed: true, choice: "arrange", plan: "shared", years: 1 } as never }, uk, rates);
    const text = JSON.stringify(q.services);
    assert.match(text, /£\d[\d,.]* per year after that/);
    assert.ok(!text.includes("₹"), "no rupee sign in a quotation for a client in pounds");
  });
});

describe("3. writing an amount", () => {
  it("rupees are written exactly as before; other currencies in their own symbol", () => {
    assert.equal(formatMoney(1234.5), "₹1,234.50");
    assert.equal(formatMoney(123456), "₹1,23,456.00", "lakh grouping");
    assert.equal(formatMoney(19711.25, { code: "GBP", unit: 121.3 }), "£162.50");
    assert.equal(formatMoney(9280, { code: "USD", unit: 92.8 }), "$100.00");
    assert.equal(formatMoney(0, { code: "GBP", unit: 121.3 }), "£0.00");
    assert.equal(formatMoney(-121.3, { code: "GBP", unit: 121.3 }), "-£1.00");
    assert.match(formatMoney(5800, { code: "JPY", unit: 0.58 }), /^¥10,000$/, "yen have no decimals");
    assert.match(formatMoney(121.3 * 3, { code: "EUR", unit: 101.7 }), /^€/);
  });
  it("knows the symbol of a currency, and converts both ways to a whole cent", () => {
    assert.equal(symbolOf("GBP"), "£");
    assert.equal(symbolOf("INR"), "₹");
    const m = { code: "GBP", unit: 121.3 };
    assert.equal(toRupees(25, m), 3032.5);
    assert.equal(fromRupees(3032.5, m), 25);
    assert.equal(fromRupees(toRupees(162.5, m), m), 162.5);
  });
});

describe("4. what is saved and what is refused", () => {
  const client = { name: "Acme", email: "a@b.co", phone: "+44 20 7946 0000", company: "", gstin: "", address: "" };
  it("a client abroad keeps their currency; a client in India does not; an unknown one is refused", () => {
    assert.equal(parseClient({ ...client, state: "Outside India", currency: "gbp" }).currency, "GBP");
    assert.equal(parseClient({ ...client, state: "Tamil Nadu", currency: "GBP" }).currency, undefined);
    assert.equal(parseClient({ ...client, state: "Outside India" }).currency, undefined);
    assert.equal(parseClient({ ...client, state: "Outside India", currency: "INR" }).currency, undefined);
    assert.throws(() => parseClient({ ...client, state: "Outside India", currency: "ZZZ" }), /not a currency we can quote in/);
  });
  it("the prices for each country are checked, and a missing or broken one is refused rather than guessed", () => {
    assert.deepEqual(parseCountryPricing({ GBP: { hourlyRate: "25", inrPerUnit: "121.3" }, INR: { hourlyRate: 1, inrPerUnit: 1 } }), { GBP: { hourlyRate: 25, inrPerUnit: 121.3, auto: true } }, "rupees are the main rate and are skipped; following the market is the default");
    assert.deepEqual(parseCountryPricing({ GBP: { hourlyRate: 25, inrPerUnit: 120, auto: false, rateAsOf: "2026-11-26T00:00:00Z" } }), { GBP: { hourlyRate: 25, inrPerUnit: 120, auto: false } }, "a figure typed by hand carries no market date");
    assert.deepEqual(parseCountryPricing({ GBP: { hourlyRate: 25, inrPerUnit: 120, rateAsOf: "2026-11-26T00:00:00Z" } }).GBP!.rateAsOf, "2026-11-26T00:00:00.000Z");
    for (const bad of [{ ZZZ: { hourlyRate: 1, inrPerUnit: 1 } }, { GBP: { hourlyRate: -5, inrPerUnit: 1 } }, { GBP: { hourlyRate: 25 } }, { GBP: { hourlyRate: 25, inrPerUnit: 0 } }, { GBP: { hourlyRate: 25, inrPerUnit: 99999 } }, { GBP: { hourlyRate: "abc", inrPerUnit: 1 } }]) assert.throws(() => parseCountryPricing(bad), /currency we can quote in|0 or more|rupees one/, JSON.stringify(bad));
    assert.deepEqual(parseCountryPricing(undefined), {});
  });
  it("a rate card keeps its country prices when saved, keeps old ones when the field is left out, and clears them when sent empty", () => {
    const plain = () => JSON.parse(JSON.stringify(DEFAULT_RATE_CARD)) as Record<string, unknown>;
    const saved = parseRateCard({ ...plain(), countryPricing: { GBP: { hourlyRate: 25, inrPerUnit: 121.3 } } }, DEFAULT_RATE_CARD);
    assert.deepEqual(saved.countryPricing, { GBP: { hourlyRate: 25, inrPerUnit: 121.3, auto: true } });
    const left = JSON.parse(JSON.stringify(saved)) as Record<string, unknown>;
    delete left.countryPricing;
    assert.deepEqual(parseRateCard(left, saved).countryPricing, { GBP: { hourlyRate: 25, inrPerUnit: 121.3, auto: true } }, "an older client of the API does not wipe the prices");
    assert.deepEqual(parseRateCard({ ...left, countryPricing: {} }, saved).countryPricing, {}, "empty clears them");
    assert.equal(parseRateCard(plain(), DEFAULT_RATE_CARD).countryPricing, undefined, "a card that never had them still has none");
  });
});

describe("5. the screens", () => {
  it("a component that sets the currency for what is below it never reads it from above itself (it would get rupees): it works it out from the quotation", async () => {
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p) : /\.tsx$/.test(n) ? [p] : []; });
    const both = walk("src").filter((f) => { const t = readFileSync(f, "utf8"); return t.includes("<MoneyProvider") && /useMoney\(\)/.test(t) && !f.endsWith("money-context.tsx"); });
    assert.deepEqual(both, [], "these provide the currency and also read it from the context above them");
  });
  it("no screen that shows a quotation writes its amounts with the rupee-only formatter", async () => {
    const { readFileSync } = await import("node:fs");
    for (const f of ["src/app/q/[token]/client-quotation.tsx", "src/components/business/quotation-document.tsx", "src/components/business/proposals-panel.tsx", "src/components/business/package-details.tsx", "src/components/business/estimate-breakdown.tsx", "src/components/business/requirement-wizard.tsx", "src/components/business/services-summary.tsx", "src/components/business/budget-summary.tsx", "src/lib/business/documents.ts"]) {
      assert.ok(!/formatINR\(/.test(readFileSync(f, "utf8")), `${f} still writes amounts as rupees`);
    }
  });
});

describe("6. awkward prices still add up to the penny", () => {
  it("with an hourly price that does not divide neatly (22.37), every line is a whole penny and the lines still add up to the total shown", () => {
    const odd = withPrices(121.3, 22.37);
    const q = buildQuote(req(["contact-form", "booking", "seo-setup"]), uk, odd);
    let sum = 0;
    for (const i of q.items) {
      const line = pounds(q, i.amount);
      assert.equal(line, Math.round(i.qty * 22.37 * 100) / 100, `${i.description}: ${i.qty} h x 22.37`);
      assert.ok(Math.abs(i.amount / 121.3 * 100 - Math.round(i.amount / 121.3 * 100)) < 1e-6, `${i.description} is a whole number of pence in the books`);
      sum += line;
    }
    assert.equal(Math.round(sum * 100) / 100, pounds(q, q.subtotal), "the lines on the page add up to the subtotal on the page");
    assert.equal(pounds(q, q.grandTotal), Math.round(pounds(q, q.subtotal)), "and the total is the subtotal to a whole pound");
  });
});
