// Pricing, page counting, budget and persistence tests for the business workflow.
// Run: npm test   (Node 24 runs TypeScript directly; tests/register.mjs resolves the imports)
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { checkBudget } from "@/lib/business/budget";
import { buildQuote } from "@/lib/business/pricing";
import { buildProposals } from "@/lib/business/proposals";
import { DEFAULT_RATE_CARD } from "@/lib/business/rate-card";
import { applyPagePlan, autoComplexity, billablePages, isSharedComponent, moveToPhase2, restorePage, restoreFromPhase2, splitPages, supportingPages } from "@/lib/business/scope";
import type { ModuleId, RateCard, Requirement } from "@/lib/business/types";
import { parseRequirement } from "@/lib/business/validate";

const rates: RateCard = DEFAULT_RATE_CARD;
const TN = { state: "Tamil Nadu" };
const SIX = ["Home", "About Us", "Services", "Products / Portfolio", "Gallery", "Contact Us"];

function req(pages: string[], modules: ModuleId[] = [], extra: Partial<Requirement> = {}): Requirement {
  return {
    title: "Informational website",
    summary: "Six page responsive informational website built with HTML, CSS and JavaScript.",
    scope: "full",
    existingProject: "",
    version: "",
    projectType: "business-website",
    complexity: "basic",
    pages,
    modules,
    design: "ai",
    references: "",
    domain: { needed: false, choice: "self", name: "", tld: ".com", years: 1 },
    hosting: { needed: false, choice: "self", plan: "static", years: 1 },
    deadlineWeeks: 0,
    budget: 0,
    ...extra,
  };
}
const pageLines = (q: ReturnType<typeof buildQuote>) => q.items.filter((i) => i.description.startsWith("Page: "));

describe("1. six-page website with a 404 page and shared header / footer", () => {
  // As the AI used to return it: components and the 404 page mixed into the page list.
  const parsed = parseRequirement(req([...SIX, "404 Not Found", "Header", "Footer", "Mobile navigation"]), rates);
  const quote = buildQuote(parsed, TN, rates);

  it("bills 6 pages, keeps 1 supporting page, adds no pages for shared components", () => {
    assert.deepEqual(billablePages(parsed), SIX);
    assert.deepEqual(supportingPages(parsed), ["404 Not Found"]);
    assert.deepEqual(parsed.sharedComponents, ["Header", "Footer", "Mobile navigation"]);
    assert.deepEqual(quote.pageCount, { billable: 6, supporting: 1 });
    assert.equal(pageLines(quote).length, 6);
    assert.ok(!quote.items.some((i) => /404|Header|Footer|navigation/.test(i.description)));
  });

  it("does not add legal pages the client did not ask for", () => {
    assert.ok(!parsed.pages.some((p) => /privacy|terms/i.test(p)));
  });

  it("regression: the old 9-page / ₹19,647 estimate is gone (no auto discount)", () => {
    const proposals = buildProposals({ ...parsed, modules: ["contact-form", "seo-setup"], budget: 10000 }, TN, rates);
    for (const p of proposals) {
      assert.equal(p.pages.length, 6, `${p.tier} pages`);
      assert.equal(p.quote.discount, 0, `${p.tier} discount`);
    }
    assert.notEqual(proposals[0].grandTotal, 19647);
  });
});

describe("2. eight-page website", () => {
  it("bills 8 pages and keeps 404 as supporting", () => {
    const pages = [...SIX, "Testimonials", "FAQ", "404 Not Found"];
    const r = req(pages);
    const quote = buildQuote(r, TN, rates);
    assert.equal(billablePages(r).length, 8);
    assert.deepEqual(quote.pageCount, { billable: 8, supporting: 1 });
    assert.equal(pageLines(quote).length, 8);
  });
});

