// Regression tests for the document-vs-quotation mismatch:
// pages and features are never cut silently, the client's technology is kept and
// respected end to end (stack, packages, build brief, recommendation), a demo form is
// not a working form, and the Standard package keeps its Home sections.
// Run: npm test
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { checkBudget } from "@/lib/business/budget";
import { buildBrief } from "@/lib/business/brief";
import { buildQuote, suggestStack } from "@/lib/business/pricing";
import { buildProposals } from "@/lib/business/proposals";
import { DEFAULT_RATE_CARD } from "@/lib/business/rate-card";
import { applyPagePlan, billablePages } from "@/lib/business/scope";
import { buildCatalog, type TechEntry } from "@/lib/business/tech-catalog";
import { activeClientIds, matchTechnology, parseClientTech, parseClientTechInput, unmatchedNames, withDependencies } from "@/lib/business/tech-preference";
import { recommendTechnology } from "@/lib/business/tech-recommend";
import type { Lead, Quotation, Requirement } from "@/lib/business/types";
import { parseRequirement } from "@/lib/business/validate";

const rates = DEFAULT_RATE_CARD;
const TN = { state: "Tamil Nadu" };
const HTML_CSS_JS = ["HTML", "CSS", "Vanilla JavaScript"];

/** The requirement from the client's document: 4 pages, HTML/CSS/JS only, demo form, ₹10,000 budget. */
function documentRequirement(extra: Partial<Requirement> = {}): Requirement {
  return {
    title: "BrightWave Solutions website", summary: "Four page static website built with HTML, CSS and vanilla JavaScript only.", scope: "full", existingProject: "", version: "",
    projectType: "business-website", complexity: "basic", pages: ["Home", "About Us", "Services", "Contact Us"],
    pageDetails: { Home: { sections: 4, purpose: "" }, "About Us": { sections: 3, purpose: "" }, Services: { sections: 5, purpose: "Five services" }, "Contact Us": { sections: 3, purpose: "" } },
    modules: [], design: "ai", references: "", domain: { needed: false, choice: "self", name: "", tld: ".com", years: 1 },
    hosting: { needed: false, choice: "self", plan: "static", years: 1 }, deadlineWeeks: 0, budget: 10000, budgetStrict: true,
    clientTech: parseClientTech(HTML_CSS_JS), ...extra,
  };
}
const withoutTech = (r: Requirement): Requirement => ({ ...r, clientTech: undefined });
const shopNeedingBackend = (extra: Partial<Requirement> = {}): Requirement => ({ ...documentRequirement(), projectType: "ecommerce", complexity: "standard", modules: ["payments", "auth", "admin-panel"], budget: 150000, ...extra });
const catalogWith = (changes: Record<string, { enabled: boolean }>) => buildCatalog(changes);

describe("1. 'Stay within budget' never cuts the scope on its own", () => {
  it("all requested pages are priced in every package; the budget plan is only a suggestion", () => {
    const req = documentRequirement();
    const proposals = buildProposals(req, TN, rates);
    for (const p of proposals) {
      assert.equal(p.pages.length, 4, `${p.title} keeps all four pages`);
      assert.equal(p.fitsBudget, false, "and is honestly marked over the ₹10,000 budget");
    }
    const std = proposals.find((p) => p.tier === "standard")!;
    const check = checkBudget(std.requirement, std.quote, TN, rates, proposals);
    assert.deepEqual(check.pagePlan?.pages, ["Home"], "the reduced scope is shown separately");
    assert.deepEqual(billablePages(req), ["Home", "About Us", "Services", "Contact Us"], "checking the budget changes nothing in the requirement");
    assert.equal(req.deferredPages, undefined);
    assert.equal(req.budgetStrict, true);
  });
  it("the reduced scope is applied only when asked, and everything else goes to Phase 2 on record", () => {
    const req = documentRequirement({ modules: ["contact-form"] });
    const plan = { pages: ["Home"], contactForm: false };
    const applied = applyPagePlan(req, plan);
    assert.deepEqual(applied.pages, ["Home"]);
    assert.deepEqual(applied.deferredPages, ["About Us", "Services", "Contact Us"]);
    assert.deepEqual(applied.deferredModules, ["contact-form"]);
    assert.deepEqual(req.pages, ["Home", "About Us", "Services", "Contact Us"], "the original requirement object is untouched");
  });
  it("the wizard has no automatic scope cut, only the explicit button", () => {
    const source = readFileSync(path.resolve("src/components/business/requirement-wizard.tsx"), "utf8");
    assert.ok(!/budgetStrict\s*&&\s*plan/.test(source), "no effect applies the plan by itself");
    assert.ok(source.includes("Phase 2: not in this quotation"), "deferred items are announced on the package step");
    assert.ok(readFileSync(path.resolve("src/components/business/budget-summary.tsx"), "utf8").includes("Use this scope"));
  });
});

