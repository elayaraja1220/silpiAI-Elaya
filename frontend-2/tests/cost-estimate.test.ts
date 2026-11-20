// Step 3: cost estimation. Client development cost, internal delivery cost, running costs,
// profit and margin, budgets, technology factors, no double counting, compatibility.
//
// ALL MONEY VALUES BELOW ARE SAMPLE FIXTURES chosen so the arithmetic is easy to check by hand.
// They are not real rates, real provider prices or defaults of the product.
// Run: npm test
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { applyCostPatch, costConfigPatchProblems, emptyCostConfig, parseCostConfig, readCostPatch } from "@/lib/business/cost-config";
import { estimateCosts } from "@/lib/business/cost-estimate";
import { calcAiCost, calcInternalCost, classifyLine } from "@/lib/business/cost-internal";
import { calcProfit } from "@/lib/business/cost-profit";
import { calcRecurring, suggestRecurringItems } from "@/lib/business/cost-recurring";
import type { AiUsageRecord, CostConfig, RecurringCostItem } from "@/lib/business/cost-types";
import { buildQuote } from "@/lib/business/pricing";
import { DEFAULT_RATE_CARD } from "@/lib/business/rate-card";
import { parseClientTech } from "@/lib/business/tech-preference";
import type { LineItem, Quote, Requirement } from "@/lib/business/types";

const rates = DEFAULT_RATE_CARD;

// ---- Sample fixtures ------------------------------------------------------------------

const line = (category: LineItem["category"], description: string, qty: number): LineItem => ({ category, description, qty, unit: "hour", rate: 500, amount: qty * 500 });

/** 46 quoted hours at the sample client rate of 500/h = 23,000 ex GST; GST 18% = 4,140; total 27,140. */
const QUOTE: Pick<Quote, "items" | "totalHours" | "subtotal" | "discount" | "taxable" | "gst" | "roundOff" | "grandTotal" | "estimatedWeeks"> = {
  items: [
    line("development", "Business website: set-up, testing & deployment", 10),
    line("development", "Page: Home", 6),
    line("development", "Contact / enquiry form", 4),
    line("development", "User login & registration", 20),
    line("design", "Ready-made template, customised", 6),
  ],
  totalHours: 46,
  subtotal: 23000,
  discount: 0,
  taxable: 23000,
  gst: { mode: "intra", rate: 18, cgst: 2070, sgst: 2070, igst: 0, total: 4140 },
  roundOff: 0,
  grandTotal: 27140,
  estimatedWeeks: 2,
};

/** Sample internal rates (not the client rate) and allocations. */
const SAMPLE: CostConfig = applyCostPatch(emptyCostConfig(), {
  roleRates: { frontend: 300, backend: 350, uiux: 300, qa: 250, pm: 400, deployment: 300 },
  allocation: {
    setup: { frontend: 50, qa: 30, deployment: 20 },
    page: { frontend: 80, qa: 10, pm: 10 },
    "feature-frontend": { frontend: 100 },
    "feature-backend": { backend: 80, qa: 10, pm: 10 },
    design: { uiux: 100 },
    "premium-care": { qa: 50, deployment: 50 },
    other: { frontend: 100 },
  },
  usdToInr: 80,
  aiPricing: { "sample-model": { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75 } },
  infra: [
    { key: "dev-server", name: "Development server", basis: "per-week", amount: 500 },
    { key: "build-ci", name: "Build and test runner", basis: "per-dev-hour", amount: 5 },
  ],
  minMarginPercent: 25,
});
// People cost by hand: frontend 13.8 h x 300 = 4,140; backend 16 x 350 = 5,600; UI/UX 6 x 300 = 1,800;
// QA 5.6 x 250 = 1,400; PM 2.6 x 400 = 1,040; deployment 2 x 300 = 600  ->  14,580.
const PEOPLE = 14580;
// Infrastructure by hand: 2 weeks x 500 = 1,000; 46 h x 5 = 230  ->  1,230.
const INFRA = 1230;

const aiActual: AiUsageRecord = { id: "run-1", provider: "sample", model: "sample-model", actualCostUsd: 2.5 };
const aiTokens: AiUsageRecord = { id: "run-2", provider: "sample", model: "sample-model", inputTokens: 1_000_000, outputTokens: 100_000 };

function requirement(extra: Partial<Requirement> = {}): Requirement {
  return {
    title: "Site", summary: "A website requirement that is long enough.", scope: "full", existingProject: "", version: "", projectType: "business-website", complexity: "standard",
    pages: ["Home", "About Us", "Contact Us"], modules: ["contact-form"], design: "ai", references: "", domain: { needed: false, choice: "self", name: "", tld: ".com", years: 1 },
    hosting: { needed: false, choice: "self", plan: "static", years: 1 }, deadlineWeeks: 0, budget: 0, ...extra,
  };
}

const full = (extra: Partial<Parameters<typeof estimateCosts>[0]> = {}) =>
  estimateCosts({ quote: QUOTE, rates, config: SAMPLE, aiUsage: [], recurring: [], ...extra });