describe("3. optional feature selection", () => {
  const base = req(SIX, ["contact-form", "gallery-preview"]);
  const withMaps = { ...base, modules: [...base.modules, "google-maps" as ModuleId] };
  const q1 = buildQuote(base, TN, rates);
  const q2 = buildQuote(withMaps, TN, rates);

  it("page count stays 6 whatever features are selected", () => {
    assert.equal(q1.pageCount?.billable, 6);
    assert.equal(q2.pageCount?.billable, 6);
  });

  it("charges each feature exactly once, only when selected", () => {
    const maps = rates.modules["google-maps"].label;
    assert.equal(q1.items.filter((i) => i.description === maps).length, 0);
    assert.equal(q2.items.filter((i) => i.description === maps).length, 1);
    const descriptions = q2.items.map((i) => i.description);
    assert.equal(new Set(descriptions).size, descriptions.length, "no duplicate lines");
    const mapsLine = q2.items.find((i) => i.description === maps)!;
    assert.equal(q2.subtotal - q1.subtotal, mapsLine.amount);
  });

  it("splits shared components from pages", () => {
    assert.ok(isSharedComponent("Header & Footer"));
    assert.ok(isSharedComponent("Reusable cards"));
    assert.ok(!isSharedComponent("Products / Portfolio"));
    assert.deepEqual(splitPages(["Home", "Navigation menu", "Contact Us"]), { pages: ["Home", "Contact Us"], components: ["Navigation menu"] });
  });
});

describe("4. budget exceeded", () => {
  const r = req(SIX, ["contact-form", "gallery-preview", "google-maps", "blog"], { budget: 10000, mustHave: ["contact-form"], complexity: "standard" });
  const quote = buildQuote(r, TN, rates);
  const check = checkBudget(r, quote, TN, rates);

  it("shows the actual cost and the difference, never forces the price to the budget", () => {
    assert.ok(quote.grandTotal > 10000);
    assert.equal(quote.discount, 0);
    assert.equal(check.total, quote.grandTotal);
    assert.equal(check.difference, 10000 - quote.grandTotal);
    assert.ok(check.status === "over" || check.status === "scope-adjustment");
    assert.ok(check.contributors.length > 0 && check.contributors[0].amount >= check.contributors.at(-1)!.amount);
  });

  it("suggests only optional features for Phase 2 and removes nothing by itself", () => {
    assert.ok(check.suggestions.length > 0);
    assert.ok(!check.suggestions.some((s) => s.module === "contact-form"), "must-have never suggested");
    assert.deepEqual(r.modules, ["contact-form", "gallery-preview", "google-maps", "blog"]);
  });

  it("reports within / near budget", () => {
    const small = req(SIX, [], { budget: 1_000_000 });
    assert.equal(checkBudget(small, buildQuote(small, TN, rates), TN, rates).status, "within");
    const total = buildQuote(small, TN, rates).grandTotal;
    const near = { ...small, budget: total + 1 };
    assert.equal(checkBudget(near, buildQuote(near, TN, rates), TN, rates).status, "near");
  });
});

