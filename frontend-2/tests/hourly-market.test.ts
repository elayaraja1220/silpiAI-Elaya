// An hourly quotation priced from the official market rate for the client's country, role and level. The rates below are TEST DATA only, entered through the real
// administrator functions with a source, exactly as a researcher would; none of them ships with the product.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { NextRequest } from "next/server";

import { buildHourlyQuote, hourlyTerms } from "@/lib/business/hourly";
import { fromRupees, moneyOf } from "@/lib/business/money";
import { DEFAULT_RATE_CARD } from "@/lib/business/rate-card";
import type { Client, Requirement } from "@/lib/business/types";
import { parseClient, parseRequirement } from "@/lib/business/validate";

const dir = mkdtempSync(path.join(tmpdir(), "silpi-hourly-market-"));
const mods = async () => ({ s: await import("@/lib/business/store"), d: await import("@/server/pricing-data") });
const fails = async (fn: () => unknown, pattern: RegExp) => { try { await fn(); } catch (e) { assert.match((e as Error).message, pattern); return; } assert.fail(`expected an error matching ${pattern}`); };
const base = { name: "Client", email: "c@example.com", phone: "+44 20 7946 0000", company: "", gstin: "", address: "" };
const india = (): Client => parseClient({ ...base, state: "Tamil Nadu", country: "IN", phone: "+91 98765 43210" });
const abroad = (country: string, extra: Record<string, unknown> = {}): Client => parseClient({ ...base, state: "Outside India", country, ...extra });
function hourly(over: Record<string, unknown> = {}, h: Record<string, unknown> = {}): Requirement {
  return parseRequirement({ title: "Retainer", summary: "A senior developer for a month on the shop front end.", scope: "full", projectType: "business-website", complexity: "standard", pages: [], modules: [], design: "ai", billing: "hourly", hourly: { role: "Full-stack developer", rate: 1000, estimatedHours: 40, rangePct: 20, cycle: "monthly", country: "", roleId: "full-stack", levelId: "mid", ...h }, ...over }, DEFAULT_RATE_CARD);
}
const FRESH = "2026-01-01";
const SRC = "Test data entered for this test, 2026";

before(async () => {
  process.env.SILPI_DB_PATH = path.join(dir, "hm.db");
  const { s, d } = await mods();
  // Prices for clients abroad: the rupee value of one unit, for hourly engagements only (hourly price 0 = no fixed-price rate).
  s.saveRateCard({ ...DEFAULT_RATE_CARD, countryPricing: { USD: { hourlyRate: 0, inrPerUnit: 90, auto: false }, GBP: { hourlyRate: 0, inrPerUnit: 120, auto: false } } });
  d.addRate({ country: "US", roleId: "full-stack", levelId: "mid", kind: "freelancer", min: 6000, median: 8500, max: 12_000, source: SRC, effectiveDate: FRESH }, "test");
  d.addRate({ country: "GB", roleId: "full-stack", levelId: "mid", kind: "freelancer", min: 4000, median: 5500, max: 8000, source: SRC, effectiveDate: FRESH }, "test");
  d.addRate({ country: "AU", roleId: "full-stack", levelId: "mid", kind: "freelancer", min: 5000, median: 7000, max: 10_000, source: SRC, effectiveDate: FRESH }, "test");
});
after(() => {
  const cached = globalThis as unknown as { silpiDb?: { close(): void } };
  cached.silpiDb?.close();
  delete cached.silpiDb;
  rmSync(dir, { recursive: true, force: true });
});

describe("1. the client's country", () => {
  it("keeps a supported country, derives the currency from it for a client abroad, and refuses a country that does not fit the state", () => {
    const us = abroad("us");
    assert.deepEqual([us.country, us.currency, us.state], ["US", "USD", "Outside India"]);
    assert.deepEqual([india().country, india().currency], ["IN", undefined], "a client in India has no foreign currency");
    assert.equal(abroad("GB", { currency: "EUR" }).currency, "EUR", "a currency chosen on purpose wins");
    assert.throws(() => parseClient({ ...base, state: "Tamil Nadu", country: "US" }), /outside India has the state/);
    assert.throws(() => parseClient({ ...base, state: "Outside India", country: "IN" }), /needs an Indian state/);
    assert.throws(() => parseClient({ ...base, state: "Outside India", country: "ZZ" }), /not a country we can quote for/);
    assert.equal(parseClient({ ...base, state: "Tamil Nadu" }).country, undefined, "a client with no country is as before");
  });
});