describe("1. client development cost: the existing pricing, copied", () => {
  it("shows subtotal, discount, taxable value, CGST, SGST and the total including GST exactly as quoted", () => {
    const quote = buildQuote(requirement({ pages: ["Home", "About Us", "Services", "Contact Us"] }), { state: "Tamil Nadu" }, rates, 500);
    const e = estimateCosts({ quote, rates, config: SAMPLE });
    const d = e.clientDevelopment;
    assert.equal(d.hours, quote.totalHours);
    assert.equal(d.subtotal, quote.subtotal);
    assert.equal(d.discount, 500);
    assert.equal(d.taxable, quote.subtotal - 500);
    assert.equal(d.gstMode, "intra");
    assert.equal(d.cgst, d.sgst);
    assert.equal(d.gstTotal, d.cgst + d.sgst);
    assert.equal(d.total, quote.grandTotal);
    assert.equal(Math.round(d.taxable + d.gstTotal), d.total);
  });
  it("handles inter-state (IGST) and export (no GST)", () => {
    const inter = buildQuote(requirement(), { state: "Karnataka" }, rates);
    assert.equal(estimateCosts({ quote: inter, rates, config: SAMPLE }).clientDevelopment.igst, inter.gst.igst);
    assert.ok(inter.gst.igst > 0);
    const exportQuote = buildQuote(requirement(), { state: "Outside India" }, rates);
    const d = estimateCosts({ quote: exportQuote, rates, config: SAMPLE }).clientDevelopment;
    assert.equal(d.gstTotal, 0);
    assert.equal(d.total, d.taxable);
  });
  it("never changes a price: the estimate neither reads nor alters the quote", () => {
    const quote = buildQuote(requirement(), { state: "Tamil Nadu" }, rates);
    const before = JSON.stringify(quote);
    estimateCosts({ quote, rates, config: SAMPLE, clientBudget: 1000 });
    assert.equal(JSON.stringify(quote), before);
  });
  it("states that it is development only", () => {
    assert.match(full().clientDevelopment.note, /Domain, hosting and other running costs are billed separately/);
  });
});

describe("2. internal hourly cost (separate from the client billing rate)", () => {
  const people = calcInternalCost({ quote: QUOTE, rates, config: SAMPLE, stackIds: [], scale: "small", security: "standard", aiUsage: [] }).human;
  it("shares each line's hours between roles and prices them at the internal rates", () => {
    const hours = Object.fromEntries(people.roles.map((r) => [r.role, r.hours]));
    assert.deepEqual(hours, { frontend: 13.8, backend: 16, uiux: 6, qa: 5.6, pm: 2.6, deployment: 2 });
    assert.equal(people.cost, PEOPLE);
    assert.equal(people.quotedHours, 46);
  });
  it("does not use the client billing rate", () => {
    const pricier = { ...rates, hourlyRate: 5000 };
    const same = calcInternalCost({ quote: QUOTE, rates: pricier, config: SAMPLE, stackIds: [], scale: "small", security: "standard", aiUsage: [] }).human;
    assert.equal(same.cost, PEOPLE);
  });
  it("recognises the kinds of quotation line, also in older quotations", () => {
    const kinds = QUOTE.items.map((i) => classifyLine(i, rates));
    assert.deepEqual(kinds, ["setup", "page", "feature-frontend", "feature-backend", "design"]);
    assert.equal(classifyLine({ category: "development", description: "Premium care" }, rates), "premium-care");
    assert.equal(classifyLine({ category: "development", description: "Existing codebase review & setup" }, rates), "setup");
    assert.equal(classifyLine({ category: "development", description: "Something else" }, rates), "other");
    assert.equal(classifyLine({ category: "hosting", description: "Hosting" }, rates), null);
  });
  it("can exceed the quoted hours when the allocation adds effort", () => {
    const extra = applyCostPatch(SAMPLE, { allocation: { page: { frontend: 100, qa: 50 } } });
    const h = calcInternalCost({ quote: QUOTE, rates, config: extra, stackIds: [], scale: "small", security: "standard", aiUsage: [] }).human;
    assert.ok(h.roles.reduce((s, r) => s + r.hours, 0) > h.quotedHours);
  });
});

describe("3. AI and API cost", () => {
  it("uses the provider-reported cost when there is one", () => {
    const { ai } = calcAiCost([aiActual], SAMPLE);
    assert.equal(ai.records[0].status, "actual");
    assert.equal(ai.totalUsd, 2.5);
    assert.equal(ai.totalInr, 200);
  });
  it("prices tokens at the configured prices (sample: 3 and 15 USD per million tokens)", () => {
    const { ai } = calcAiCost([aiTokens], SAMPLE);
    assert.equal(ai.records[0].status, "estimated");
    assert.equal(ai.records[0].costUsd, 4.5); // 1M x 3 + 0.1M x 15 = 3 + 1.5
    assert.equal(ai.totalInr, 360);
  });
  it("prices cache tokens only when their prices are configured", () => {
    const rec: AiUsageRecord = { provider: "sample", model: "sample-model", cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 };
    assert.equal(calcAiCost([rec], SAMPLE).ai.totalUsd, 4.05); // 0.3 + 3.75
    const noCache = applyCostPatch(SAMPLE, { aiPricing: { "sample-model": { inputPerMTok: 3, outputPerMTok: 15 } } });
    assert.equal(calcAiCost([rec], noCache).ai.records[0].status, "missing");
  });
  it("keeps actual and estimated apart", () => {
    const { ai } = calcAiCost([aiActual, aiTokens], SAMPLE);
    assert.equal(ai.actualUsd, 2.5);
    assert.equal(ai.estimatedUsd, 4.5);
    assert.equal(ai.totalUsd, 7);
    const e = full({ aiUsage: [aiActual, aiTokens] });
    assert.equal(e.internal.byStatus.actual, 200);
    assert.equal(e.internal.total, PEOPLE + INFRA + 560);
    assert.equal(e.internal.byStatus.estimated, e.internal.total - 200);
  });
  it("reports what is missing instead of inventing a price", () => {
    const unknown: AiUsageRecord = { provider: "x", model: "unpriced-model", inputTokens: 1000 };
    const a = calcAiCost([unknown, { provider: "x", model: "sample-model" }], SAMPLE);
    assert.deepEqual(a.ai.records.map((r) => r.status), ["missing", "missing"]);
    assert.ok(a.missing.some((m) => m.includes('"unpriced-model"')));
    assert.equal(a.ai.totalUsd, 0);
    const noFx = calcAiCost([aiActual], applyCostPatch(SAMPLE, { usdToInr: null }));
    assert.equal(noFx.ai.totalInr, null);
    assert.ok(noFx.missing.some((m) => m.includes("exchange rate")));
  });
  it("reports AI usage that was not provided at all", () => {
    assert.ok(estimateCosts({ quote: QUOTE, rates, config: SAMPLE }).internal.missing.includes("AI and API usage was not provided."));
  });
});

