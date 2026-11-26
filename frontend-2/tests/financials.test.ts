// The five money figures kept apart: A human-equivalent value, B customer price, C AI cost, D infrastructure cost, E margin. The rates below are TEST DATA only.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { humanEquivalent, SEPARATION_RULES, type ValueInput } from "@/lib/business/financials";
import { resolveRate, DEFAULT_PRICING_CONFIG, type MarketRate } from "@/lib/business/market-rates";
import { DEFAULT_RATE_CARD } from "@/lib/business/rate-card";
import type { Client, Requirement } from "@/lib/business/types";
import { parseClient, parseRequirement } from "@/lib/business/validate";

const dir = mkdtempSync(path.join(tmpdir(), "silpi-financials-"));
const mods = async () => ({ s: await import("@/lib/business/store"), d: await import("@/server/pricing-data"), h: await import("@/server/hour-split"), f: await import("@/server/financials") });
const fails = async (fn: () => unknown, pattern: RegExp) => { try { await fn(); } catch (e) { assert.match((e as Error).message, pattern); return; } assert.fail(`expected an error matching ${pattern}`); };
const base = { name: "Client", email: "c@example.com", phone: "+44 20 7946 0000", company: "", gstin: "", address: "" };
const uk = (): Client => parseClient({ ...base, state: "Outside India", country: "GB" });
const india = (): Client => parseClient({ ...base, state: "Tamil Nadu", country: "IN", phone: "+91 98765 43210" });
const SIX = ["Home", "About Us", "Services", "Products / Portfolio", "Gallery", "Contact Us"];
const site = (over: Record<string, unknown> = {}): Requirement => parseRequirement({ title: "Shop site", summary: "A website for a small shop with six pages.", scope: "full", projectType: "business-website", pages: SIX, modules: ["contact-form"], design: "ai", domain: { needed: false, choice: "self", name: "", tld: ".com", years: 1 }, hosting: { needed: false, choice: "self", plan: "static", years: 1 }, ...over }, DEFAULT_RATE_CARD);
const SRC = "Test data entered for this test, 2026";
const row = (over: Partial<MarketRate>): MarketRate => ({ id: 1, country: "GB", roleId: "frontend", levelId: "mid", kind: "freelancer", currency: "GBP", minMinor: 4000, medianMinor: 5000, maxMinor: 7000, source: SRC, sourceUrl: "", effectiveDate: "2026-01-01", enteredBy: "t", enteredAt: "2026-01-01T00:00:00Z", enabled: true, illustrative: false, note: "", ...over });
const input = (rows: MarketRate[], over: Partial<ValueInput> = {}): ValueInput => ({ split: null, totalHours: 10, rateOf: (roleId) => resolveRate(rows, { country: "GB", roleId, levelId: "mid", kind: "freelancer" }, DEFAULT_PRICING_CONFIG, "2026-11-26"), country: "GB", levelId: "mid", levelAssumed: false, quoteCurrency: "GBP", inrPerUnit: 120, ...over });

before(() => { process.env.SILPI_DB_PATH = path.join(dir, "fin.db"); });
after(() => {
  const cached = globalThis as unknown as { silpiDb?: { close(): void } };
  cached.silpiDb?.close();
  delete cached.silpiDb;
  rmSync(dir, { recursive: true, force: true });
});