describe("2. the client's explicit technology is kept and shown", () => {
  it("matches the way clients write technology names to the catalog", () => {
    assert.equal(matchTechnology("Vanilla JavaScript"), "javascript");
    assert.equal(matchTechnology("vanilla JS"), "javascript");
    assert.equal(matchTechnology("HTML5"), "html");
    assert.equal(matchTechnology("Node.js"), "nodejs");
    assert.equal(matchTechnology("Postgres"), "postgresql");
    assert.equal(matchTechnology("Next.js"), "nextjs");
    assert.equal(matchTechnology("Vue"), undefined);
  });
  it("keeps what was stated, matched ids and unknown names apart", () => {
    const tech = parseClientTech(["HTML", "css", "Vanilla JavaScript", "html", "Svelte", ""])!;
    assert.deepEqual(tech.stated, ["HTML", "css", "Vanilla JavaScript", "Svelte"]);
    assert.deepEqual(tech.ids, ["html", "css", "javascript"]);
    assert.deepEqual(unmatchedNames(tech), ["Svelte"]);
    assert.equal(parseClientTech([]), undefined);
    assert.equal(parseClientTech(null), undefined);
    assert.equal(parseClientTech("HTML"), undefined);
  });
  it("adds what a technology depends on", () => {
    assert.deepEqual(withDependencies(["laravel"]).sort(), ["laravel", "php"]);
    assert.deepEqual(withDependencies(["bootstrap"]).sort(), ["bootstrap", "css", "html"]);
  });
  it("the quotation shows the client's technology, not Next.js and Tailwind", () => {
    const stack = suggestStack(documentRequirement(), rates);
    assert.equal(stack.frontend, "HTML, CSS and vanilla JavaScript");
    assert.equal(stack.styling, "CSS");
    assert.equal(stack.backend, "None (static site)");
    assert.ok(!/next|tailwind/i.test(`${stack.frontend} ${stack.styling}`));
    assert.ok(stack.notes.some((n) => n.includes("requested by the client") && n.includes("nothing is substituted")));
  });
  it("without a stated technology nothing changes", () => {
    const stack = suggestStack(withoutTech(documentRequirement()), rates);
    assert.equal(stack.frontend, "Next.js (React), exported as a static site");
    assert.equal(stack.styling, "Tailwind CSS");
  });
  it("shows a requested backend and database for a project that needs one", () => {
    const stack = suggestStack(shopNeedingBackend({ clientTech: parseClientTech(["PHP", "Laravel", "MySQL"]) }), rates);
    assert.equal(stack.backend, "PHP + Laravel");
    assert.equal(stack.database, "MySQL");
  });
  it("names an unknown technology as something to confirm, never silently swaps it", () => {
    const stack = suggestStack(documentRequirement({ clientTech: parseClientTech(["Svelte"]) }), rates);
    assert.ok(stack.notes.some((n) => n.includes('"Svelte" is not in our technology list yet')));
    assert.equal(stack.frontend, "Next.js (React), exported as a static site", "no technology is claimed that was not understood");
  });
  it("a confirmed alternative is shown instead, with the original request on record", () => {
    const stack = suggestStack(documentRequirement({ clientTech: { ...parseClientTech(["Vue"])!, confirmedIds: ["javascript", "nextjs"] } }), rates);
    assert.match(stack.frontend, /JavaScript/);
    assert.ok(stack.frontend.includes("Next.js"));
    assert.ok(stack.notes.some((n) => n.includes("asked for Vue") && n.includes("confirmed")));
  });
  it("module and version work keeps the existing project's stack", () => {
    const stack = suggestStack(documentRequirement({ scope: "module", existingProject: "Shop" }), rates);
    assert.ok(!stack.notes.some((n) => n.includes("requested by the client")));
  });
  it("technology never changes the price", () => {
    const a = buildQuote(documentRequirement(), TN, rates);
    const b = buildQuote(withoutTech(documentRequirement()), TN, rates);
    assert.equal(a.grandTotal, b.grandTotal);
    assert.deepEqual(a.items, b.items);
  });
});