describe("2. the USA, in dollars", () => {
  it("looks up the official rate on the server, quotes in dollars with no Indian GST, and keeps the figure and its source", async () => {
    const { s } = await mods();
    const lead = s.createLead(abroad("US"), hourly({}, { rate: 1, country: "US", rateNative: 85 }));
    const h = lead.requirement.hourly!;
    assert.deepEqual([h.market!.billedMinor, h.market!.currency, h.market!.kind, h.override, h.rateNative, h.market!.source], [8500, "USD", "freelancer", undefined, 85, SRC]);
    const q = lead.quotation!;
    assert.deepEqual([q.currency, q.inrPerUnit, q.gst.mode, q.gst.total], ["USD", 90, "export", 0]);
    const money = moneyOf(q);
    assert.equal(fromRupees(q.hourly!.rate, money), 85, "an hour is 85 dollars");
    assert.deepEqual([40, 32, 48].map((hrs) => hrs * 85), [3400, 2720, 4080]);
    assert.deepEqual([q.hourly!.expectedTotal, q.hourly!.minTotal, q.hourly!.capTotal].map((n) => fromRupees(n, money)), [3400, 2720, 4080], "estimate, lowest and the cap, in whole dollars");
    assert.match(q.hourly!.marketNote!, /freelancer billing rate for US \/ full-stack \/ mid, from 2026-01-01 \(Test data entered for this test, 2026\)/);
  });
  it("sets the benchmark price exactly when the team left it, even if the browser sent something else", async () => {
    const { s } = await mods();
    const lead = s.createLead(abroad("US"), hourly({}, { rate: 5, country: "US", rateNative: 85 }));
    assert.equal(lead.requirement.hourly!.rateNative, 85);
    assert.equal(lead.requirement.hourly!.override, undefined);
  });
  it("keeps a price the team typed on purpose, records it as an override, and still shows the market figure", async () => {
    const { s } = await mods();
    const lead = s.createLead(abroad("US"), hourly({}, { rate: 1, country: "US", rateNative: 95 }));
    const h = lead.requirement.hourly!;
    assert.deepEqual([h.rateNative, h.override, h.market!.billedMinor], [95, true, 8500]);
    assert.equal(fromRupees(lead.quotation!.hourly!.rate, moneyOf(lead.quotation)), 95);
    assert.match(lead.quotation!.hourly!.marketNote!, /set by hand and differs from the benchmark/);
  });
});

describe("3. India, in rupees, with the existing GST", () => {
  it("uses the administrator's chosen benchmark: India's illustrative wage at a configured multiplier, and says it is illustrative", async () => {
    const { s, d } = await mods();
    d.savePricingConfig({ benchmark: { hourly: "employee", fixed: "agency" }, billing: { employee: { multiplierBp: 25_000, overheadBp: 0, marginBp: 0 } } as never }, "test");
    const lead = s.createLead(india(), hourly({}, { rate: 1803, country: "IN", levelId: "mid", roleId: "backend" }));
    const h = lead.requirement.hourly!;
    assert.deepEqual([h.market!.currency, h.market!.medianMinor, h.market!.billedMinor, h.market!.illustrative, h.rate], ["INR", 72_115, 180_288, true, 1802.88]);
    const q = lead.quotation!;
    assert.ok(!("currency" in q), "a rupee quotation carries no foreign currency");
    assert.deepEqual([q.gst.mode, q.gst.rate], ["intra", 18], "Tamil Nadu client of a Tamil Nadu business: CGST + SGST as before");
    assert.equal(q.hourly!.rate, 1802.88);
    assert.equal(q.subtotal, Math.round(40 * 1802.88 * 100) / 100, "hours x rate, to the paisa");
    assert.match(q.hourly!.marketNote!, /employee wage for IN \/ backend \/ mid.*illustrative assumption, not a measured market rate/);
    d.savePricingConfig({ benchmark: { hourly: "freelancer", fixed: "agency" } }, "test");
  });
});