describe("4. infrastructure", () => {
  it("prices per project, per development hour and per week", () => {
    const i = calcInternalCost({ quote: QUOTE, rates, config: SAMPLE, stackIds: [], scale: "small", security: "standard", aiUsage: [] }).infrastructure;
    assert.equal(i.items.find((x) => x.key === "dev-server")!.amount, 1000);
    assert.equal(i.items.find((x) => x.key === "build-ci")!.amount, 230);
    assert.equal(i.total, INFRA);
    const perProject = applyCostPatch(SAMPLE, { infra: [{ key: "storage", name: "Project storage", basis: "per-project", amount: 120 }] });
    assert.equal(calcInternalCost({ quote: QUOTE, rates, config: perProject, stackIds: [], scale: "small", security: "standard", aiUsage: [] }).infrastructure.total, 120);
  });
  it("an item without an amount is missing; an explicit empty list means none", () => {
    const unpriced = applyCostPatch(SAMPLE, { infra: [{ key: "dev-server", name: "Development server", basis: "per-week", amount: null }] });
    const a = calcInternalCost({ quote: QUOTE, rates, config: unpriced, stackIds: [], scale: "small", security: "standard", aiUsage: [] });
    assert.ok(a.missing.some((m) => m.includes("Development server")));
    assert.equal(a.infrastructure.items[0].status, "missing");
    const none = calcInternalCost({ quote: QUOTE, rates, config: applyCostPatch(SAMPLE, { infra: [] }), stackIds: [], scale: "small", security: "standard", aiUsage: [] });
    assert.equal(none.missing.length, 0);
    assert.equal(none.complete, true);
  });
  it("never configured infrastructure is reported as missing", () => {
    const never = calcInternalCost({ quote: QUOTE, rates, config: applyCostPatch(SAMPLE, { infra: null }), stackIds: [], scale: "small", security: "standard", aiUsage: [] });
    assert.ok(never.missing.includes("Internal infrastructure costs are not configured."));
  });
});

describe("5. missing configuration is reported, never invented", () => {
  it("an empty configuration gives no cost and lists every gap", () => {
    const e = estimateCosts({ quote: QUOTE, rates, config: emptyCostConfig() });
    assert.equal(e.internal.human.cost, null);
    assert.equal(e.internal.total, 0, "nothing is guessed");
    assert.equal(e.internal.complete, false);
    assert.ok(e.internal.missing.some((m) => m.includes("No role allocation is configured for pages")));
    assert.ok(e.internal.missing.includes("AI and API usage was not provided."));
    assert.ok(e.internal.missing.includes("Internal infrastructure costs are not configured."));
    assert.equal(e.internal.human.unallocatedHours, 46);
  });
  it("a missing hourly rate names the role", () => {
    const cfg = applyCostPatch(SAMPLE, { roleRates: { backend: null, qa: null } });
    const e = full({ config: cfg });
    assert.ok(e.internal.missing.includes("No internal hourly cost is configured for backend development."));
    assert.ok(e.internal.missing.includes("No internal hourly cost is configured for testing and qa."));
    assert.equal(e.internal.human.cost, null);
    const backend = e.internal.human.roles.find((r) => r.role === "backend")!;
    assert.equal(backend.cost, null);
    assert.equal(backend.rate, null);
  });
  it("the people cost known so far is still shown, but marked incomplete", () => {
    const e = full({ config: applyCostPatch(SAMPLE, { roleRates: { backend: null } }) });
    assert.equal(e.internal.human.knownCost, PEOPLE - 5600);
    assert.equal(e.internal.complete, false);
  });
  it("a complete configuration reports nothing missing", () => {
    const e = full();
    assert.deepEqual(e.internal.missing, []);
    assert.equal(e.internal.complete, true);
  });
});