describe("3. the same technology everywhere: quotation, packages, build brief", () => {
  const req = documentRequirement({ budgetStrict: false });
  const proposals = buildProposals(req, TN, rates);

  it("every package shows the same client technology", () => {
    for (const p of proposals) {
      assert.equal(p.quote.stack.frontend, "HTML, CSS and vanilla JavaScript", p.title);
      assert.equal(p.quote.stack.styling, "CSS", p.title);
    }
  });
  it("the build brief tells the AI builder to use exactly this", () => {
    const quote = proposals[1].quote;
    const quotation = { ...quote, number: "SQ-2026-0001", tier: "standard", requirement: proposals[1].requirement } as unknown as Quotation;
    const lead = { id: "l1", stage: "approved", client: { name: "Ravi", email: "", phone: "", company: "BrightWave", gstin: "", state: "Tamil Nadu", address: "" }, requirement: req, quotation, payments: [], workLog: [] } as unknown as Lead;
    const brief = buildBrief(lead, rates);
    const text = JSON.stringify(brief);
    assert.match(text, /requested by the client: use exactly this/);
    assert.match(text, /Frontend: HTML, CSS and vanilla JavaScript/);
    assert.ok(!/Next\.js|Tailwind/.test(text), "the default stack never leaks into the brief");
  });
  it("Basic does not swap a backend the client asked for for a cheaper one", () => {
    const shop = shopNeedingBackend({ clientTech: parseClientTech(["Laravel", "PHP", "MySQL"]), budgetStrict: false });
    const basic = buildProposals(shop, TN, rates).find((p) => p.tier === "basic")!;
    assert.equal(basic.quote.stack.backend, "PHP + Laravel");
    assert.ok(!basic.leftOut.some((l) => l.startsWith("Built with")));
  });
  it("is accepted by the server with the ids worked out from the client's own words", () => {
    const parsed = parseRequirement({ ...documentRequirement(), clientTech: { stated: HTML_CSS_JS, ids: ["react", "angular"], confirmedIds: ["nextjs", "cobol"] } }, rates);
    assert.deepEqual(parsed.clientTech, { stated: HTML_CSS_JS, ids: ["html", "css", "javascript"], confirmedIds: ["nextjs"] });
    assert.equal("clientTech" in parseRequirement(withoutTech(documentRequirement()), rates), false, "no key when nothing was stated");
    assert.equal(parseClientTechInput({ stated: [] }), undefined);
  });
});

