// A fixed price set from the verified market rate for the client's country, role and level, with a risk allowance. The rates below are TEST DATA only, entered through the
// real administrator functions with a source; none of them ships with the product.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { fromRupees, moneyOf } from "@/lib/business/money";
import { buildQuote, fixedBasisNote } from "@/lib/business/pricing";
import { DEFAULT_RATE_CARD } from "@/lib/business/rate-card";
import type { Client, MarketSnapshot, Requirement } from "@/lib/business/types";
import { parseClient, parseRequirement } from "@/lib/business/validate";

const dir = mkdtempSync(path.join(tmpdir(), "silpi-fixed-market-"));
const mods = async () => ({ s: await import("@/lib/business/store"), d: await import("@/server/pricing-data") });
const fails = async (fn: () => unknown, pattern: RegExp) => { try { await fn(); } catch (e) { assert.match((e as Error).message, pattern); return; } assert.fail(`expected an error matching ${pattern}`); };
const base = { name: "Client", email: "c@example.com", phone: "+44 20 7946 0000", company: "", gstin: "", address: "" };
const abroad = (country: string, extra: Record<string, unknown> = {}): Client => parseClient({ ...base, state: "Outside India", country, ...extra });
const india = (): Client => parseClient({ ...base, state: "Tamil Nadu", country: "IN", phone: "+91 98765 43210" });
const SIX = ["Home", "About Us", "Services", "Products / Portfolio", "Gallery", "Contact Us"];
function fixed(basis: Record<string, unknown> | undefined): Requirement {
  return parseRequirement({ title: "Site", summary: "A website for a small shop with six pages.", scope: "full", projectType: "business-website", pages: SIX, modules: ["contact-form"], design: "ai", domain: { needed: false, choice: "self", name: "", tld: ".com", years: 1 }, hosting: { needed: false, choice: "self", plan: "static", years: 1 }, ...(basis ? { fixedBasis: basis } : {}) }, DEFAULT_RATE_CARD);
}
const snap = (over: Partial<MarketSnapshot> = {}): MarketSnapshot => ({ rateId: 1, kind: "agency", currency: "GBP", minMinor: 5000, medianMinor: 6000, maxMinor: 9000, billedMinor: 5500, source: "Test data 2026", effectiveDate: "2026-01-01", illustrative: false, stale: false, billsAtCost: false, ...over });
const rates = { ...DEFAULT_RATE_CARD, countryPricing: { GBP: { hourlyRate: 25, inrPerUnit: 120, auto: false }, USD: { hourlyRate: 30, inrPerUnit: 90, auto: false } } };
const uk = { state: "Outside India", currency: "GBP" } as const;
const FRESH = "2026-01-01";
const SRC = "Test data entered for this test, 2026";

before(async () => {
  process.env.SILPI_DB_PATH = path.join(dir, "fm.db");
  const { s, d } = await mods();
  s.saveRateCard(rates);
  d.addRate({ country: "GB", roleId: "full-stack", levelId: "mid", kind: "agency", min: 5000, median: 5500, max: 9000, source: SRC, effectiveDate: FRESH }, "test");
  d.addRate({ country: "IN", roleId: "full-stack", levelId: "mid", kind: "agency", min: 40_000, median: 60_000, max: 90_000, source: SRC, effectiveDate: FRESH }, "test");
});
after(() => {
  const cached = globalThis as unknown as { silpiDb?: { close(): void } };
  cached.silpiDb?.close();
  delete cached.silpiDb;
  rmSync(dir, { recursive: true, force: true });
});