describe("4. other countries and the cases with no data", () => {
  it("Australia needs the Australian dollar set up: it is refused with the instruction, not converted by guesswork", async () => {
    const { s } = await mods();
    await fails(() => s.createLead(abroad("AU"), hourly({}, { rate: 1, country: "AU", rateNative: 70 })), /market rate for AU is in AUD, but this quotation would be written in INR. Add AUD under "Prices for clients abroad"/);
    await fails(() => s.createLead(abroad("GB", { currency: "USD" }), hourly({}, { rate: 1, country: "GB", rateNative: 55 })), /rate for GB is in GBP, but this quotation would be written in USD/);
  });
  it("with no verified rate for the country, the engagement is left exactly as typed, with no market figure", async () => {
    const { s } = await mods();
    const lead = s.createLead(india(), hourly({}, { rate: 900, country: "IN", roleId: "qa", levelId: "expert" }));
    assert.deepEqual([lead.requirement.hourly!.market, lead.requirement.hourly!.rate, lead.quotation!.hourly!.rate], [undefined, 900, 900]);
    const noRole = s.createLead(india(), hourly({}, { rate: 800, roleId: "", levelId: "" }));
    assert.equal(noRole.requirement.hourly!.market, undefined, "no role chosen: no lookup");
  });
  it("the browser cannot supply the market figure: whatever it sends is ignored and the database's figure is written", async () => {
    const route = await import("@/app/api/business/leads/route");
    const forged = { ...hourly({}, { rate: 1, country: "US", rateNative: 85 }), hourly: { ...hourly({}, { rate: 1, country: "US", rateNative: 85 }).hourly, market: { rateId: 1, kind: "freelancer", currency: "USD", minMinor: 1, medianMinor: 1, maxMinor: 1, billedMinor: 1, source: "A made-up figure from the browser", effectiveDate: "2026-01-01", illustrative: false, stale: false, billsAtCost: false } } };
    const res = await route.POST(new NextRequest("http://localhost:3000/api/business/leads", { method: "POST", headers: { host: "localhost:3000", origin: "http://localhost:3000", "content-type": "application/json" }, body: JSON.stringify({ client: abroad("US"), requirement: forged }) }));
    assert.equal(res.status, 200, await res.clone().text());
    const lead = (await res.json()).lead;
    assert.equal(lead.requirement.hourly.market.billedMinor, 8500, "the real figure");
    assert.equal(lead.requirement.hourly.market.source, SRC, "and its real source");
    assert.ok(!JSON.stringify(lead).includes("made-up"));
  });
});

describe("5. the quotation itself", () => {
  it("whole dollars and whole cents: the lines of a foreign hourly quotation add up, however awkward the rate", () => {
    const rates = { ...DEFAULT_RATE_CARD, countryPricing: { USD: { hourlyRate: 0, inrPerUnit: 92.8, auto: false } } };
    const client = abroad("US");
    const req = hourly({}, { rate: 2000, rateNative: 22.37, estimatedHours: 37.5, rangePct: 30 });
    const t = hourlyTerms(req.hourly!, client, rates);
    const money = { code: "USD", unit: 92.8 };
    for (const total of [t.minTotal, t.expectedTotal, t.capTotal]) assert.equal(fromRupees(total, money), Math.round(fromRupees(total, money)), "a whole dollar");
    const q = buildHourlyQuote(req, client, rates);
    assert.equal(fromRupees(q.subtotal, money), Math.round(37.5 * 22.37 * 100) / 100, "37.5 hours x 22.37, to the cent");
    const [a, b] = q.schedule.map((x) => fromRupees(x.amount, money));
    assert.equal(a! + b!, fromRupees(q.grandTotal, money), "advance + balance = total");
  });
  it("a rupee engagement with no country is exactly as it always was", () => {
    const t = hourlyTerms({ role: "Senior developer", rate: 1000, estimatedHours: 40, rangePct: 20, cycle: "monthly" }, { state: "Tamil Nadu" }, DEFAULT_RATE_CARD);
    assert.deepEqual([t.rate, t.minHours, t.expectedHours, t.capHours, t.minTotal, t.expectedTotal, t.capTotal], [1000, 32, 40, 48, 37_760, 47_200, 56_640]);
    assert.ok(!("marketNote" in t));
  });
});
