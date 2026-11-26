// The rupee value of a price in another currency follows the market by itself; the price the client pays and any quotation already made do not move.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import type { LiveRates } from "@/lib/business/live-rates";
import { DEFAULT_RATE_CARD } from "@/lib/business/rate-card";
import { fromRupees, moneyOf } from "@/lib/business/money";
import type { Client, Requirement } from "@/lib/business/types";

const dir = mkdtempSync(path.join(tmpdir(), "silpi-market-"));
const realFetch = globalThis.fetch;
const mods = async () => ({ s: await import("@/lib/business/store"), live: await import("@/lib/business/live-rates") });
const market = (over: Record<string, number> = {}): LiveRates => ({ source: "live", asOf: "2026-11-26T08:00:00.000Z", inrPerUnit: { GBP: 121.3, USD: 92.8, EUR: 101.7, ...over } });
const uk: Client = { name: "Northwind", email: "a@n.example", phone: "+44 20 7946 0000", company: "", gstin: "", state: "Outside India", currency: "GBP", address: "London" };
const requirement = (): Requirement => ({ title: "Site", summary: "A business website for a consultancy in London, six pages.", scope: "full", existingProject: "", version: "", projectType: "business-website", complexity: "basic", pages: ["Home", "About Us", "Contact Us"], modules: ["contact-form"], design: "ai", references: "", domain: { needed: false, choice: "self", name: "", tld: ".com", years: 1 }, hosting: { needed: false, choice: "self", plan: "static", years: 1 }, deadlineWeeks: 0, budget: 0 });

before(() => { process.env.SILPI_DB_PATH = path.join(dir, "market.db"); });
beforeEach(async () => {
  const { s } = await mods();
  s.saveRateCard({ ...DEFAULT_RATE_CARD, countryPricing: { GBP: { hourlyRate: 25, inrPerUnit: 100, auto: true }, USD: { hourlyRate: 30, inrPerUnit: 90, auto: false }, EUR: { hourlyRate: 28, inrPerUnit: 95, auto: true } } });
  (globalThis as unknown as { silpiRates?: unknown }).silpiRates = undefined;
  globalThis.fetch = realFetch;
});
after(() => {
  globalThis.fetch = realFetch;
  const cached = globalThis as unknown as { silpiDb?: { close(): void } };
  cached.silpiDb?.close();
  delete cached.silpiDb;
  rmSync(dir, { recursive: true, force: true });
});

describe("1. the rupee value follows the market", () => {
  it("moves the prices that follow the market to today's rate, and leaves one typed by hand alone", async () => {
    const { s } = await mods();
    const r = await s.refreshAutoRates(async () => market());
    assert.deepEqual([r.source, r.updated.sort()], ["live", ["EUR", "GBP"]]);
    const cp = s.getRateCard().countryPricing!;
    assert.deepEqual([cp.GBP!.inrPerUnit, cp.EUR!.inrPerUnit, cp.GBP!.rateAsOf], [121.3, 101.7, "2026-11-26T08:00:00.000Z"]);
    assert.deepEqual([cp.USD!.inrPerUnit, cp.USD!.auto], [90, false], "the figure typed by hand is untouched");
    assert.deepEqual([cp.GBP!.hourlyRate, cp.USD!.hourlyRate, cp.EUR!.hourlyRate], [25, 30, 28], "and no price the client pays moves");
  });
  it("never writes a rate the service could only guess: when it cannot be reached, the figure stays as it was", async () => {
    const { s } = await mods();
    const r = await s.refreshAutoRates(async () => ({ ...market(), source: "approximate", asOf: "" }));
    assert.deepEqual([r.source, r.updated], ["approximate", []]);
    assert.equal(s.getRateCard().countryPricing!.GBP!.inrPerUnit, 100);
  });
  it("an error from the service is left to the caller to ignore, and changes nothing", async () => {
    const { s } = await mods();
    await assert.rejects(() => s.refreshAutoRates(async () => { throw new Error("offline"); }), /offline/);
    assert.equal(s.getRateCard().countryPricing!.GBP!.inrPerUnit, 100);
  });
  it("skips a currency the service does not list, and does not even ask when nothing follows the market", async () => {
    const { s } = await mods();
    const r = await s.refreshAutoRates(async () => market({ EUR: NaN }));
    assert.deepEqual(r.updated, ["GBP"], "EUR had no usable rate: kept");
    assert.equal(s.getRateCard().countryPricing!.EUR!.inrPerUnit, 95);
    s.saveRateCard({ ...DEFAULT_RATE_CARD, countryPricing: { USD: { hourlyRate: 30, inrPerUnit: 90, auto: false } } });
    let asked = 0;
    const none = await s.refreshAutoRates(async () => { asked++; return market(); });
    assert.deepEqual([none.source, none.updated, asked], ["none", [], 0]);
    s.saveRateCard(DEFAULT_RATE_CARD);
    assert.equal((await s.refreshAutoRates(async () => { asked++; return market(); })).source, "none", "no country prices at all");
    assert.equal(asked, 0);
  });
  it("saves nothing when the rate has not changed", async () => {
    const { s } = await mods();
    await s.refreshAutoRates(async () => market());
    const stored = () => (JSON.stringify(s.getRateCard().countryPricing));
    const before = stored();
    const again = await s.refreshAutoRates(async () => market());
    assert.deepEqual(again.updated, []);
    assert.equal(stored(), before);
  });
});