describe("1. A: the human-equivalent value", () => {
  it("is hours by role times the market median, with the range from the low and high figures, and converts to rupees with the quotation's own rate", () => {
    const rows = [row({ roleId: "frontend", medianMinor: 5000, minMinor: 4000, maxMinor: 7000 }), row({ roleId: "backend", medianMinor: 6000, minMinor: 5000, maxMinor: 9000 })];
    const a = humanEquivalent(input(rows, { split: [{ roleId: "frontend", hours: 6 }, { roleId: "backend", hours: 4 }] }));
    assert.deepEqual([a.status, a.currency, a.valueMinor, a.rangeMinor], ["ok", "GBP", 6 * 5000 + 4 * 6000, { min: 6 * 4000 + 4 * 5000, max: 6 * 7000 + 4 * 9000 }]);
    assert.equal(a.inr, (54_000 / 100) * 120, "540 pounds at 120 rupees a pound");
    assert.deepEqual(a.lines.map((l) => [l.roleId, l.hours, l.valueMinor]), [["frontend", 6, 30_000], ["backend", 4, 24_000]]);
  });
  it("uses the median, not the price: the billing multiplier, overhead and margin never enter A", () => {
    const rows = [row({ roleId: "any", medianMinor: 5000 })];
    const priced = { ...DEFAULT_PRICING_CONFIG, billing: { ...DEFAULT_PRICING_CONFIG.billing, freelancer: { multiplierBp: 30_000, overheadBp: 2000, marginBp: 5000 } } };
    const asIs = humanEquivalent(input(rows));
    const withBilling = humanEquivalent({ ...input(rows), rateOf: (roleId) => resolveRate(rows, { country: "GB", roleId, levelId: "mid", kind: "freelancer" }, priced, "2026-11-26") });
    assert.equal(asIs.valueMinor, 50_000);
    assert.equal(withBilling.valueMinor, 50_000, "whatever the billing settings say");
    assert.deepEqual([withBilling.lines[0]!.medianMinor, withBilling.lines[0]!.valueMinor], [5000, 50_000], "and on every line");
  });
  it("without an accepted split values every hour at the any-role rate and says so", () => {
    const a = humanEquivalent(input([row({ roleId: "any", medianMinor: 4500 })]));
    assert.equal(a.valueMinor, 45_000);
    assert.equal(a.lines[0]!.matchedRole, "any");
    assert.ok(a.basis.some((b) => /No hour split has been accepted/.test(b)));
  });
  it("leaves out a role with no verified rate, lists it, and says the figure is understated", () => {
    const a = humanEquivalent(input([row({ roleId: "frontend" })], { split: [{ roleId: "frontend", hours: 5 }, { roleId: "qa", hours: 5 }] }));
    assert.equal(a.status, "incomplete");
    assert.equal(a.valueMinor, 25_000, "only the frontend hours");
    assert.ok(a.basis.some((b) => /No verified market rate for: QA/.test(b) && /understated/.test(b)));
    assert.equal(a.lines.find((l) => l.roleId === "qa")!.valueMinor, null);
  });
  it("is unavailable, not zero, when there is no country, no hours, or no verified rate at all", () => {
    for (const bad of [input([], {}), input([row({})], { country: null }), input([row({})], { totalHours: 0 }), input([row({ country: "DE" })])]) {
      const a = humanEquivalent(bad);
      assert.deepEqual([a.status, a.valueMinor, a.inr], ["unavailable", null, null]);
      assert.ok(a.basis.length > 0);
    }
  });
  it("is shown in its own currency, unconverted and saying so, when the quotation is in another currency", () => {
    const a = humanEquivalent(input([row({ roleId: "any" })], { quoteCurrency: "INR", inrPerUnit: 1 }));
    assert.deepEqual([a.currency, a.valueMinor, a.inr], ["GBP", 50_000, null]);
    assert.ok(a.basis.some((b) => /not converted to rupees/.test(b)));
  });
  it("flags an assumed level", () => {
    const a = humanEquivalent(input([row({ roleId: "any" })], { levelAssumed: true }));
    assert.ok(a.basis.some((b) => /assumed/.test(b)));
  });
});