describe("6. client running costs", () => {
  const item = (extra: Partial<RecurringCostItem> & Pick<RecurringCostItem, "id" | "kind" | "amount">): RecurringCostItem => ({
    service: "Sample service", category: "other", currency: "INR", necessity: "mandatory", payer: "client", status: "estimated", ...extra,
  });
  const items = [
    item({ id: "vps", kind: "recurring", amount: 1000, frequency: "monthly", category: "vps", necessity: "mandatory" }),
    item({ id: "domain", kind: "recurring", amount: 800, frequency: "annual", category: "domain-renewal", necessity: "mandatory" }),
    item({ id: "mail", kind: "recurring", amount: 300, frequency: "quarterly", category: "email-service", necessity: "optional" }),
    item({ id: "setup", kind: "one-time", amount: 2000, category: "other", necessity: "optional" }),
  ];
  const r = calcRecurring(items, SAMPLE);
  it("keeps monthly, quarterly, annual and one-time charges apart", () => {
    const all = r.byPayer.client.all;
    assert.deepEqual(all, { oneTime: 2000, monthly: 1000, quarterly: 300, annual: 800, yearlyEquivalent: 1000 * 12 + 300 * 4 + 800 });
  });
  it("one-time costs are not in the yearly equivalent", () => {
    assert.equal(r.byPayer.client.all.yearlyEquivalent, 14000);
  });
  it("separates mandatory from optional, and the client from the studio", () => {
    assert.equal(r.byPayer.client.mandatory.monthly, 1000);
    assert.equal(r.byPayer.client.optional.quarterly, 300);
    assert.equal(r.byPayer.studio.all.monthly, 0);
    const studio = calcRecurring([item({ id: "free-year", kind: "recurring", amount: 500, frequency: "monthly", payer: "studio" })], SAMPLE);
    assert.equal(studio.byPayer.studio.all.monthly, 500);
    assert.equal(studio.byPayer.client.all.monthly, 0);
  });
  it("an unknown amount stays unknown and is not totalled", () => {
    const u = calcRecurring([item({ id: "hosting", kind: "recurring", amount: null, frequency: "annual" })], SAMPLE);
    assert.deepEqual(u.unknown, ["hosting"]);
    assert.equal(u.byPayer.client.all.annual, 0);
    assert.equal(u.items[0].counted, false);
  });
  it("percentage charges (payment gateway) are variable, not totalled", () => {
    const v = calcRecurring([item({ id: "pg", kind: "recurring", amount: 2, amountType: "percent-of-transaction", frequency: "monthly", category: "payment-gateway" })], SAMPLE);
    assert.deepEqual(v.variable, ["pg"]);
    assert.equal(v.byPayer.client.all.monthly, 0);
  });
  it("converts other currencies only with a configured rate", () => {
    const usd = item({ id: "api", kind: "recurring", amount: 10, currency: "USD", frequency: "monthly" });
    assert.deepEqual(calcRecurring([usd], SAMPLE).unconverted, ["api"]);
    const withFx = calcRecurring([usd], applyCostPatch(SAMPLE, { fxRates: { USD: 80 } }));
    assert.equal(withFx.byPayer.client.all.monthly, 800);
    assert.deepEqual(withFx.unconverted, []);
  });
  it("a recurring item needs a billing frequency", () => {
    const x = calcRecurring([item({ id: "nofreq", kind: "recurring", amount: 100 })], SAMPLE);
    assert.equal(x.items[0].counted, false);
    assert.match(x.items[0].reason!, /billing frequency/);
  });
  it("suggests the likely running costs with every amount unknown (no provider prices are built in)", () => {
    const s = suggestRecurringItems(["javascript", "nextjs", "nodejs", "postgresql", "vps"], requirement({ modules: ["payments", "notifications"] }));
    assert.ok(s.every((i) => i.amount === null && i.payer === "client"));
    assert.deepEqual(s.map((i) => i.id), ["domain", "hosting-vps", "payment-gateway", "email-service", "maintenance"]);
    assert.equal(calcRecurring(s, SAMPLE).byPayer.client.all.yearlyEquivalent, 0);
  });
});

describe("7. profit and margin", () => {
  it("gross profit and margin come from revenue excluding GST and the internal cost only", () => {
    const e = full({ aiUsage: [aiActual, aiTokens] });
    assert.equal(e.profit.revenue, 23000, "revenue excludes the 4,140 GST");
    assert.equal(e.profit.internalCost, PEOPLE + INFRA + 560);
    assert.equal(e.profit.grossProfit, 23000 - (PEOPLE + INFRA + 560));
    assert.equal(e.profit.grossMarginPercent, Math.round(((23000 - 16370) / 23000) * 10000) / 100);
    assert.equal(e.profit.grossMarginPercent, 28.83);
  });
  it("calcProfit follows the stated formulas", () => {
    const p = calcProfit(10000, 7500, true, 20);
    assert.equal(p.grossProfit, 2500);
    assert.equal(p.grossMarginPercent, 25);
    assert.equal(calcProfit(0, 100, true, null).grossMarginPercent, null);
  });
  it("GST is never revenue", () => {
    assert.equal(full().profit.revenue, QUOTE.taxable);
    assert.notEqual(full().profit.revenue, QUOTE.grandTotal);
  });
  it("running costs are never revenue, cost or profit", () => {
    const base = full();
    const withRunning = full({ recurring: suggestRecurringItems(["vps"]).map((i) => ({ ...i, amount: 5000, frequency: "monthly" as const })) });
    assert.deepEqual(withRunning.profit, base.profit);
    assert.equal(withRunning.internal.total, base.internal.total);
    assert.equal(withRunning.clientDevelopment.total, base.clientDevelopment.total);
  });
  it("flags profit as provisional while the cost is incomplete", () => {
    assert.equal(estimateCosts({ quote: QUOTE, rates, config: emptyCostConfig() }).profit.provisional, true);
    assert.equal(full().profit.provisional, false);
  });
});