describe("1. what the quotation does with a market rate", () => {
  it("prices every hour at the market rate plus the risk allowance, in the client's currency, and says where it came from", () => {
    const req = { ...fixed({ roleId: "full-stack", levelId: "mid", country: "GB" }) };
    req.fixedBasis = { ...req.fixedBasis!, market: snap(), riskBp: 1000 };
    const q = buildQuote(req, uk, rates);
    const money = moneyOf(q);
    const work = q.items.filter((i) => i.unit === "hour");
    assert.ok(work.length > 0);
    for (const line of work) assert.equal(fromRupees(line.rate, money), 60.5, "55.00 + 10% = 60.50 an hour");
    assert.deepEqual([q.marketBasis?.source, q.marketBasis?.riskBp, q.marketBasis?.kind, q.marketBasis?.currency], ["Test data 2026", 1000, "agency", "GBP"]);
    const plain = buildQuote(fixed(undefined), uk, rates);
    assert.equal(fromRupees(plain.items.find((i) => i.unit === "hour")!.rate, money), 25, "without it the rate card's 25 is used");
    assert.equal(plain.marketBasis, undefined);
  });
  it("with no risk allowance charges the plain market rate", () => {
    const req = fixed({ roleId: "full-stack", levelId: "mid" });
    req.fixedBasis = { ...req.fixedBasis!, market: snap(), riskBp: 0 };
    const q = buildQuote(req, uk, rates);
    assert.equal(fromRupees(q.items.find((i) => i.unit === "hour")!.rate, moneyOf(q)), 55);
  });
  it("is unchanged when there is no market figure, or when it is in another currency than the quotation", () => {
    const plain = buildQuote(fixed(undefined), uk, rates);
    assert.deepEqual(buildQuote(fixed({ roleId: "full-stack", levelId: "mid" }), uk, rates).items, plain.items, "a role and level alone change nothing");
    const wrong = fixed({ roleId: "full-stack", levelId: "mid" });
    wrong.fixedBasis = { ...wrong.fixedBasis!, market: snap({ currency: "USD" }), riskBp: 500 };
    const q = buildQuote(wrong, uk, rates);
    assert.deepEqual(q.items, plain.items, "a dollar figure is never used for a pound quotation");
    assert.equal(q.marketBasis, undefined);
  });
  it("rupee quotations without a basis are exactly as before", () => {
    const q = buildQuote(fixed(undefined), { state: "Tamil Nadu" }, rates);
    assert.ok(!("marketBasis" in q) && !("currency" in q));
    assert.equal(q.items.find((i) => i.unit === "hour")!.rate, DEFAULT_RATE_CARD.hourlyRate);
  });
});