describe("2. the five figures of a real project", () => {
  before(async () => {
    const { s, d } = await mods();
    s.saveRateCard({ ...DEFAULT_RATE_CARD, countryPricing: { GBP: { hourlyRate: 25, inrPerUnit: 120, auto: false } } });
    for (const [roleId, median] of [["frontend", 5000], ["backend", 6000], ["ui-ux", 5500], ["qa", 4000], ["project-manager", 7000]] as const) d.addRate({ country: "GB", roleId, levelId: "mid", kind: "freelancer", min: median - 1000, median, max: median + 2000, source: SRC, effectiveDate: "2026-01-01" }, "t");
  });

  it("A, B, C, D and E are read from where they live, each with its own meaning", async () => {
    const { s, h, f } = await mods();
    const lead = s.createLead(uk(), site());
    const est = await h.suggestSplit(lead.id, "t", async () => ({ text: JSON.stringify({ split: [{ role: "frontend", hours: 5 }, { role: "backend", hours: 3 }, { role: "ui-ux", hours: 1 }, { role: "qa", hours: 1 }], reason: "x" }), model: "m", inputTokens: 1, outputTokens: 1 }));
    h.decideSplit(lead.id, est.id, "accepted", "t");
    const fin = f.leadFinancials(s.getLead(lead.id)!);
    const q = lead.quotation!;
    assert.deepEqual([fin.b.totalInr, fin.b.taxableInr, fin.b.currency, fin.b.inrPerUnit], [q.grandTotal, q.taxable, "GBP", 120]);
    assert.equal(fin.a.status, "ok");
    assert.equal(Math.round(fin.a.lines.reduce((a, l) => a + l.hours, 0) * 2), Math.round(q.totalHours * 2), "A values exactly the quotation's hours");
    assert.deepEqual([fin.c.provided, fin.d.configured], [false, false], "nothing entered yet: shown as not recorded, not as zero cost");
    assert.ok(fin.warnings.some((w) => /^C is not recorded/.test(w)) && fin.warnings.some((w) => /^D is not set up/.test(w)));
    assert.equal(fin.e.revenueInr, q.taxable);
    assert.equal(fin.e.provisional, true);
    assert.ok(fin.warnings.some((w) => /^E is provisional/.test(w)));
    assert.deepEqual(fin.rules, SEPARATION_RULES);
  });

  it("A moves with the market rates and nothing else moves; B moves with the price and A does not", async () => {
    const { s, d, f } = await mods();
    const lead = s.createLead(uk(), site());
    const before = f.leadFinancials(s.getLead(lead.id)!);
    d.addRate({ country: "GB", roleId: "any", levelId: "mid", kind: "freelancer", min: 9000, median: 12_000, max: 15_000, source: SRC, effectiveDate: "2026-06-01" }, "t");
    const after = f.leadFinancials(s.getLead(lead.id)!);
    assert.notEqual(after.a.valueMinor, before.a.valueMinor, "A follows the market");
    assert.deepEqual([after.b, after.c, after.d, after.e], [before.b, before.c, before.d, before.e], "B, C, D and E do not");

    // the price changes (the rate card), A does not
    s.saveRateCard({ ...DEFAULT_RATE_CARD, countryPricing: { GBP: { hourlyRate: 40, inrPerUnit: 120, auto: false } } });
    s.requote(lead.id, 0);
    const priced = f.leadFinancials(s.getLead(lead.id)!);
    assert.notEqual(priced.b.totalInr, after.b.totalInr, "B follows the price");
    assert.equal(priced.a.valueMinor, after.a.valueMinor, "A does not");
    assert.equal(priced.e.revenueInr, priced.b.taxableInr);
    s.saveRateCard({ ...DEFAULT_RATE_CARD, countryPricing: { GBP: { hourlyRate: 25, inrPerUnit: 120, auto: false } } });
  });

  it("E is the price without GST less the internal cost, and never uses A", async () => {
    const { s, d, f } = await mods();
    const lead = s.createLead(uk(), site());
    const x = f.leadFinancials(s.getLead(lead.id)!);
    assert.equal(Math.round((x.e.revenueInr - x.e.internalCostInr) * 100) / 100, x.e.grossProfitInr);
    d.addRate({ country: "GB", roleId: "any", levelId: "mid", kind: "freelancer", min: 90_000, median: 100_000, max: 110_000, source: SRC, effectiveDate: "2026-07-01" }, "t");
    const y = f.leadFinancials(s.getLead(lead.id)!);
    assert.notEqual(y.a.valueMinor, x.a.valueMinor);
    assert.deepEqual(y.e, x.e, "a huge market value changes the margin by nothing");
  });

  it("an Indian client is valued in rupees from the Indian country, an unknown country has no A, and a project with no quotation is refused", async () => {
    const { s, d, f } = await mods();
    d.addRate({ country: "IN", roleId: "any", levelId: "mid", kind: "freelancer", min: 40_000, median: 60_000, max: 90_000, source: SRC, effectiveDate: "2026-01-01" }, "t");
    const lead = s.createLead(india(), site());
    const fin = f.leadFinancials(s.getLead(lead.id)!);
    assert.deepEqual([fin.a.currency, fin.a.status], ["INR", "ok"]);
    assert.equal(fin.a.inr, (60_000 / 100) * lead.quotation!.totalHours, "600 rupees an hour for every hour");
    assert.equal(fin.b.currency, "INR");
    await fails(() => f.leadFinancials({ ...s.getLead(lead.id)!, quotation: undefined }), /no quotation/);
  });
});