describe("8. negative profit and margin warnings", () => {
  const costly = applyCostPatch(SAMPLE, { roleRates: { frontend: 2000, backend: 2000 } });
  it("warns when internal cost exceeds development revenue", () => {
    const e = full({ config: costly });
    assert.ok(e.profit.grossProfit < 0);
    assert.ok(e.warnings.some((w) => w.includes("is more than the development revenue excluding GST") && w.includes("a loss of")));
    assert.equal(e.budget.viability, "not-viable");
  });
  it("warns when the margin is below the configured minimum", () => {
    const thin = applyCostPatch(SAMPLE, { minMarginPercent: 60 });
    const e = full({ config: thin });
    assert.ok(e.profit.grossMarginPercent! < 60 && e.profit.grossMarginPercent! > 0);
    assert.ok(e.warnings.some((w) => w.includes("below the minimum target of 60%")));
    assert.equal(e.budget.viability, "at-risk");
  });
  it("no warning when the margin meets the target; the project is viable", () => {
    const e = full();
    assert.ok(e.profit.grossMarginPercent! >= 25);
    assert.deepEqual(e.warnings, []);
    assert.equal(e.budget.viability, "viable");
  });
  it("says so when no minimum margin is configured", () => {
    const e = full({ config: applyCostPatch(SAMPLE, { minMarginPercent: null }) });
    assert.ok(e.warnings.some((w) => w.includes("No minimum margin target is configured")));
  });
  it("warns that missing inputs make the profit look better than it is", () => {
    const e = estimateCosts({ quote: QUOTE, rates, config: applyCostPatch(SAMPLE, { roleRates: { backend: null } }), aiUsage: [] });
    assert.ok(e.warnings.some((w) => w.includes("Internal cost is incomplete") && w.includes("higher than it will be")));
    assert.equal(e.budget.viability, "unknown");
  });
  it("warns when AI cost is only an estimate", () => {
    assert.ok(full({ aiUsage: [aiTokens] }).warnings.some((w) => w.includes("AI cost is estimated")));
  });
});

describe("9. budgets: client and internal, kept apart", () => {
  it("client shortfall: the quotation is over the client's budget, and the price stays the same", () => {
    const over = full({ clientBudget: 20000 });
    assert.equal(over.budget.client.status, "over");
    assert.equal(over.budget.client.quote, 27140);
    assert.equal(over.budget.client.shortfall, 7140);
    assert.equal(over.budget.client.difference, -7140);
    assert.equal(over.budget.viability, "at-risk");
    assert.ok(over.budget.reasons.some((r) => r.includes("Prices are not reduced")));
    assert.equal(over.clientDevelopment.total, full().clientDevelopment.total);
  });
  it("client budget remaining, near and none", () => {
    assert.equal(full({ clientBudget: 30000 }).budget.client.difference, 2860);
    assert.equal(full({ clientBudget: 30000 }).budget.client.status, "near");
    assert.equal(full({ clientBudget: 100000 }).budget.client.status, "within");
    assert.equal(full().budget.client.status, "none");
  });
  it("uses the requirement's own budget when none is passed", () => {
    assert.equal(full({ requirement: requirement({ budget: 20000 }) }).budget.client.shortfall, 7140);
  });
  it("internal shortfall: internal cost is over the internal budget, so it is not viable", () => {
    const e = full({ internalBudget: 10000 });
    assert.equal(e.budget.internal.estimatedCost, PEOPLE + INFRA);
    assert.equal(e.budget.internal.shortfall, PEOPLE + INFRA - 10000);
    assert.equal(e.budget.internal.status, "over");
    assert.equal(e.budget.viability, "not-viable");
  });
  it("internal budget remaining", () => {
    const e = full({ internalBudget: 20000 });
    assert.equal(e.budget.internal.difference, 20000 - (PEOPLE + INFRA));
    assert.equal(e.budget.internal.shortfall, 0);
  });
  it("the two budgets are independent", () => {
    const e = full({ clientBudget: 100000, internalBudget: 10000 });
    assert.equal(e.budget.client.status, "within");
    assert.equal(e.budget.internal.status, "over");
  });
  it("a larger budget never raises the cost, the complexity or the technology", () => {
    const small = full({ clientBudget: 10000, requirement: requirement({ budget: 10000 }) });
    const large = full({ clientBudget: 5_000_000, requirement: requirement({ budget: 5_000_000 }) });
    assert.deepEqual(large.internal, small.internal);
    assert.deepEqual(large.technology, small.technology);
    assert.deepEqual(large.clientDevelopment, small.clientDevelopment);
  });
});