describe("2. the server looks the rate up", () => {
  it("fills in the market figure and the risk allowance from the administrator's settings, never from the browser", async () => {
    const { s, d } = await mods();
    d.savePricingConfig({ riskAllowanceBp: 1500 }, "test");
    const lead = s.createLead(abroad("GB"), fixed({ roleId: "full-stack", levelId: "mid", country: "GB", market: snap({ billedMinor: 1 }), riskBp: 0 }));
    const b = lead.requirement.fixedBasis!;
    assert.deepEqual([b.market!.billedMinor, b.market!.source, b.riskBp], [5500, SRC, 1500], "the browser's figures are ignored");
    const q = lead.quotation!;
    assert.equal(fromRupees(q.items.find((i) => i.unit === "hour")!.rate, moneyOf(q)), 63.25, "55.00 + 15% = 63.25");
    assert.equal(q.marketBasis?.riskBp, 1500);
    assert.deepEqual([q.gst.mode, q.gst.total], ["export", 0]);
    d.savePricingConfig({ riskAllowanceBp: 0 }, "test");
  });
  it("uses the country on the client when the requirement names none", async () => {
    const { s } = await mods();
    const lead = s.createLead(abroad("GB"), fixed({ roleId: "full-stack", levelId: "mid" }));
    assert.equal(lead.requirement.fixedBasis?.market?.billedMinor, 5500);
  });
  it("a country named on the requirement beats the client's own country", async () => {
    const { s } = await mods();
    const lead = s.createLead(abroad("US", { currency: "GBP" }), fixed({ roleId: "full-stack", levelId: "mid", country: "GB" }));
    assert.equal(lead.requirement.fixedBasis?.market?.billedMinor, 5500, "the UK rate, not the (empty) US one");
  });
  it("prices an Indian client in rupees from the Indian agency rate, with the same GST rules as before", async () => {
    const { s } = await mods();
    const lead = s.createLead(india(), fixed({ roleId: "full-stack", levelId: "mid", country: "IN" }));
    const q = lead.quotation!;
    assert.equal(q.items.find((i) => i.unit === "hour")!.rate, 600);
    assert.notEqual(q.gst.mode, "export");
    assert.equal(q.currency, undefined);
  });
  it("falls back to the rate card, saying nothing was found, when there is no verified rate", async () => {
    const { s } = await mods();
    const lead = s.createLead(abroad("US"), fixed({ roleId: "full-stack", levelId: "mid" }));
    assert.equal(lead.requirement.fixedBasis?.market, undefined);
    assert.equal(lead.quotation!.marketBasis, undefined);
    assert.equal(fromRupees(lead.quotation!.items.find((i) => i.unit === "hour")!.rate, moneyOf(lead.quotation!)), 30);
  });
  it("refuses a rate in a currency the quotation will not be written in, and says how to fix it", async () => {
    const { s } = await mods();
    await fails(() => s.createLead(abroad("GB", { currency: "EUR" }), fixed({ roleId: "full-stack", levelId: "mid" })), /is in GBP, but this quotation would be written in INR/);
  });
  it("changes nothing for a quotation that names no role and level", async () => {
    const { s } = await mods();
    const lead = s.createLead(abroad("GB"), fixed(undefined));
    assert.equal(lead.requirement.fixedBasis, undefined);
    assert.equal(fromRupees(lead.quotation!.items.find((i) => i.unit === "hour")!.rate, moneyOf(lead.quotation!)), 25);
  });
  it("a saved quotation keeps its figure when the administrator later adds a newer rate", async () => {
    const { s, d } = await mods();
    const lead = s.createLead(abroad("GB"), fixed({ roleId: "full-stack", levelId: "mid" }));
    const before = lead.quotation!.grandTotal;
    d.addRate({ country: "GB", roleId: "full-stack", levelId: "mid", kind: "agency", min: 9000, median: 9900, max: 12_000, source: SRC, effectiveDate: "2026-06-01" }, "test");
    assert.equal(s.getLead(lead.id)!.quotation!.grandTotal, before);
    assert.equal(s.getLead(lead.id)!.requirement.fixedBasis?.market?.billedMinor, 5500);
  });
});

describe("3. what the browser may send", () => {
  it("accepts a role, level and country, refuses bad ones, and drops any market figure", () => {
    const ok = fixed({ roleId: "Full-Stack", levelId: "MID", country: "gb", market: snap(), riskBp: 9999 });
    assert.deepEqual(ok.fixedBasis, { roleId: "full-stack", levelId: "mid", country: "GB" });
    assert.throws(() => fixed({ roleId: "full-stack" }), /both a role and an experience level/);
    assert.throws(() => fixed({ roleId: "x", levelId: "mid" }), /both a role and an experience level/);
    assert.throws(() => fixed({ roleId: "full-stack", levelId: "mid", country: "ZZ" }), /not a country we can quote for/);
    assert.equal(fixed(undefined).fixedBasis, undefined);
  });
});

describe("4. what the client is told", () => {
  it("names the benchmark, where it came from and the risk allowance, and nothing when the rate card was used", () => {
    const req = fixed({ roleId: "full-stack", levelId: "mid", country: "GB" });
    req.fixedBasis = { ...req.fixedBasis!, market: snap(), riskBp: 1250 };
    assert.equal(fixedBasisNote(buildQuote(req, uk, rates).marketBasis), "The hourly price is based on the agency billing rate for GB / full-stack / mid, from 2026-01-01 (Test data 2026), with a 12.5% allowance for project risk.");
    req.fixedBasis = { ...req.fixedBasis, market: snap({ illustrative: true }), riskBp: 0 };
    assert.match(fixedBasisNote(buildQuote(req, uk, rates).marketBasis)!, /illustrative assumption/);
    assert.equal(fixedBasisNote(buildQuote(fixed(undefined), uk, rates).marketBasis), undefined);
  });
});