describe("2. what does not move", () => {
  it("a quotation already made keeps the rate it was made at; a new one uses today's, and the pounds are the same", async () => {
    const { s } = await mods();
    const lead = s.createLead(uk, requirement());
    const q = lead.quotation!;
    assert.deepEqual([q.currency, q.inrPerUnit], ["GBP", 100], "made at the rate then");
    const pounds = fromRupees(q.grandTotal, moneyOf(q));
    await s.refreshAutoRates(async () => market());
    const same = s.getLead(lead.id)!.quotation!;
    assert.deepEqual([same.inrPerUnit, same.grandTotal], [100, q.grandTotal], "the saved quotation did not change");
    const fresh = s.createLead(uk, requirement()).quotation!;
    assert.equal(fresh.inrPerUnit, 121.3, "a new quotation uses today's market rate");
    assert.equal(fromRupees(fresh.grandTotal, moneyOf(fresh)), pounds, "and costs the client exactly the same pounds");
    assert.ok(fresh.grandTotal > q.grandTotal, "only the rupees in the books went up");
  });
});

describe("3. the market rate service", () => {
  const answer = (body: unknown, ok = true) => { let calls = 0; globalThis.fetch = (async () => { calls++; return new Response(JSON.stringify(body), { status: ok ? 200 : 503 }); }) as typeof fetch; return () => calls; };
  it("reads the service's answer (units per rupee) into rupees per unit, says it is live, and asks at most once in six hours", async () => {
    const { live } = await mods();
    const calls = answer({ result: "success", time_last_update_utc: "Thu, 26 Nov 2026 00:02:31 +0000", rates: { INR: 1, GBP: 1 / 121.3, USD: 1 / 92.8 } });
    const a = await live.getLiveInrPerUnit(1_000_000);
    assert.deepEqual([a.source, a.asOf, Math.round(a.inrPerUnit.GBP! * 100) / 100, Math.round(a.inrPerUnit.USD! * 100) / 100], ["live", "2026-11-26T00:02:31.000Z", 121.3, 92.8]);
    await live.getLiveInrPerUnit(1_000_000 + 5 * 3_600_000);
    assert.equal(calls(), 1, "cached for six hours");
    await live.getLiveInrPerUnit(1_000_000 + 7 * 3_600_000);
    assert.equal(calls(), 2, "asked again after six hours");
  });
  it("says 'approximate' when it cannot be reached or answers badly, and does not cache that", async () => {
    const { live } = await mods();
    for (const body of [{ result: "error" }, { result: "success" }, "nonsense"]) {
      const calls = answer(body);
      const r = await live.getLiveInrPerUnit();
      assert.equal(r.source, "approximate", JSON.stringify(body));
      await live.getLiveInrPerUnit();
      assert.equal(calls(), 2, "tried again, because an estimate is not kept");
    }
    answer({ result: "success", rates: {} }, false);
    assert.equal((await live.getLiveInrPerUnit()).source, "approximate", "a failing service");
    globalThis.fetch = (async () => { throw new Error("offline"); }) as typeof fetch;
    assert.equal((await live.getLiveInrPerUnit()).source, "approximate", "no network");
  });
  it("the rate card route brings the rates up to date when it is read, and a failure never stops it answering", async () => {
    const { s } = await mods();
    const route = await import("@/app/api/business/rate-card/route");
    answer({ result: "success", time_last_update_utc: "Thu, 26 Nov 2026 00:02:31 +0000", rates: { GBP: 1 / 121.3 } });
    const body = await (await route.GET()).json();
    assert.equal(Math.round(body.rateCard.countryPricing.GBP.inrPerUnit * 100) / 100, 121.3);
    assert.equal(Math.round(s.getRateCard().countryPricing!.GBP!.inrPerUnit * 100) / 100, 121.3, "and it was saved");
    globalThis.fetch = (async () => { throw new Error("offline"); }) as typeof fetch;
    (globalThis as unknown as { silpiRates?: unknown }).silpiRates = undefined;
    const down = await route.GET();
    assert.equal(down.status, 200, "offline: still answers, with what it had");
  });
});