describe("2b. which split and which country", () => {
  it("only a split accepted for the CURRENT quotation is used: after a new version the old split no longer applies", async () => {
    const { s, h, f } = await mods();
    const lead = s.createLead(uk(), site());
    const est = await h.suggestSplit(lead.id, "t", async () => ({ text: JSON.stringify({ split: [{ role: "frontend", hours: 1 }], reason: "x" }), model: "m", inputTokens: 1, outputTokens: 1 }));
    h.decideSplit(lead.id, est.id, "accepted", "t");
    assert.ok(!f.leadFinancials(s.getLead(lead.id)!).a.basis.some((b) => /No hour split has been accepted/.test(b)));
    s.requote(lead.id, 0);
    assert.ok(f.leadFinancials(s.getLead(lead.id)!).a.basis.some((b) => /No hour split has been accepted/.test(b)), "a new version needs its own accepted split");
  });
  it("a country named on the requirement beats the client's own country", async () => {
    const { s, f } = await mods();
    const client = parseClient({ ...base, state: "Outside India", country: "US", currency: "GBP" });
    const lead = s.createLead(client, site({ fixedBasis: { roleId: "frontend", levelId: "mid", country: "GB" } }));
    const fin = f.leadFinancials(s.getLead(lead.id)!);
    assert.equal(fin.a.status !== "unavailable", true, "the UK rates, not the (empty) US ones");
    assert.equal(fin.a.currency, "GBP");
  });
});

describe("3. the door and the screen", () => {
  it("the route answers for a project, 404s for a missing one, and is covered by the team sign-in gate", async () => {
    const { s } = await mods();
    const route = await import("@/app/api/business/leads/[id]/financials/route");
    const { NextRequest } = await import("next/server");
    const lead = s.createLead(uk(), site());
    const call = (id: string) => route.GET(new NextRequest(`http://localhost:3000/api/business/leads/${id}/financials`), { params: Promise.resolve({ id }) });
    const ok = await call(lead.id);
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.deepEqual(Object.keys(body.financials).sort(), ["a", "b", "c", "d", "e", "rules", "warnings"]);
    assert.equal((await call("nope")).status, 404);
    const mw = readFileSync(path.join(process.cwd(), "src/middleware.ts"), "utf8");
    assert.match(mw, /\/api\/business\/:path\*/, "every /api/business route is gated");
  });
  it("the client-facing pages and documents never mention the five figures", () => {
    const root = process.cwd();
    for (const f of ["src/components/business/quotation-document.tsx", "src/lib/business/documents.ts"]) {
      const text = readFileSync(path.join(root, f), "utf8");
      assert.ok(!/financials|humanEquivalent|human-equivalent/i.test(text), f);
    }
  });
});

describe("4. A never feeds a price", () => {
  it("no pricing, quotation, hour or approval code imports the financial report", async () => {
    const { readdirSync, statSync } = await import("node:fs");
    const root = path.join(process.cwd(), "src");
    const offenders: string[] = [];
    const walk = (d: string) => {
      for (const name of readdirSync(d)) {
        const p = path.join(d, name);
        if (statSync(p).isDirectory()) { walk(p); continue; }
        if (!/\.(ts|tsx)$/.test(name)) continue;
        const rel = path.relative(root, p).split(path.sep).join("/");
        if (/(^|\/)financials(-card)?\.tsx?$/.test(rel) || rel.startsWith("app/api/business/leads/[id]/financials")) continue;
        if (/business\/financials|server\/financials|humanEquivalent|leadFinancials/.test(readFileSync(p, "utf8")) && rel !== "components/studio/clients.tsx") offenders.push(rel);
      }
    };
    walk(root);
    assert.deepEqual(offenders, []);
  });
});