describe("4b. low budget: what the budget can build (15 pages for ₹10,000)", () => {
  const FIFTEEN = ["Home", "About Us", "Services", "Products", "Gallery", "Contact Us", "Blog", "FAQ", "Testimonials", "Careers", "Team", "Pricing", "Clients", "Awards", "News"];
  // A lower rate, so the budget covers a few pages (the sample ₹500/hour covers about one).
  const card: RateCard = { ...rates, hourlyRate: 250 };
  const r = req(FIFTEEN, ["contact-form", "gallery-preview"], { budget: 10000 });
  const proposals = buildProposals(r, TN, card);
  const basic = proposals[0];
  const check = checkBudget(basic.requirement, basic.quote, TN, card, proposals);
  const plan = check.pagePlan!;

  it("suggests how many pages fit, with the contact form, within the budget", () => {
    assert.ok(plan, "plan given");
    assert.ok(plan.pages.length >= 1 && plan.pages.length < 15);
    assert.ok(plan.minPages <= plan.pages.length && plan.pages.length <= plan.maxPages);
    assert.ok(plan.total <= 10000);
    assert.equal(plan.contactForm, true);
    assert.equal(plan.pages[0], "Home");
    assert.equal(plan.pages[1], "Contact Us", "contact page comes right after Home");
    assert.equal(plan.pages.length + plan.phase2Pages.length, 15);
  });

  it("one more page would go over the budget", () => {
    const next = { ...basic.requirement, pages: FIFTEEN.filter((p) => plan.pages.includes(p) || p === plan.phase2Pages[0]) };
    assert.ok(buildQuote(next, TN, card).grandTotal > 10000);
  });

  it("applying the plan keeps every page on record and the Basic package fits", () => {
    const applied = applyPagePlan(r, plan);
    assert.deepEqual(new Set([...applied.pages, ...(applied.deferredPages ?? [])]), new Set(FIFTEEN));
    assert.ok(applied.mustHave?.includes("contact-form"));
    const after = buildProposals(applied, TN, card);
    assert.equal(after[0].grandTotal, plan.total);
    assert.ok(after[0].grandTotal <= 10000);
    assert.ok(buildQuote(applied, TN, card).deferred?.modules.some((m) => m.endsWith(" page")), "Phase 2 pages listed");
    assert.equal(restorePage(applied, plan.phase2Pages[0]).pages.length, plan.pages.length + 1);
  });

  it("no plan when every requested page fits", () => {
    const rich = { ...r, budget: 10_000_000 };
    const p = buildProposals(rich, TN, card);
    assert.equal(checkBudget(p[0].requirement, p[0].quote, TN, card, p).pagePlan, undefined);
  });

  it("₹8,000 for 6 pages at ₹500/hour: falls back to a compact Home page instead of 'nothing fits'", () => {
    const six = req(SIX, ["whatsapp", "google-maps"], { budget: 8000 });
    const p = buildProposals(six, TN, rates);
    const c = checkBudget(p[0].requirement, p[0].quote, TN, rates, p).pagePlan!;
    assert.deepEqual(c.pages, ["Home"]);
    assert.ok(c.total <= 8000 && c.sections?.Home === 2);
    assert.ok(c.minimumTotal <= 8000, "the minimum price and the suggestion agree");
    const after = buildProposals(applyPagePlan(six, c), TN, rates)[0];
    assert.equal(after.grandTotal, c.total, "applying the plan gives the suggested price");
  });

  it("says the minimum price when not even one page fits", () => {
    const tiny = { ...r, budget: 1000 };
    const p = buildProposals(tiny, TN, card);
    const c = checkBudget(p[0].requirement, p[0].quote, TN, card, p).pagePlan!;
    assert.equal(c.pages.length, 0);
    assert.ok(c.minimumTotal > 1000);
  });
});

describe("automatic complexity (no manual choice)", () => {
  const c = (type: Requirement["projectType"], modules: ModuleId[]) => autoComplexity({ projectType: type, modules }, rates);
  it("follows the project type and features", () => {
    assert.equal(c("business-website", ["contact-form", "gallery-preview"]), "basic");
    assert.equal(c("business-website", ["auth"]), "standard");
    assert.equal(c("cms-website", ["admin-panel"]), "standard");
    assert.equal(c("ecommerce", ["payments", "auth", "admin-panel", "search", "notifications"]), "advanced");
    assert.equal(c("business-website", ["multilingual", "booking"]), "advanced");
  });
  it("the server ignores a hand-picked complexity", () => {
    assert.equal(parseRequirement(req(SIX, ["contact-form"], { complexity: "advanced" }), rates).complexity, "basic");
  });
  it("keeps the 'stay within budget' choice", () => {
    assert.equal(parseRequirement(req(SIX, [], { budget: 10000, budgetStrict: true }), rates).budgetStrict, true);
    assert.equal(parseRequirement(req(SIX, [], { budget: 10000 }), rates).budgetStrict, false);
  });
});

describe("other external services", () => {
  it("domain and hosting are never listed twice as 'other' services", () => {
    const q = buildQuote(req(SIX, [], { externalServices: ["Business email", "Domain renewal", "Hosting upgrade", "SSL certificate"] }), TN, rates);
    assert.deepEqual(q.services?.others, ["Business email", "SSL certificate"]);
  });
});