describe("10. technology-aware internal cost", () => {
  const withFactors = applyCostPatch(SAMPLE, { techFactors: { nextjs: 1.2, nodejs: 1.1, postgresql: 1.3, vps: 1.5 } });
  const stack = ["nextjs", "nodejs", "postgresql", "vps"];
  const people = (config: CostConfig, ids: string[]) => calcInternalCost({ quote: QUOTE, rates, config, stackIds: ids, scale: "small", security: "standard", aiUsage: [], }).human;
  it("applies the configured effort factors to the roles that work on each layer", () => {
    const h = people(withFactors, stack);
    const factor = (role: string) => h.roles.find((r) => r.role === role)!.factor;
    assert.equal(factor("frontend"), 1.2);
    assert.equal(factor("backend"), 1.2, "Node.js 1.1 and PostgreSQL 1.3 average 1.2");
    assert.equal(factor("deployment"), 1.5);
    assert.equal(factor("qa"), 1, "roles that do not work on a layer are unchanged");
    assert.ok(h.cost! > PEOPLE);
  });
  it("a technology in the stack without a factor leaves the people cost incomplete (null) while showing what is known", () => {
    const out = calcInternalCost({ quote: QUOTE, rates, config: withFactors, stackIds: ["javascript", ...stack], scale: "small", security: "standard", aiUsage: [] });
    assert.equal(out.human.cost, null);
    assert.ok(out.missing.some((m) => m.includes("JavaScript")));
    assert.ok(out.human.knownCost > PEOPLE);
  });
  it("a technology without a configured factor is reported, and no adjustment is made", () => {
    const partial = applyCostPatch(SAMPLE, { techFactors: { nextjs: 1.2 } });
    const out = calcInternalCost({ quote: QUOTE, rates, config: partial, stackIds: stack, scale: "small", security: "standard", aiUsage: [] });
    assert.ok(out.missing.some((m) => m.includes("Node.js") && m.includes("no adjustment was applied")));
    assert.equal(out.human.roles.find((r) => r.role === "backend")!.factor, 1);
  });
  it("without a stack there is no adjustment and nothing is missing about technology", () => {
    const h = people(withFactors, []);
    assert.equal(h.cost, PEOPLE);
  });
  it("scale and security uplifts are configurable and reported when missing", () => {
    const up = applyCostPatch(SAMPLE, { uplifts: { scale: { large: 10 }, security: { high: 20 } } });
    const a = calcInternalCost({ quote: QUOTE, rates, config: up, stackIds: [], scale: "large", security: "high", aiUsage: [] });
    assert.equal(a.human.uplift.amount, Math.round(PEOPLE * 0.3 * 100) / 100);
    assert.equal(a.human.cost, PEOPLE + 4374);
    const b = calcInternalCost({ quote: QUOTE, rates, config: SAMPLE, stackIds: [], scale: "medium", security: "elevated", aiUsage: [] });
    assert.ok(b.missing.includes("No internal uplift is configured for medium scale."));
    assert.ok(b.missing.includes("No internal uplift is configured for elevated security."));
  });
  it("uses an explicit stack, then the recommendation, then what the client asked for", () => {
    const req = requirement({ clientTech: parseClientTech(["HTML", "CSS", "Vanilla JavaScript"]) });
    assert.deepEqual(full({ requirement: req }).technology.source, "client");
    assert.deepEqual(full({ requirement: req }).technology.stackIds, ["html", "css", "javascript"]);
    const rec = full({ requirement: req, recommendation: { ids: ["javascript", "nextjs", "vps"], maintenance: "medium" } });
    assert.equal(rec.technology.source, "recommendation");
    assert.equal(rec.technology.maintenance, "medium");
    const given = full({ requirement: req, recommendation: { ids: ["javascript", "nextjs"], maintenance: "low" }, stackIds: ["javascript", "react"] });
    assert.equal(given.technology.source, "given");
    assert.deepEqual(given.technology.stackIds, ["javascript", "react"]);
  });
  it("keeps a confirmed alternative instead of the original request", () => {
    const req = requirement({ clientTech: { ...parseClientTech(["Vue"])!, confirmedIds: ["javascript", "nextjs"] } });
    assert.deepEqual(full({ requirement: req }).technology.stackIds, ["javascript", "nextjs"]);
  });
  it("takes scale and security from the requirement unless overridden", () => {
    const shop = requirement({ projectType: "ecommerce", modules: ["payments", "auth"] });
    const e = full({ requirement: shop });
    assert.equal(e.technology.scale, "medium");
    assert.equal(e.technology.security, "elevated");
    const forced = full({ requirement: shop, needs: { scale: "large", security: "high" } });
    assert.equal(forced.technology.scale, "large");
    assert.equal(forced.technology.security, "high");
  });
});

