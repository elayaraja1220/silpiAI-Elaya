// Step 4: UI integration. The screens render from pure view models, so what they show can be tested here:
// technology recommendations, the client's own choice, the three separate cost sections,
// running costs, missing-configuration warnings, the public quotation and the approved stack reaching the builder.
//
// ALL MONEY VALUES ARE SAMPLE FIXTURES chosen so the arithmetic is easy to check. They are not real rates.
// Run: npm test
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { buildBrief } from "@/lib/business/brief";
import { clientView } from "@/lib/business/client-view";
import { applyCostPatch, costConfigPatchProblems, emptyCostConfig, parseCostConfig } from "@/lib/business/cost-config";
import { estimateCosts } from "@/lib/business/cost-estimate";
import { calcRecurring, suggestRecurringItems } from "@/lib/business/cost-recurring";
import type { CostConfig } from "@/lib/business/cost-types";
import { buildCostView, configStatus, costConfigReadiness, internalSummary, isCostConfigEmpty } from "@/lib/business/cost-view";
import { buildQuote, formatINR, suggestStack } from "@/lib/business/pricing";
import { buildProposals } from "@/lib/business/proposals";
import { DEFAULT_RATE_CARD } from "@/lib/business/rate-card";
import { buildCatalog } from "@/lib/business/tech-catalog";
import { parseClientTech } from "@/lib/business/tech-preference";
import { recommendTechnology } from "@/lib/business/tech-recommend";
import { buildTechnologyView } from "@/lib/business/technology-view";
import type { Lead, LineItem, Quotation, Requirement } from "@/lib/business/types";
import { parseRequirement } from "@/lib/business/validate";

const rates = DEFAULT_RATE_CARD;
const TN = { state: "Tamil Nadu" };

function site(extra: Partial<Requirement> = {}): Requirement {
  return {
    title: "Site", summary: "A four page website that is long enough to be valid.", scope: "full", existingProject: "", version: "", projectType: "business-website", complexity: "basic",
    pages: ["Home", "About Us", "Services", "Contact Us"],
    pageDetails: { Home: { sections: 4, purpose: "" }, "About Us": { sections: 3, purpose: "" }, Services: { sections: 5, purpose: "" }, "Contact Us": { sections: 3, purpose: "" } },
    modules: [], design: "ai", references: "", domain: { needed: false, choice: "self", name: "", tld: ".com", years: 1 },
    hosting: { needed: false, choice: "self", plan: "static", years: 1 }, deadlineWeeks: 0, budget: 0, ...extra,
  };
}
const shop = (extra: Partial<Requirement> = {}) => site({ projectType: "ecommerce", complexity: "standard", modules: ["payments", "auth", "admin-panel"], budget: 150000, ...extra });
const view = (req: Requirement, catalog = buildCatalog(), budget = 0) => buildTechnologyView(req, recommendTechnology(req, budget, catalog, rates), catalog);

// ---- sample cost fixtures (same easy numbers as the cost engine tests) --------------------
const line = (category: LineItem["category"], description: string, qty: number): LineItem => ({ category, description, qty, unit: "hour", rate: 500, amount: qty * 500 });
const QUOTE = {
  items: [line("development", "Business website: set-up, testing & deployment", 10), line("development", "Page: Home", 6), line("development", "Contact / enquiry form", 4), line("development", "User login & registration", 20), line("design", "Ready-made template, customised", 6)],
  totalHours: 46, subtotal: 23000, discount: 0, taxable: 23000, gst: { mode: "intra" as const, rate: 18, cgst: 2070, sgst: 2070, igst: 0, total: 4140 }, roundOff: 0, grandTotal: 27140, estimatedWeeks: 2,
};
const SAMPLE: CostConfig = applyCostPatch(emptyCostConfig(), {
  roleRates: { frontend: 300, backend: 350, uiux: 300, qa: 250, pm: 400, deployment: 300 },
  allocation: {
    setup: { frontend: 50, qa: 30, deployment: 20 }, page: { frontend: 80, qa: 10, pm: 10 }, "feature-frontend": { frontend: 100 },
    "feature-backend": { backend: 80, qa: 10, pm: 10 }, design: { uiux: 100 }, "premium-care": { qa: 50, deployment: 50 }, other: { frontend: 100 },
  },
  usdToInr: 80, infra: [{ key: "dev-server", name: "Development server", basis: "per-week", amount: 500 }, { key: "build-ci", name: "Build runner", basis: "per-dev-hour", amount: 5 }], minMarginPercent: 25,
});
function costView(config: CostConfig, extra: Partial<Parameters<typeof estimateCosts>[0]> = {}) {
  const estimate = estimateCosts({ quote: QUOTE, rates, config, aiUsage: [], ...extra });
  const suggested = suggestRecurringItems(estimate.technology.stackIds, extra.requirement, config.runningCosts);
  return { estimate, view: buildCostView(estimate, config, calcRecurring(suggested, config)) };
}