describe("5. recalculation after moving a feature to Phase 2", () => {
  const r = req(SIX, ["contact-form", "gallery-preview", "google-maps"], { mustHave: ["contact-form"] });
  const basic = buildProposals(r, TN, rates).find((p) => p.tier === "basic")!;
  const moved = moveToPhase2(r, "gallery-preview");

  it("keeps the 6 pages and the confirmed requirements", () => {
    assert.equal(billablePages(moved).length, 6);
    assert.deepEqual(moved.mustHave, ["contact-form"]);
    assert.deepEqual(moved.deferredModules, ["gallery-preview"]);
    assert.ok(basic.requirement.modules.includes("contact-form"), "must-have stays in Basic");
    assert.equal(basic.pages.length, 6);
  });

  it("excludes only that feature's cost and lists it as Phase 2", () => {
    const before = buildQuote(r, TN, rates);
    const afterMove = buildQuote(moved, TN, rates);
    const line = before.items.find((i) => i.description === rates.modules["gallery-preview"].label)!;
    assert.equal(before.subtotal - afterMove.subtotal, line.amount);
    assert.deepEqual(afterMove.deferred?.modules, [rates.modules["gallery-preview"].label]);
  });

  it("must-have features cannot move, and Phase 2 features can be added back", () => {
    assert.equal(moveToPhase2(r, "contact-form"), r);
    assert.equal(buildQuote(restoreFromPhase2(moved, "gallery-preview"), TN, rates).grandTotal, buildQuote(r, TN, rates).grandTotal);
  });

  it("no package contains a Phase 2 feature", () => {
    for (const p of buildProposals(moved, TN, rates)) assert.ok(!p.requirement.modules.includes("gallery-preview"), p.tier);
  });
});

describe("6. GST and payment calculation", () => {
  const r = req(SIX, ["contact-form"]);
  for (const [label, client, card] of [
    ["same state (CGST + SGST)", TN, rates],
    ["other state (IGST)", { state: "Karnataka" }, rates],
    ["configured 12% GST", TN, { ...rates, gstRate: 12 }],
    ["export (zero-rated)", { state: "Outside India" }, rates],
  ] as const) {
    it(label, () => {
      const q = buildQuote(r, client, card, 500);
      assert.equal(q.taxable, q.subtotal - 500);
      const rate = client.state === "Outside India" ? 0 : card.gstRate;
      assert.ok(Math.abs(q.gst.total - (q.taxable * rate) / 100) <= 0.01);
      assert.ok(Math.abs(q.gst.cgst + q.gst.sgst + q.gst.igst - q.gst.total) <= 0.01);
      assert.equal(q.grandTotal, Math.round(q.taxable + q.gst.total));
      assert.equal(q.schedule.reduce((s, x) => s + x.amount, 0), q.grandTotal, "advance + balance = grand total");
      assert.equal(q.schedule[0].amount, Math.round((q.grandTotal * card.advancePercent) / 100));
    });
  }
});