describe("4. the recommendation respects the client's technology", () => {
  it("uses HTML, CSS and JavaScript as asked, and marks it as the client's choice", () => {
    const out = recommendTechnology(documentRequirement(), undefined, buildCatalog(), rates);
    assert.equal(out.clientPreference.status, "honoured");
    assert.equal(out.requiresConfirmation, false);
    assert.ok(out.options.length > 0);
    for (const o of out.options) {
      assert.equal(o.source, "client");
      assert.deepEqual(o.stack.frontend.map((t) => t.id), ["html", "css", "javascript"]);
    }
    assert.ok(out.notes.some((n) => n.includes("Using the technology the client asked for")));
  });
  it("adds no frameworks or libraries the client did not ask for, even with every technology enabled", () => {
    const all = catalogWith(Object.fromEntries(["jquery", "bootstrap", "react", "angular", "php", "laravel", "nestjs", "mysql", "sqlite", "mongodb"].map((id) => [id, { enabled: true }])));
    const out = recommendTechnology(documentRequirement(), undefined, all, rates);
    for (const o of out.options) assert.deepEqual(o.ids.filter((id) => !["html", "css", "javascript"].includes(id)), ["shared-hosting"]);
  });
  it("a disabled technology is explained and an alternative needs the client's confirmation", () => {
    const out = recommendTechnology(documentRequirement(), undefined, catalogWith({ html: { enabled: false } }), rates);
    assert.equal(out.clientPreference.status, "needs-confirmation");
    assert.equal(out.requiresConfirmation, true);
    assert.ok(out.clientPreference.problems.includes("HTML is not currently offered."));
    assert.match(out.clientPreference.confirmation!, /confirm an alternative with the client before it is used/);
    assert.ok(out.options.length > 0);
    for (const o of out.options) {
      assert.equal(o.source, "recommended", "an alternative is never presented as the client's choice");
      assert.ok(!o.ids.includes("html"));
    }
    assert.equal(out.notes[0], out.clientPreference.confirmation);
  });
  it("an unknown technology is reported, not guessed", () => {
    const out = recommendTechnology(documentRequirement({ clientTech: parseClientTech(["Svelte"]) }), undefined, buildCatalog(), rates);
    assert.equal(out.requiresConfirmation, true);
    assert.ok(out.clientPreference.problems.includes('"Svelte" is not in the technology catalog.'));
    assert.ok(out.options.every((o) => o.source === "recommended"));
  });
  it("incompatible requests are explained", () => {
    const out = recommendTechnology(documentRequirement({ clientTech: parseClientTech(["Next.js", "Shared hosting"]) }), undefined, buildCatalog(), rates);
    assert.equal(out.requiresConfirmation, true);
    assert.ok(out.clientPreference.problems.some((m) => m.includes("cannot be combined")));
  });
  it("a request that needs a technology which is switched off is explained (Laravel needs PHP)", () => {
    const out = recommendTechnology(shopNeedingBackend({ clientTech: parseClientTech(["Laravel"]) }), undefined, catalogWith({ laravel: { enabled: true } }), rates);
    assert.equal(out.requiresConfirmation, true);
    assert.ok(out.clientPreference.problems.includes("PHP is not currently offered."));
  });
  it("when the project needs a backend, the client's frontend is kept and a backend is added around it", () => {
    const out = recommendTechnology(shopNeedingBackend({ clientTech: parseClientTech(HTML_CSS_JS) }), undefined, buildCatalog(), rates);
    assert.equal(out.clientPreference.status, "honoured");
    const top = out.options[0];
    assert.equal(top.source, "client");
    assert.deepEqual(top.stack.frontend.map((t) => t.id), ["html", "css", "javascript"]);
    assert.ok(top.stack.backend.length > 0 && top.stack.database.length > 0);
  });
  it("asks for confirmation when no enabled combination can use the request", () => {
    const noBackend = catalogWith({ nodejs: { enabled: false }, postgresql: { enabled: false } });
    const out = recommendTechnology(shopNeedingBackend({ clientTech: parseClientTech(HTML_CSS_JS) }), undefined, noBackend, rates);
    assert.equal(out.requiresConfirmation, true);
    assert.ok(out.clientPreference.problems.some((m) => m.includes("No enabled combination")));
    assert.ok(out.options.every((o) => o.source === "recommended"));
  });
  it("an alternative the client confirmed is used and marked as confirmed", () => {
    const req = documentRequirement({ clientTech: { ...parseClientTech(HTML_CSS_JS)!, confirmedIds: ["javascript", "nextjs"] } });
    assert.deepEqual(activeClientIds(req.clientTech), ["javascript", "nextjs"]);
    const out = recommendTechnology(req, undefined, catalogWith({ html: { enabled: false } }), rates);
    assert.equal(out.clientPreference.status, "honoured");
    assert.equal(out.clientPreference.confirmedAlternative, true);
    assert.equal(out.requiresConfirmation, false);
    assert.ok(out.options.every((o) => o.source === "client" && o.ids.includes("nextjs")));
  });
  it("without a stated technology the recommendation is ours and nothing needs confirming", () => {
    const out = recommendTechnology(withoutTech(documentRequirement()), undefined, buildCatalog(), rates);
    assert.equal(out.clientPreference.status, "none");
    assert.equal(out.requiresConfirmation, false);
    assert.ok(out.options.every((o) => o.source === "recommended"));
  });
  it("never changes the estimate and never mutates its inputs", () => {
    const req = documentRequirement();
    const before = JSON.stringify([req, rates]);
    const a = recommendTechnology(req, 10000, buildCatalog(), rates).options[0].estimate;
    const b = recommendTechnology(withoutTech(req), 10000, buildCatalog(), rates).options[0].estimate;
    assert.equal(JSON.stringify([req, rates]), before);
    assert.equal(a!.total, b!.total);
  });
  it("handles a missing or broken catalog without throwing", () => {
    for (const bad of [null, [], "x"]) {
      const out = recommendTechnology(documentRequirement(), 10000, bad as unknown as TechEntry[], rates);
      assert.deepEqual(out.options, []);
      assert.ok(out.notes.length > 0);
    }
  });
});