describe("1. technology recommendations on screen", () => {
  it("shows frontend, backend, database, styling and hosting, with the reasons, facts and cost", () => {
    const v = view(shop());
    assert.equal(v.visible, true);
    assert.equal(v.state, "recommendations");
    const o = v.options[0];
    assert.deepEqual(o.stack.map((s) => s.label), ["Frontend", "Backend", "Database", "Styling", "Hosting"]);
    assert.ok(o.stack.every((s) => s.value.length > 0));
    assert.ok(o.reasons.length > 0);
    assert.match(o.complexity, /^(Low|Medium|High)$/);
    assert.match(o.maintenance, /^(Low|Medium|High)$/);
    assert.match(o.scalability, /^Suited up to (small|medium|large) scale$/);
    assert.ok(o.hours! > 0);
    assert.match(o.cost!, /^₹/);
    assert.match(o.costNote, /Domain and hosting are billed separately/);
  });
  it("labels our options as recommendations, never as the client's choice", () => {
    for (const o of view(shop()).options) {
      assert.equal(o.source, "recommended");
      assert.equal(o.sourceLabel, "Our recommendation");
    }
  });
  it("uses only technologies enabled in the catalog", () => {
    const withoutNext = buildCatalog({ nextjs: { enabled: false }, react: { enabled: true } });
    for (const o of view(shop(), withoutNext).options) assert.ok(!o.appIds.includes("nextjs") && !o.appIds.includes("angular"), o.appIds.join());
    const none = buildCatalog(Object.fromEntries(["html", "css", "javascript", "nextjs", "nodejs", "postgresql", "shared-hosting", "vps", "cloud-hosting"].map((id) => [id, { enabled: false }])));
    assert.equal(view(shop(), none).visible, false);
  });
  it("compares each option with the client's budget without changing the price", () => {
    const over = view(site({ budget: 10000 }), buildCatalog(), 10000).options[0];
    assert.match(over.budget!, /^Over the client's budget by ₹/);
    const within = view(site({ budget: 500000 }), buildCatalog(), 500000).options[0];
    assert.match(within.budget!, /^Within the client's budget/);
    assert.equal(over.cost, within.cost, "the estimate does not depend on the budget");
  });
  it("a simple site is recommended plain HTML, CSS and JavaScript", () => {
    const o = view(site()).options[0];
    assert.equal(o.stack[0].value, "HTML, CSS and vanilla JavaScript");
    assert.equal(o.stack[3].value, "CSS");
    assert.equal(o.stack[1].value, "None (no server needed)");
  });
});

describe("2. the client's technology is kept apart and never silently replaced", () => {
  const html = parseClientTech(["HTML", "CSS", "Vanilla JavaScript"])!;
  it("an enabled, compatible request is shown as the client's choice and is in use", () => {
    const v = view(site({ clientTech: html }));
    assert.equal(v.state, "client-honoured");
    assert.equal(v.client!.status, "honoured");
    assert.equal(v.client!.stated, "HTML, CSS, Vanilla JavaScript");
    assert.equal(v.inUse!.source, "client");
    assert.ok(v.options.every((o) => o.source === "client" && o.sourceLabel === "Client's choice"));
    assert.equal(v.options[0].action, "selected");
  });
  it("a disabled technology is explained and the alternatives ask for confirmation", () => {
    const v = view(site({ clientTech: html }), buildCatalog({ html: { enabled: false } }));
    assert.equal(v.state, "needs-confirmation");
    assert.equal(v.requiresConfirmation, true);
    assert.ok(v.client!.problems.includes("HTML is not currently offered."));
    assert.match(v.client!.confirmation!, /confirm an alternative with the client/);
    assert.ok(v.options.length > 0);
    for (const o of v.options) {
      assert.equal(o.source, "recommended", "an alternative is never labelled as the client's choice");
      assert.equal(o.action, "confirm");
      assert.equal(o.actionLabel, "Client confirmed this");
      assert.ok(!o.appIds.includes("html"));
    }
  });
  it("until the client confirms, the quotation still shows what they asked for", () => {
    const req = site({ clientTech: html });
    assert.equal(suggestStack(req, rates).frontend, "HTML, CSS and vanilla JavaScript");
    const v = view(req, buildCatalog({ html: { enabled: false } }));
    assert.equal(v.inUse!.source, "client");
    assert.equal(v.inUse!.text, "HTML, CSS, Vanilla JavaScript");
  });
  it("a confirmed alternative is labelled as such and the request stays on record", () => {
    const req = site({ clientTech: { ...html, confirmedIds: ["javascript", "nextjs"] } });
    const v = view(req, buildCatalog({ html: { enabled: false } }));
    assert.equal(v.state, "client-confirmed");
    assert.equal(v.inUse!.source, "client-confirmed");
    assert.ok(v.options.every((o) => o.sourceLabel === "Client-confirmed alternative"));
    assert.deepEqual(req.clientTech!.stated, ["HTML", "CSS", "Vanilla JavaScript"]);
    assert.match(suggestStack(req, rates).notes.join(" "), /asked for HTML, CSS, Vanilla JavaScript, which could not be used; they confirmed/);
  });
  it("an unknown technology is reported, not guessed", () => {
    const v = view(site({ clientTech: parseClientTech(["Svelte"]) }));
    assert.equal(v.state, "needs-confirmation");
    assert.ok(v.client!.problems.includes('"Svelte" is not in the technology catalog.'));
  });
});

describe("3. selecting a stack", () => {
  const ids = ["javascript", "nextjs", "nodejs", "postgresql"];
  it("the selected stack is marked in use and labelled as our recommendation", () => {
    const req = shop({ selectedStack: { ids } });
    const v = view(req);
    assert.equal(v.inUse!.source, "recommended");
    const chosen = v.options.find((o) => o.action === "selected");
    assert.ok(chosen, "one option is in use");
    assert.deepEqual([...chosen!.appIds].sort(), [...ids].sort());
    assert.equal(chosen!.actionLabel, "In use");
  });
  it("the quotation, the packages and the cost estimate use the same stack", () => {
    const req = shop({ selectedStack: { ids } });
    const stack = suggestStack(req, rates);
    assert.equal(stack.frontend, "JavaScript and Next.js");
    assert.equal(stack.backend, "Node.js");
    assert.equal(stack.database, "PostgreSQL");
    for (const p of buildProposals(req, TN, rates)) assert.equal(p.quote.stack.backend, "Node.js", p.title);
    assert.equal(estimateCosts({ quote: QUOTE, rates, config: SAMPLE, requirement: req }).technology.source, "selected");
  });
  it("selecting a stack changes no formula: the quote and the Standard and Premium prices are the same", () => {
    const plain = buildProposals(shop(), TN, rates);
    const picked = buildProposals(shop({ selectedStack: { ids } }), TN, rates);
    assert.equal(picked[1].grandTotal, plain[1].grandTotal, "Standard");
    assert.equal(picked[2].grandTotal, plain[2].grandTotal, "Premium");
    assert.equal(buildQuote(shop({ selectedStack: { ids } }), TN, rates).grandTotal, buildQuote(shop(), TN, rates).grandTotal);
  });
  it("Basic is built on the selected stack, not re-platformed to a cheaper backend (so it matches what is approved)", () => {
    const plain = buildProposals(shop(), TN, rates)[0];
    const picked = buildProposals(shop({ selectedStack: { ids } }), TN, rates)[0];
    assert.match(plain.leftOut.join(" "), /^.*Built with/, "without a selection Basic uses the cheaper managed backend");
    assert.equal(picked.quote.stack.backend, "Node.js");
    assert.ok(!picked.leftOut.some((l) => l.startsWith("Built with")));
    assert.ok(picked.grandTotal > plain.grandTotal, "the price follows the stack that was approved");
  });
  it("the client's own choice wins for the layers they specified", () => {
    const req = shop({ clientTech: parseClientTech(["HTML", "CSS", "JavaScript"]), selectedStack: { ids: ["javascript", "nextjs", "nodejs", "postgresql"] } });
    const stack = suggestStack(req, rates);
    assert.equal(stack.frontend, "HTML, CSS and vanilla JavaScript");
    assert.equal(stack.backend, "Node.js", "a layer the client did not specify comes from the selected stack");
  });
  it("a selected stack that no longer works is flagged", () => {
    const v = view(shop({ selectedStack: { ids: ["javascript", "nextjs", "nodejs", "postgresql", "shared-hosting"] } }));
    assert.match(v.warning!, /no longer works/);
    assert.equal(view(shop({ selectedStack: { ids } })).warning, null);
  });
  it("the server keeps only known catalog ids and no key when nothing is selected", () => {
    const parsed = parseRequirement({ ...shop(), selectedStack: { ids: ["nextjs", "cobol", "nextjs"] } }, rates);
    assert.deepEqual(parsed.selectedStack, { ids: ["nextjs"] });
    assert.equal("selectedStack" in parseRequirement({ ...shop(), selectedStack: { ids: ["cobol"] } }, rates), false);
  });
});

describe("4. the approved stack reaches the AI build brief", () => {
  function leadFor(req: Requirement): Lead {
    const proposal = buildProposals(req, TN, rates)[1];
    const quotation = { ...proposal.quote, number: "SQ-2026-0001", tier: "standard", requirement: proposal.requirement, validUntil: "2099-01-01T00:00:00.000Z" } as unknown as Quotation;
    return { id: "l1", stage: "approved", client: { name: "Ravi", email: "", phone: "", company: "BrightWave", gstin: "", state: "Tamil Nadu", address: "" }, requirement: req, quotation, payments: [], workLog: [] } as unknown as Lead;
  }
  it("a stack selected from the recommendations is passed to the builder technology by technology", () => {
    const req = shop({ selectedStack: { ids: ["javascript", "nextjs", "nodejs", "postgresql"] } });
    const brief = buildBrief(leadFor(req), rates);
    assert.deepEqual(brief.frontend, ["JavaScript", "Next.js"]);
    assert.deepEqual(brief.backend, ["Node.js"]);
    assert.deepEqual(brief.database, ["PostgreSQL"]);
    assert.match(brief.description, /Technology \(approved for this project: use exactly this, do not substitute another\)/);
    assert.match(brief.description, /Technology selected for this project: JavaScript, Next.js, Node.js, PostgreSQL/);
  });
  it("the client's HTML, CSS and JavaScript reach the builder whole (it used to be cut to HTML)", () => {
    const brief = buildBrief(leadFor(site({ clientTech: parseClientTech(["HTML", "CSS", "Vanilla JavaScript"]) })), rates);
    assert.deepEqual(brief.frontend, ["HTML", "CSS", "JavaScript"]);
    assert.deepEqual(brief.styling, ["CSS"]);
    assert.deepEqual(brief.backend, []);
    assert.match(brief.description, /requested by the client: use exactly this/);
    assert.ok(!/Next\.js|Tailwind/.test(brief.description + brief.frontend.join() + brief.styling.join()));
  });
  it("a confirmed alternative is what gets built", () => {
    const req = site({ clientTech: { ...parseClientTech(["Vue"])!, confirmedIds: ["javascript", "nextjs"] } });
    assert.deepEqual(buildBrief(leadFor(req), rates).frontend, ["JavaScript", "Next.js"]);
  });
  it("without a chosen stack the builder gets the quotation's stack as before", () => {
    const brief = buildBrief(leadFor(site()), rates);
    assert.deepEqual(brief.frontend, ["Next.js (React)"]);
    assert.deepEqual(brief.styling, ["Tailwind CSS"]);
  });
});

describe("5. internal cost display: unknown is shown as unknown, never as zero", () => {
  it("with nothing configured no cost or profit is shown", () => {
    const { view: v } = costView(emptyCostConfig());
    assert.equal(isCostConfigEmpty(emptyCostConfig()), true);
    assert.equal(v.internal.state, "not-configured");
    assert.match(v.internal.banner!, /not configured yet, so no cost or profit is shown/);
    assert.equal(v.internal.total.value, "Not available yet");
    const profit = v.profit.rows.map((r) => r.value);
    assert.deepEqual(profit.slice(2), ["Not available yet", "Not available yet"]);
    assert.equal(v.profit.viabilityLabel, "Cannot be confirmed yet");
    const text = JSON.stringify([v.internal, v.profit]);
    assert.ok(!text.includes(formatINR(0)), "no misleading zero");
  });
  it("a partly configured studio shows what is known, marked as incomplete", () => {
    const partial = applyCostPatch(SAMPLE, { roleRates: { backend: null } });
    const { view: v } = costView(partial);
    assert.equal(v.internal.state, "incomplete");
    assert.match(v.internal.banner!, /incomplete: \d+ settings? (is|are) missing/);
    assert.match(v.internal.total.value, /^At least ₹/);
    const profit = v.profit.rows.find((r) => r.label === "Gross profit")!;
    assert.match(profit.value, /^Up to ₹/);
    assert.equal(profit.status, "missing");
    assert.match(profit.hint!, /Higher than it will be/);
    assert.ok(v.internal.missing.length > 0);
    const people = v.internal.groups[0].rows.find((r) => r.label === "Backend development");
    assert.match(people!.value, /no hourly cost configured/);
  });
  it("a complete configuration shows the figures, with actual and estimated apart", () => {
    const { view: v } = costView(SAMPLE, { aiUsage: [{ id: "a", provider: "sample", model: "m", actualCostUsd: 2.5 }] });
    assert.equal(v.internal.state, "complete");
    assert.equal(v.internal.banner, null);
    const people = v.internal.groups[0].rows;
    assert.ok(people.some((r) => r.label === "Frontend development" && r.value === `13.8 h × ${formatINR(300)} = ${formatINR(4140)}`));
    assert.equal(people.at(-1)!.value, formatINR(14580));
    assert.equal(v.internal.groups[1].rows[0].status, "actual");
    assert.equal(v.internal.groups[2].rows.find((r) => r.label === "Development server")!.value, formatINR(1000));
    assert.deepEqual(v.internal.split.map((r) => r.label), ["Actual", "Estimated"]);
    assert.equal(v.internal.split[0].value, formatINR(200));
    assert.equal(v.internal.missing.length, 0);
  });
  it("missing configuration is listed so the team knows what to enter", () => {
    const { view: v } = costView(emptyCostConfig(), { aiUsage: undefined });
    assert.ok(v.internal.missing.some((m) => m.includes("No role allocation is configured")));
    assert.ok(v.internal.missing.includes("AI and API usage was not provided."));
    assert.ok(v.internal.missing.includes("Internal infrastructure costs are not configured."));
  });
  it("studio-paid project costs are a separate group", () => {
    const { view: v } = costView(SAMPLE, { recurring: [{ id: "licence", service: "Template licence", category: "other", kind: "one-time", amount: 1500, currency: "INR", necessity: "mandatory", payer: "studio", status: "actual", includeInDeliveryCost: true }] });
    const group = v.internal.groups.find((g) => g.title === "Studio-paid project costs")!;
    assert.deepEqual(group.rows.map((r) => r.label), ["Template licence", "Studio-paid project costs"]);
    assert.equal(group.rows[1].value, formatINR(1500));
  });
});

describe("6. profitability and the client's totals", () => {
  const { view: v, estimate } = costView(SAMPLE, { aiUsage: [] });
  it("revenue excludes GST, and cost is the internal cost only", () => {
    assert.equal(v.profit.rows[0].value, formatINR(23000));
    assert.equal(v.profit.rows[1].value, formatINR(15810)); // 14,580 people + 1,230 infrastructure
    assert.equal(v.profit.rows[2].value, formatINR(7190));
    assert.equal(v.profit.rows[3].value, `${Math.round((7190 / 23000) * 10000) / 100}%`);
    assert.equal(v.profit.viabilityLabel, "Viable");
    assert.match(v.profit.note, /GST and the client's running costs are not part of revenue, cost or profit/);
  });
  it("a loss and a thin margin are shown as warnings", () => {
    const costly = applyCostPatch(SAMPLE, { roleRates: { frontend: 2000, backend: 2000 } });
    const loss = costView(costly).view;
    assert.equal(loss.profit.viabilityLabel, "Not viable");
    assert.equal(loss.profit.tone, "bad");
    assert.ok(loss.profit.warnings.some((w) => w.includes("a loss of")));
    const thin = costView(applyCostPatch(SAMPLE, { minMarginPercent: 80 })).view;
    assert.equal(thin.profit.viabilityLabel, "At risk");
    assert.ok(thin.profit.warnings.some((w) => w.includes("below the minimum target of 80%")));
  });
  it("the client's development cost section is the quotation, unchanged", () => {
    const rows = Object.fromEntries(v.client.rows.map((r) => [r.label, r.value]));
    assert.equal(rows["Development subtotal"], formatINR(23000));
    assert.equal(rows["Taxable value"], formatINR(23000));
    assert.equal(rows["CGST @ 9%"], formatINR(2070));
    assert.equal(rows["SGST @ 9%"], formatINR(2070));
    assert.equal(rows["Grand total (incl. GST)"], formatINR(27140));
    assert.equal(estimate.clientDevelopment.total, 27140);
  });
  it("GST totals are still computed by the existing pricing", () => {
    const q = buildQuote(site(), TN, rates);
    const rows = Object.fromEntries(costView(SAMPLE, { quote: q }).view.client.rows.map((r) => [r.label, r.value]));
    assert.equal(rows["Grand total (incl. GST)"], formatINR(q.grandTotal));
    assert.equal(q.gst.total, Math.round(q.taxable * 0.18 * 100) / 100);
  });
  it("the client section never contains internal figures", () => {
    const clientText = JSON.stringify(v.client);
    for (const word of ["profit", "margin", "hourly", "internal", "AI", "infrastructure"]) assert.ok(!clientText.includes(word), word);
  });
});

describe("7. client running costs stay separate", () => {
  it("each item shows provider, amount, billing, need, who pays and whether it is actual or estimated; unknown stays unknown", () => {
    const { view: v } = costView(SAMPLE, { requirement: shop() });
    const domain = v.running.rows.find((r) => r.id === "domain")!;
    assert.deepEqual([domain.provider, domain.amount, domain.unknown, domain.necessity, domain.payer, domain.status], ["Not set", "Unknown", true, "Mandatory", "Client pays", "Estimated"]);
    assert.ok(v.running.rows.every((r) => r.unknown), "no amount is invented");
    assert.deepEqual(v.running.totals, [{ label: "Total", value: "No amounts known yet", status: "info" }]);
    const gateway = v.running.rows.find((r) => r.id === "payment-gateway")!;
    assert.equal(gateway.amount, "Unknown");
  });
  it("the studio's reference prices fill in only what it knows", () => {
    const config = applyCostPatch(SAMPLE, {
      runningCosts: {
        "domain-renewal": { kind: "recurring", provider: "Sample registrar", amount: 800, frequency: "annual", necessity: "mandatory", payer: "client", status: "estimated" },
        vps: { kind: "recurring", amount: 1000, frequency: "monthly", necessity: "mandatory", payer: "client", status: "actual" },
        "payment-gateway": { kind: "recurring", amount: 2, amountType: "percent-of-transaction", necessity: "mandatory", payer: "client", status: "estimated" },
        "cloud-hosting": { kind: "recurring", amount: null, necessity: "mandatory", payer: "client", status: "estimated" },
      },
    });
    const { view: v } = costView(config, { requirement: shop(), stackIds: ["javascript", "nextjs", "nodejs", "postgresql", "vps"] });
    const byId = Object.fromEntries(v.running.rows.map((r) => [r.id, r]));
    assert.equal(byId.domain.amount, formatINR(800));
    assert.equal(byId.domain.provider, "Sample registrar");
    assert.equal(byId.domain.frequency, "Annual");
    assert.equal(byId["hosting-vps"].amount, formatINR(1000));
    assert.equal(byId["hosting-vps"].status, "Actual");
    assert.equal(byId["payment-gateway"].amount, "2% of each transaction");
    assert.match(byId["payment-gateway"].note!, /percentage of each transaction/);
    assert.equal(byId.maintenance.unknown, true);
    assert.deepEqual(v.running.totals.map((r) => r.label), ["Billed monthly", "Billed annually", "Recurring per year"]);
    assert.equal(v.running.totals.at(-1)!.value, formatINR(1000 * 12 + 800));
  });
  it("running costs never change the development total, the internal cost or the profit", () => {
    const base = costView(SAMPLE, { requirement: shop() });
    const withDefaults = costView(applyCostPatch(SAMPLE, { runningCosts: { "domain-renewal": { kind: "recurring", amount: 800, frequency: "annual", necessity: "mandatory", payer: "client", status: "estimated" } } }), { requirement: shop() });
    assert.deepEqual(withDefaults.view.client, base.view.client);
    assert.deepEqual(withDefaults.view.internal, base.view.internal);
    assert.deepEqual(withDefaults.view.profit, base.view.profit);
  });
  it("studio-paid recurring costs are shown separately and are not in the profit", () => {
    const stack = ["html", "css", "javascript", "shared-hosting"];
    const factors = applyCostPatch(SAMPLE, { techFactors: { html: 1, css: 1, javascript: 1, "shared-hosting": 1 } });
    const config = applyCostPatch(factors, { runningCosts: { "shared-hosting": { kind: "recurring", amount: 300, frequency: "monthly", necessity: "mandatory", payer: "studio", status: "estimated" } } });
    const { view: v } = costView(config, { requirement: site(), stackIds: stack });
    assert.equal(v.running.rows.find((r) => r.id === "hosting-shared-hosting")!.payer, "Studio pays");
    assert.deepEqual(v.running.studioPays, [{ label: "Billed monthly", value: formatINR(300) }, { label: "Recurring per year", value: formatINR(3600), strong: true }]);
    assert.deepEqual(v.running.totals, [{ label: "Total", value: "No amounts known yet", status: "info" }]);
    assert.equal(v.profit.rows[2].value, costView(factors, { requirement: site(), stackIds: stack }).view.profit.rows[2].value);
  });
  it("the default suggestions are validated", () => {
    assert.deepEqual(costConfigPatchProblems({ runningCosts: { vps: { kind: "recurring", amount: null, necessity: "mandatory", payer: "client", status: "estimated" } } }), []);
    const problems = costConfigPatchProblems({ runningCosts: { wizard: { kind: "recurring", amount: 1, necessity: "mandatory", payer: "client", status: "estimated" }, vps: { kind: "recurring", amount: 100, necessity: "mandatory", payer: "client", status: "estimated" }, "paid-api": { kind: "sometimes", amount: 1 } } });
    assert.equal(problems.length, 3, problems.join(" | "));
    assert.deepEqual(parseCostConfig({ runningCosts: { vps: "cheap" } }), emptyCostConfig());
    assert.equal(applyCostPatch(applyCostPatch(SAMPLE, { runningCosts: { vps: { kind: "one-time", amount: 5, necessity: "optional", payer: "client", status: "estimated" } } }), { runningCosts: { vps: null } }).runningCosts.vps, undefined);
  });
});

describe("8. the settings screen starts empty and says what is missing", () => {
  it("nothing is pre-filled", () => {
    const c = emptyCostConfig();
    assert.ok(Object.values(c.roleRates).every((v) => v === null));
    assert.deepEqual([c.usdToInr, c.minMarginPercent, c.infra], [null, null, null]);
    assert.deepEqual([c.aiPricing, c.techFactors, c.runningCosts], [{}, {}, {}]);
  });
  it("the checklist lists what is still needed, and updates as it is filled in", () => {
    const empty = costConfigReadiness(emptyCostConfig());
    const state = (items: typeof empty, key: string) => items.find((i) => i.key === key)!.state;
    for (const key of ["roleRates", "allocation", "techFactors", "usdToInr", "infra", "minMargin"]) assert.equal(state(empty, key), "missing", key);
    for (const key of ["uplifts", "aiPricing", "runningCosts"]) assert.equal(state(empty, key), "optional", key);
    const done = costConfigReadiness(applyCostPatch(SAMPLE, { techFactors: { nextjs: 1 }, aiPricing: { m: { inputPerMTok: 1, outputPerMTok: 2 } } }));
    for (const key of ["roleRates", "allocation", "techFactors", "usdToInr", "infra", "minMargin", "aiPricing"]) assert.equal(state(done, key), "done", key);
    assert.equal(costConfigReadiness(applyCostPatch(SAMPLE, { infra: [] })).find((i) => i.key === "infra")!.detail, "Set to none");
  });
  it("the screen uses the existing validated API and holds no built-in prices", () => {
    const source = readFileSync(path.resolve("src/components/business/cost-settings.tsx"), "utf8");
    assert.ok(source.includes("/api/business/cost-config"));
    assert.ok(source.includes("costConfigReadiness"));
    assert.ok(!/defaultValue=|useState<number>\(\d|₹\s?\d{2,}/.test(source), "no number is hard-coded as a rate");
  });
});

describe("9. the public quotation never exposes internal costs", () => {
  const req = shop({ selectedStack: { ids: ["javascript", "nextjs", "nodejs", "postgresql"] }, insights: { confirmed: ["x"], assumptions: [], questions: [] } });
  const proposal = buildProposals(req, TN, rates)[1];
  const quotation = { ...proposal.quote, id: "q1", number: "SQ-2026-0001", leadId: "l1", createdAt: "2026-01-01T00:00:00.000Z", validUntil: "2099-01-01T00:00:00.000Z", tier: "standard", requirement: proposal.requirement, client: { name: "Ravi" }, business: rates.business, proposals: [], budgetCheck: { status: "over" } } as unknown as Quotation;
  const lead = { id: "l1", stage: "quoted", client: { name: "Ravi", email: "", phone: "", company: "", gstin: "", state: "Tamil Nadu", address: "" }, requirement: req, quotation, payments: [], workLog: [] } as unknown as Lead;
  const pub = clientView(lead, rates.business);
  const text = JSON.stringify(pub);
  it("the client's view has no cost, margin, rate or profitability data", () => {
    assert.ok(pub);
    for (const word of ["roleRates", "allocation", "techFactors", "aiPricing", "usdToInr", "internal", "grossProfit", "grossMargin", "minMargin", "runningCosts", "budgetCheck", "insights"]) assert.ok(!text.includes(word), word);
  });
  it("it still shows what the client needs: the price, the packages and the technology", () => {
    assert.equal(pub!.quotation.grandTotal, proposal.grandTotal);
    assert.ok(text.includes("Node.js"));
  });
  it("nothing in the public routes or pages can reach the cost code", () => {
    const publicFiles = ["src/lib/business/client-view.ts", "src/app/api/client/[token]/route.ts", "src/app/api/client/[token]/document/route.ts", "src/app/q/[token]/page.tsx", "src/app/q/[token]/client-quotation.tsx", "src/components/business/quotation-document.tsx", "src/components/business/comparison-table.tsx"];
    for (const file of publicFiles) {
      const source = readFileSync(path.resolve(file), "utf8");
      assert.ok(!/cost-(estimate|internal|profit|config|view|panel|settings|recurring|viability)|getCostConfig|saveCostConfig/.test(source), `${file} must not use the cost code`);
    }
  });
  it("the cost routes are under the team API, not the public one", () => {
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
    const costRoutes = walk(path.resolve("src/app/api")).filter((f) => /cost/.test(f)).map((f) => path.relative(path.resolve("src/app/api"), f).replace(/\\/g, "/"));
    assert.deepEqual(costRoutes.sort(), ["business/cost-config/route.ts", "business/leads/[id]/costs/route.ts"]);
    const publicApi = walk(path.resolve("src/app/api/client")).map((f) => readFileSync(f, "utf8")).join("\n");
    assert.ok(!/getCostConfig|estimateCosts/.test(publicApi));
  });
  it("the internal cost panel is labelled internal and kept out of the printed quotation", () => {
    const panel = readFileSync(path.resolve("src/components/business/cost-panel.tsx"), "utf8");
    assert.ok(panel.includes("Internal only, never shown to the client"));
    const detail = readFileSync(path.resolve("src/components/studio/clients.tsx"), "utf8");
    assert.match(detail, /<div className="no-print"><LeadCostPanel/);
    const wizard = readFileSync(path.resolve("src/components/business/requirement-wizard.tsx"), "utf8");
    assert.ok(wizard.includes("internal view, never shown to the client"));
  });
});

describe("10. the workflow is connected end to end", () => {
  const read = (f: string) => readFileSync(path.resolve(f), "utf8");
  it("the wizard offers the technology recommendation, then the packages, then the internal view", () => {
    const wizard = read("src/components/business/requirement-wizard.tsx");
    const tech = wizard.indexOf("<TechnologyRecommendations");
    const packages = wizard.indexOf("<PackageDetails");
    const costs = wizard.indexOf("<WizardCostPanel");
    assert.ok(tech > 0 && packages > tech && costs > packages, "technology, then packages, then costs");
    assert.ok(wizard.includes("selectedStack: { ids }"));
    assert.ok(wizard.includes("confirmedIds: ids"));
  });
  it("a saved quotation shows the costs, and Business & pricing has the cost settings", () => {
    assert.ok(read("src/components/studio/clients.tsx").includes("<LeadCostPanel"));
    assert.ok(read("src/components/studio/pricing-settings.tsx").includes("<CostSettings />"));
  });
  it("generation goes through the execution runner, which builds the brief from the approved quotation for both modes", () => {
    const runner = read("src/lib/execution/runner.ts");
    assert.ok(runner.includes("buildBrief(lead, getRateCard())"));
    assert.ok(runner.includes("...brief"), "the API task carries the approved technology lists");
    assert.ok(runner.includes("buildLocalPrompt(brief, content,"), "the local run is told to use exactly the approved technology");
    assert.ok(!read("src/app/api/business/leads/[id]/build/route.ts").includes("streamAgentRun"), "the old direct route no longer starts a run");
  });
});

describe("11. the Review page: internal sections fold away and show one clear status", () => {
  const read = (f: string) => readFileSync(path.resolve(f), "utf8");
  const AI = { aiUsage: [{ id: "a", provider: "sample", model: "m", actualCostUsd: 2.5 }] };

  it("nothing is configured: one 'Not configured' status, no figures, no profit", () => {
    const empty = emptyCostConfig();
    const { view } = costView(empty, { aiUsage: undefined });
    const status = configStatus(view.internal.state, costConfigReadiness(empty), view.internal.missing.length);
    assert.equal(status.state, "not-configured");
    assert.equal(status.label, "Not configured");
    assert.ok(status.needed.length > 0 && status.doneCount < status.requiredCount);
    assert.ok(status.needed.every((n) => n.state === "missing"), "only required settings are listed as needed");
    assert.equal(internalSummary(view), null, "no headline figures");
  });
  it("partly configured: 'Setup incomplete', and still no headline figures that could mislead", () => {
    const partial = applyCostPatch(SAMPLE, { roleRates: { backend: null } });
    const { view } = costView(partial);
    const status = configStatus(view.internal.state, costConfigReadiness(partial), view.internal.missing.length);
    assert.equal(status.label, "Setup incomplete");
    assert.match(status.detail, /still needed for this quotation/);
    assert.ok(status.needed.some((n) => n.key === "roleRates"));
    assert.equal(internalSummary(view), null);
  });
  it("complete: the real internal cost, gross profit and gross margin come straight from the cost engine", () => {
    const { view, estimate } = costView(SAMPLE, AI);
    const status = configStatus(view.internal.state, costConfigReadiness(SAMPLE), view.internal.missing.length);
    assert.deepEqual([status.label, status.needed.length], ["Ready", 0]);
    const s = internalSummary(view)!;
    assert.equal(s.cost, formatINR(estimate.internal.total));
    assert.equal(s.grossProfit, formatINR(estimate.profit.grossProfit));
    assert.equal(s.grossMargin, `${estimate.profit.grossMarginPercent}%`);
    assert.equal(s.viabilityLabel, view.profit.viabilityLabel);
    assert.ok(!/Up to|At least/.test(`${s.cost}${s.grossProfit}${s.grossMargin}`), "final figures, not provisional ones");
  });
  it("the calculation outputs are exactly what they were: the view only presents them", () => {
    const { view, estimate } = costView(SAMPLE, AI);
    assert.equal(view.internal.total.value, formatINR(estimate.internal.total));
    assert.equal(view.profit.rows.find((r) => r.label === "Development revenue excluding GST")!.value, formatINR(estimate.profit.revenue));
    assert.equal(view.client.rows.at(-1)!.value, formatINR(estimate.clientDevelopment.total));
  });
  it("the panel keeps A and D open, folds B and C unless complete, and shows the status instead of many 'Missing' rows", () => {
    const panel = read("src/components/business/cost-panel.tsx");
    assert.ok(panel.includes("A. Client development cost") && panel.includes("D. Client running costs"));
    assert.match(panel, /title="B\. Internal studio cost"[\s\S]*?open=\{complete\}[\s\S]*?testId="internal-cost"/);
    assert.match(panel, /title="C\. Profitability"[\s\S]*?open=\{complete\}[\s\S]*?testId="profitability"/);
    assert.ok(panel.includes("<details") && panel.includes("Internal only"));
    assert.ok(panel.includes("SetupStatus") && panel.includes("configStatus(") && panel.includes("internalSummary("));
    assert.ok(panel.includes("Partial figures (not the final cost)"), "provisional numbers are tucked away and labelled");
  });
  it("it reuses the existing engines and adds no calculation of its own", () => {
    const panel = read("src/components/business/cost-panel.tsx");
    assert.ok(panel.includes("buildCostView(") && panel.includes("estimateCosts("));
    assert.ok(!/\*\s*0\.\d|\/\s*100|grossProfit\s*=|margin\s*=/.test(panel), "no arithmetic on money in the component");
  });
  it("the public quotation and its API never touch the internal view or the cost panel", () => {
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
    const publicFiles = [...walk(path.resolve("src/app/api/client")), ...walk(path.resolve("src/app/q")), path.resolve("src/lib/business/client-view.ts"), path.resolve("src/components/business/quotation-document.tsx")];
    for (const f of publicFiles) assert.ok(!/cost-view|cost-panel|cost-estimate|cost-config|CostPanel|internalSummary|grossMargin|grossProfit/.test(readFileSync(f, "utf8")), `${path.relative(process.cwd(), f)} must not use internal cost code`);
  });
});