describe("11. no double counting", () => {
  it("an AI record passed twice is counted once", () => {
    assert.equal(calcAiCost([aiActual, aiActual, { ...aiActual }], SAMPLE).ai.totalUsd, 2.5);
  });
  it("a provider-reported cost wins over the tokens: one cost per record", () => {
    const both: AiUsageRecord = { id: "x", provider: "sample", model: "sample-model", actualCostUsd: 1, inputTokens: 1_000_000, outputTokens: 1_000_000 };
    const { ai } = calcAiCost([both], SAMPLE);
    assert.equal(ai.totalUsd, 1);
    assert.equal(ai.records[0].status, "actual");
  });
  it("a running cost already counted elsewhere is left out", () => {
    const hosting: RecurringCostItem = { id: "host", service: "Staging server", category: "vps", kind: "recurring", amount: 1000, frequency: "monthly", currency: "INR", necessity: "mandatory", payer: "studio", status: "actual", countedIn: "dev-server" };
    const r = calcRecurring([hosting, { ...hosting, id: "other", countedIn: undefined }], SAMPLE);
    assert.equal(r.items[0].counted, false);
    assert.match(r.items[0].reason!, /Already counted in dev-server/);
    assert.equal(r.byPayer.studio.all.monthly, 1000, "only the one that is not counted elsewhere");
  });
  it("duplicate running-cost ids are counted once", () => {
    const x: RecurringCostItem = { id: "dup", service: "S", category: "other", kind: "one-time", amount: 100, currency: "INR", necessity: "optional", payer: "client", status: "estimated" };
    assert.equal(calcRecurring([x, x], SAMPLE).byPayer.client.all.oneTime, 100);
  });
  it("a studio-paid project cost is internal cost, not running cost, and not both", () => {
    const licence: RecurringCostItem = { id: "licence", service: "Template licence", category: "other", kind: "one-time", amount: 1500, currency: "INR", necessity: "mandatory", payer: "studio", status: "actual", includeInDeliveryCost: true };
    const e = full({ recurring: [licence] });
    assert.equal(e.internal.studioProjectCosts.total, 1500);
    assert.equal(e.internal.total, PEOPLE + INFRA + 1500);
    assert.equal(e.recurring.byPayer.studio.all.oneTime, 0);
    const unknown = full({ recurring: [{ ...licence, amount: null }] });
    assert.equal(unknown.internal.complete, false);
    assert.ok(unknown.internal.missing.some((m) => m.includes("Template licence")));
  });
  it("complexity and the technology effort already in the quote are not applied again", () => {
    const basic = buildQuote(requirement({ complexity: "basic" }), { state: "Tamil Nadu" }, rates);
    const advanced = buildQuote(requirement({ complexity: "advanced" }), { state: "Tamil Nadu" }, rates);
    const hours = (q: Quote) => calcInternalCost({ quote: q, rates, config: SAMPLE, stackIds: [], scale: "small", security: "standard", aiUsage: [] }).human.quotedHours;
    assert.equal(hours(basic), basic.totalHours);
    assert.equal(hours(advanced), advanced.totalHours);
  });
  it("actual hours replace the estimate; they are not added to it", () => {
    const e = full({ actualHours: 69 });
    assert.equal(e.internal.human.basis, "actual-hours");
    assert.equal(e.internal.human.cost, Math.round((PEOPLE * 69) / 46 * 100) / 100);
    assert.ok(e.internal.assumptions.some((a) => a.includes("estimated mix of roles")));
    assert.equal(e.internal.byStatus.actual, e.internal.human.cost);
    assert.equal(e.internal.infrastructure.items.find((i) => i.key === "build-ci")!.amount, 69 * 5, "per-hour infrastructure follows the hours worked");
  });
});

describe("12. domain and hosting are never in the development totals", () => {
  const withServices = requirement({
    domain: { needed: true, choice: "arrange", name: "brightwave", tld: ".com", years: 1 },
    hosting: { needed: true, choice: "arrange", plan: "shared", years: 1 },
  });
  it("the development total is the same with or without domain and hosting", () => {
    const a = buildQuote(withServices, { state: "Tamil Nadu" }, rates);
    const b = buildQuote(requirement(), { state: "Tamil Nadu" }, rates);
    assert.ok(a.services && a.services.total > 0, "the separate services are priced on their own");
    assert.equal(a.grandTotal, b.grandTotal);
    const e = estimateCosts({ quote: a, rates, config: SAMPLE });
    assert.equal(e.clientDevelopment.total, a.grandTotal);
    assert.equal(e.profit.revenue, a.taxable);
    assert.notEqual(e.clientDevelopment.total, a.grandTotal + a.services!.total);
  });
  it("the three costs are separate and never summed", () => {
    const e = full({ recurring: [{ id: "d", service: "Domain", category: "domain-renewal", kind: "recurring", amount: 800, frequency: "annual", currency: "INR", necessity: "mandatory", payer: "client", status: "estimated" }] });
    assert.equal(e.separate, true);
    assert.equal(e.clientDevelopment.total, 27140);
    assert.equal(e.internal.total, PEOPLE + INFRA);
    assert.equal(e.recurring.byPayer.client.all.annual, 800);
    assert.ok(![e.clientDevelopment.total + e.internal.total, 27140 + 800].includes(e.profit.revenue));
  });
});