describe("5. the Standard package keeps its Home sections (regex bug)", () => {
  it("Standard keeps a Home page with 4 sections; Basic caps it at 3", () => {
    const home4: Requirement = { ...documentRequirement({ budgetStrict: false, clientTech: undefined, budget: 0 }), pages: ["Home"], pageDetails: { Home: { sections: 4, purpose: "" } } };
    const [basic, standard, premium] = buildProposals(home4, TN, rates);
    assert.equal(basic.requirement.pageDetails!.Home.sections, 3);
    assert.equal(standard.requirement.pageDetails!.Home.sections, 4);
    assert.equal(premium.requirement.pageDetails!.Home.sections, 4);
    assert.equal(standard.quote.totalHours, 15.5);
    assert.equal(standard.grandTotal, 9145);
    assert.ok(standard.grandTotal > basic.grandTotal && standard.grandTotal < premium.grandTotal, "the three packages are three different prices");
  });
  it("other long pages are capped at 3 sections in Standard", () => {
    const standard = buildProposals({ ...documentRequirement({ budgetStrict: false, clientTech: undefined }), budget: 0 }, TN, rates)[1];
    assert.equal(standard.requirement.pageDetails!.Services.sections, 3);
    assert.equal(standard.requirement.pageDetails!.Home.sections, 4);
  });
  it("no source file contains a stray control character (the cause of that bug)", () => {
    const bad: string[] = [];
    const scan = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) scan(full);
        else if (/\.(ts|tsx|mjs|css)$/.test(entry.name) && /[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(readFileSync(full, "utf8"))) bad.push(full);
      }
    };
    scan(path.resolve("src"));
    scan(path.resolve("tests"));
    assert.deepEqual(bad, []);
  });
});

describe("6. pricing and GST are unchanged", () => {
  it("the one-page figures from the rate card still hold", () => {
    const home3: Requirement = { ...documentRequirement({ budgetStrict: false, clientTech: undefined }), pages: ["Home"], pageDetails: { Home: { sections: 3, purpose: "" } } };
    const q = buildQuote(home3, TN, rates);
    assert.equal(q.totalHours, 14);
    assert.equal(q.subtotal, 7000);
    assert.equal(q.gst.total, 1260);
    assert.equal(q.grandTotal, 8260);
  });
});