describe("7. persistence", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "silpi-test-"));
  process.env.SILPI_DB_PATH = path.join(dir, "test.db");
  after(() => {
    // Windows keeps an open SQLite file locked: close the cached connection first.
    const cached = globalThis as unknown as { silpiDb?: { close(): void } };
    cached.silpiDb?.close();
    delete cached.silpiDb;
    rmSync(dir, { recursive: true, force: true });
  });

  it("a saved quotation reopens with the same pages, features, prices and budget", async () => {
    const store = await import("@/lib/business/store");
    const client = { name: "Test", email: "t@example.com", phone: "9876543210", company: "", gstin: "", state: "Tamil Nadu", address: "" };
    const requirement = parseRequirement(
      { ...req([...SIX, "404 Not Found", "Header"], ["contact-form", "gallery-preview", "google-maps"], { budget: 10000, mustHave: ["contact-form"] }), deferredModules: ["google-maps"], modules: ["contact-form", "gallery-preview"] },
      store.getRateCard(),
    );
    const lead = store.createLead(client, requirement, "basic");
    const q = lead.quotation!;
    assert.equal(q.pageCount?.billable, 6);
    assert.equal(q.pageCount?.supporting, 1);
    assert.equal(q.discount, 0);
    assert.ok(q.budgetCheck && q.budgetCheck.budget === 10000 && q.budgetCheck.total === q.grandTotal);

    const reopened = store.getLead(lead.id)!;
    assert.deepEqual(reopened.quotation, q, "quotation unchanged on reopen");
    assert.deepEqual(reopened.requirement.deferredModules, ["google-maps"], "Phase 2 kept");
    assert.deepEqual(reopened.requirement.mustHave, ["contact-form"]);
    assert.deepEqual(reopened.requirement.sharedComponents, ["Header"]);
    assert.ok(store.listLeads().some((l) => l.id === lead.id && l.quotation?.grandTotal === q.grandTotal));

    // The build brief for the agent matches the quotation: 6 pages, 404 as supporting, Phase 2 not built.
    const { buildBrief } = await import("@/lib/business/brief");
    const brief: string[] = buildBrief(reopened, store.getRateCard()).description.split("\n");
    const section = (title: string) => {
      const start = brief.findIndex((l) => l.startsWith(`## ${title}`));
      const end = brief.findIndex((l, i) => i > start && l.startsWith("## "));
      return brief.slice(start + 1, end < 0 ? undefined : end).filter((l) => l.startsWith("- "));
    };
    assert.equal(section("Pages").length, 6);
    assert.deepEqual(section("Supporting pages"), ["- 404 Not Found"]);
    assert.ok(section("Do NOT build").some((l) => l.includes(store.getRateCard().modules["google-maps"].label)));
  });
});

describe("technology choice updates the estimate", () => {
  const base = () => req(SIX, ["contact-form", "auth"], { projectType: "web-app", complexity: "standard" });
  it("a different frontend or backend changes hours, labels and the total", () => {
    const std = buildQuote(base(), TN, rates);
    const angular = buildQuote({ ...base(), tech: { frontend: "angular" } }, TN, rates);
    const supabase = buildQuote({ ...base(), tech: { backend: "supabase" } }, TN, rates);
    assert.ok(angular.grandTotal > std.grandTotal);
    assert.equal(angular.stack.frontend, "Angular");
    assert.ok(supabase.grandTotal < std.grandTotal);
    assert.match(supabase.stack.backend, /Supabase/);
  });
  it("unknown technology ids are dropped and module work keeps the existing stack", () => {
    assert.deepEqual(parseRequirement({ ...base(), tech: { frontend: "cobol", database: "mysql" } }, rates).tech, { database: "mysql" });
    const std = buildQuote(req(SIX, [], { scope: "module", existingProject: "X" }), TN, rates);
    const picked = buildQuote(req(SIX, [], { scope: "module", existingProject: "X", tech: { frontend: "angular" } }), TN, rates);
    assert.equal(picked.grandTotal, std.grandTotal);
  });
});

describe("hours tracker", () => {
  it("compares logged hours with the quotation, line by line", async () => {
    const { hoursReport, accuracy, EXTRA_WORK } = await import("@/lib/business/hours");
    const quote = buildQuote(req(["Home", "Contact Us"], ["contact-form"]), TN, rates);
    const page = quote.items.find((i) => i.description === "Page: Home")!;
    const log = [
      { id: "1", item: page.description, hours: page.qty + 2, note: "", loggedOn: "2026-11-20", recordedAt: "" },
      { id: "2", item: "Client changes", hours: 3, note: "", loggedOn: "2026-11-21", recordedAt: "" },
    ];
    const r = hoursReport(quote, log);
    assert.equal(r.actual, page.qty + 5);
    assert.equal(r.lines.find((l) => l.item === page.description)!.actual, page.qty + 2);
    assert.equal(r.lines.find((l) => l.item === EXTRA_WORK)!.actual, 3);
    assert.equal(r.variancePct, Math.round(((r.actual - r.estimated) / r.estimated) * 100));
    const a = accuracy([{ quotation: quote as never, workLog: log }]);
    assert.equal(a.projects, 1);
    assert.ok(a.ratio > 0);
  });
});