describe("13. configuration: validation, merging and compatibility", () => {
  it("starts empty: no built-in rates", () => {
    const c = emptyCostConfig();
    assert.ok(Object.values(c.roleRates).every((v) => v === null));
    assert.ok(Object.values(c.allocation).every((v) => v === null));
    assert.deepEqual(c.aiPricing, {});
    assert.equal(c.usdToInr, null);
    assert.equal(c.infra, null);
    assert.equal(c.minMarginPercent, null);
  });
  it("reads saved data leniently and drops what is invalid", () => {
    const c = parseCostConfig({ roleRates: { frontend: 300, backend: -5, cobol: 1 }, usdToInr: "fast", techFactors: { nextjs: 1.2, ghost: 2, angular: 99 }, junk: true, minMarginPercent: 30 });
    assert.equal(c.roleRates.frontend, 300);
    assert.equal(c.roleRates.backend, null);
    assert.equal(c.usdToInr, null);
    assert.deepEqual(c.techFactors, { nextjs: 1.2 });
    assert.equal(c.minMarginPercent, 30);
  });
  it("a damaged saved value never breaks anything", () => {
    for (const bad of [null, undefined, "x", 5, [], { roleRates: "no" }, { allocation: { page: { frontend: "all" } } }]) {
      assert.deepEqual(parseCostConfig(bad), emptyCostConfig());
    }
  });
  it("a submitted change is checked strictly and every problem is listed", () => {
    assert.deepEqual(costConfigPatchProblems({ roleRates: { frontend: 400 }, usdToInr: 83 }), []);
    const problems = costConfigPatchProblems({
      roleRates: { frontend: -1, wizard: 5 }, usdToInr: 0, minMarginPercent: 150, allocation: { page: {} },
      techFactors: { cobol: 1, nextjs: 9 }, infra: [{ key: "A B", name: "x", basis: "per-project", amount: 1 }], aiPricing: { m: { inputPerMTok: 1 } }, extra: 1,
    });
    assert.ok(problems.length >= 9, problems.join(" | "));
    assert.ok(problems.some((p) => p.includes("roleRates.frontend")) && problems.some((p) => p.includes("roleRates.wizard")) && problems.some((p) => p.includes('"extra"')));
    for (const bad of [null, [], "x"]) assert.equal(costConfigPatchProblems(bad).length, 1);
  });
  it("merging keeps other values and null removes one", () => {
    const a = applyCostPatch(SAMPLE, { roleRates: { frontend: 999 }, techFactors: { nextjs: 1.1 }, aiPricing: { "sample-model": null } });
    assert.equal(a.roleRates.frontend, 999);
    assert.equal(a.roleRates.backend, 350);
    assert.deepEqual(a.techFactors, { nextjs: 1.1 });
    assert.deepEqual(a.aiPricing, {});
    assert.equal(SAMPLE.roleRates.frontend, 300, "the original is not changed");
    assert.equal(applyCostPatch(a, { allocation: { page: null } }).allocation.page, null);
  });
  it("the allocation of a line kind can total more than 100 but not nothing", () => {
    assert.equal(readCostPatch({ allocation: { page: { frontend: 200 } } }).problems.length, 0);
    assert.equal(readCostPatch({ allocation: { page: { frontend: 400 } } }).problems.length, 1);
  });
  it("an older saved quotation (without the newer fields) still works and gives the same result", () => {
    const q = buildQuote(requirement(), { state: "Tamil Nadu" }, rates);
    const old = JSON.parse(JSON.stringify(q));
    for (const field of ["pageCount", "services", "deferred", "seo", "stack", "schedule"]) delete old[field];
    const a = estimateCosts({ quote: q, rates, config: SAMPLE, aiUsage: [] });
    const b = estimateCosts({ quote: old, rates, config: SAMPLE, aiUsage: [] });
    assert.deepEqual(b.internal, a.internal);
    assert.deepEqual(b.clientDevelopment, a.clientDevelopment);
    assert.deepEqual(b.profit, a.profit);
  });
});

describe("14. persistence (separate from quotations and the rate card)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "silpi-cost-"));
  process.env.SILPI_DB_PATH = path.join(dir, "test.db");
  after(() => {
    const cached = globalThis as unknown as { silpiDb?: { close(): void } };
    cached.silpiDb?.close();
    delete cached.silpiDb;
    rmSync(dir, { recursive: true, force: true });
  });

  it("starts empty, saves changes, merges later ones and survives a re-read", async () => {
    const store = await import("@/lib/business/store");
    assert.deepEqual(store.getCostConfig(), emptyCostConfig());
    store.saveCostConfig({ roleRates: { frontend: 300 }, usdToInr: 80 });
    store.saveCostConfig({ roleRates: { backend: 350 }, infra: [] });
    const saved = store.getCostConfig();
    assert.equal(saved.roleRates.frontend, 300);
    assert.equal(saved.roleRates.backend, 350);
    assert.equal(saved.usdToInr, 80);
    assert.deepEqual(saved.infra, []);
    assert.equal(saved.roleRates.qa, null);
  });
  it("saving costs does not touch the rate card, quotations or the other settings", async () => {
    const store = await import("@/lib/business/store");
    const { parseRequirement } = await import("@/lib/business/validate");
    const client = { name: "T", email: "t@example.com", phone: "9876543210", company: "", gstin: "", state: "Tamil Nadu", address: "" };
    const lead = store.createLead(client, parseRequirement(requirement({ pages: ["Home", "Contact Us"] }), store.getRateCard()), "standard");
    const before = JSON.stringify([store.getRateCard(), store.getLead(lead.id)!.quotation, store.getTechOverrides()]);
    store.saveCostConfig({ roleRates: { qa: 250 }, minMarginPercent: 20 });
    assert.equal(JSON.stringify([store.getRateCard(), store.getLead(lead.id)!.quotation, store.getTechOverrides()]), before);
    // the saved quotation reopens and can be costed
    const reopened = store.getLead(lead.id)!;
    const e = estimateCosts({ quote: reopened.quotation!, rates: store.getRateCard(), config: store.getCostConfig(), requirement: reopened.requirement });
    assert.equal(e.clientDevelopment.total, reopened.quotation!.grandTotal);
    assert.equal(e.profit.revenue, reopened.quotation!.taxable);
  });
  it("damaged saved data falls back to the empty configuration", async () => {
    const store = await import("@/lib/business/store");
    const { getDb } = await import("@/lib/business/db");
    getDb().prepare("UPDATE settings SET value = ? WHERE key = 'cost_config'").run("{not json");
    assert.deepEqual(store.getCostConfig(), emptyCostConfig());
    store.saveCostConfig({ minMarginPercent: 25 });
    assert.equal(store.getCostConfig().minMarginPercent, 25);
  });
});
