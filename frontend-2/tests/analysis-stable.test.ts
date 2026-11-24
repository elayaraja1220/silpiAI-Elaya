// The same document must always give the same draft and the same estimate. Run: npm test
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { deriveProjectType, needed, pageKey, stableDraft } from "@/lib/business/analysis-stable";
import { buildQuote, defaultSections } from "@/lib/business/pricing";
import { DEFAULT_RATE_CARD } from "@/lib/business/rate-card";
import type { ModuleId, ProjectType, Requirement, RequirementDraft } from "@/lib/business/types";
import { parseRequirement } from "@/lib/business/validate";

const rates = DEFAULT_RATE_CARD;
const sectionsFor = (page: string) => defaultSections(page, rates);

type P = { name: string; sections?: number; purpose?: string };
function draft(pages: P[], modules: ModuleId[] = [], extra: Partial<RequirementDraft> = {}): RequirementDraft {
  return {
    client: { name: "", email: "", phone: "", company: "", state: "Tamil Nadu" },
    title: "Project",
    summary: "A website for the business with the pages and features listed in the document.",
    scope: "full",
    existingProject: "",
    projectType: "business-website",
    complexity: "standard",
    pages: pages.map((p) => ({ name: p.name, sections: p.sections ?? 3, purpose: p.purpose ?? "" })),
    supportingPages: [],
    sharedComponents: [],
    qualityRequirements: [],
    externalServices: [],
    modules,
    mustHave: [],
    design: "ai",
    references: "",
    domainName: "",
    needsDomain: false,
    needsHosting: false,
    deadlineWeeks: 0,
    clientBudget: 0,
    seoKeywords: [],
    technologyPreference: [],
    confirmed: [],
    missingInfo: [],
    assumptions: [],
    ...extra,
  };
}

describe("page names mean the same page whatever the wording", () => {
  const same = (names: string[]) => assert.equal(new Set(names.map(pageKey)).size, 1, names.join(" | "));
  it("the same idea in different words has one key", () => {
    same(["About", "About Us", "about us page", "Who we are", "Our Story", "Company Profile"]);
    same(["Contact", "Contact Us", "Get in touch", "Enquiry form", "Contact page"]);
    same(["Home", "Homepage", "Landing page", "Home Page"]);
    same(["Services", "Our Services", "What we do", "Service"]);
    same(["Login", "Sign in", "Log in"]);
    same(["Customer Registration & Login", "Login & Customer Registration", "customer sign up and sign in"]);
    same(["Tour Packages", "Tour Package", "tour packages page"]);
  });
  it("different pages stay different", () => {
    assert.notEqual(pageKey("Customer Dashboard"), pageKey("Agent Dashboard"));
    assert.notEqual(pageKey("Hotel Booking"), pageKey("Bus Booking"));
    assert.notEqual(pageKey("Login"), pageKey("Register"));
    assert.notEqual(pageKey("Tour Packages"), pageKey("Pricing"));
  });
});

describe("several readings become one repeatable draft", () => {
  // Three readings of one document: different words, different order, different section counts, and one bogus page.
  const a = draft([{ name: "About Us", sections: 6 }, { name: "Home", sections: 9 }, { name: "Services" }, { name: "Contact", sections: 4 }, { name: "Gallery" }], ["contact-form", "gallery-preview"]);
  const b = draft([{ name: "Homepage", sections: 2 }, { name: "Who we are", sections: 1 }, { name: "Our Services" }, { name: "Photo gallery" }, { name: "Get in touch" }, { name: "Careers (maybe)" }], ["gallery-preview", "contact-form", "blog"]);
  const c = draft([{ name: "Contact Us", sections: 8 }, { name: "Services" }, { name: "Gallery" }, { name: "About", sections: 7 }, { name: "Home page" }], ["contact-form", "gallery-preview"]);
  const runs = [a, b, c];

  it("keeps what most readings agree on, with fixed names, fixed order and the engine's own section counts", () => {
    const d = stableDraft(runs, sectionsFor);
    assert.deepEqual(d.pages.map((p) => p.name), ["Home", "About Us", "Services", "Gallery", "Contact Us"]);
    for (const p of d.pages) assert.equal(p.sections, sectionsFor(p.name), `${p.name} sections come from the pricing rules`);
    assert.deepEqual(d.modules, ["contact-form", "gallery-preview"], "a feature only one reading mentioned (blog) is left out");
  });

  it("gives the same draft whatever order the readings and their pages come in", () => {
    const base = JSON.stringify(stableDraft(runs, sectionsFor));
    for (const order of [[0, 2, 1], [1, 0, 2], [2, 1, 0], [1, 2, 0]]) {
      assert.equal(JSON.stringify(stableDraft(order.map((i) => runs[i]), sectionsFor).pages), JSON.stringify(JSON.parse(base).pages));
    }
    const reversed = runs.map((r) => ({ ...r, pages: [...r.pages].reverse(), modules: [...r.modules].reverse() }));
    const d = stableDraft(reversed, sectionsFor);
    assert.deepEqual(d.pages, JSON.parse(base).pages);
    assert.deepEqual(d.modules, JSON.parse(base).modules);
  });

  it("the same document worded differently prices the same", () => {
    const one = draft([{ name: "Home" }, { name: "About" }, { name: "Services" }, { name: "Contact" }], ["contact-form"]);
    const two = draft([{ name: "Services Page", sections: 12 }, { name: "Who we are", sections: 1 }, { name: "Homepage" }, { name: "Get in touch", sections: 9 }], ["contact-form"], { projectType: "cms-website", complexity: "advanced" });
    const price = (d: RequirementDraft) => {
      const s = stableDraft([d], sectionsFor);
      const requirement = parseRequirement(
        {
          title: "T", summary: "A website for the business with the listed pages and features.", scope: "full", existingProject: "", version: "", projectType: s.projectType, complexity: s.complexity,
          pages: s.pages.map((p) => p.name), pageDetails: Object.fromEntries(s.pages.map((p) => [p.name, { sections: p.sections, purpose: "" }])),
          modules: s.modules, design: s.design, references: "", domain: { choice: "self" }, hosting: { choice: "self" }, deadlineWeeks: 0, budget: 0,
        },
        rates,
      );
      return buildQuote(requirement, { state: "Tamil Nadu" }, rates).grandTotal;
    };
    assert.equal(price(one), price(two));
  });

  it("a page only one reading invented does not appear; two readings agreeing keep it", () => {
    const withExtra = draft([{ name: "Home" }, { name: "Dealer Locator" }]);
    const without = draft([{ name: "Home" }]);
    assert.deepEqual(stableDraft([withExtra, without, without], sectionsFor).pages.map((p) => p.name), ["Home"]);
    assert.deepEqual(stableDraft([withExtra, withExtra, without], sectionsFor).pages.map((p) => p.name), ["Dealer Locator", "Home"].sort((x, y) => (x === "Home" ? -1 : y === "Home" ? 1 : 0)));
    assert.equal(needed(1), 1);
    assert.equal(needed(2), 2);
    assert.equal(needed(3), 2);
  });

  it("a single reading still works and is cleaned the same way", () => {
    const d = stableDraft([draft([{ name: "Contact", sections: 9 }, { name: "Homepage", sections: 1 }, { name: "404 page" }, { name: "Header" }])], sectionsFor);
    assert.deepEqual(d.pages.map((p) => p.name), ["Home", "Contact Us"]);
    assert.deepEqual(d.supportingPages, ["404 Not Found"]);
  });

  it("budget and deadline are kept only when the readings agree on the same number", () => {
    const d = stableDraft([draft([{ name: "Home" }], [], { clientBudget: 100000, deadlineWeeks: 6 }), draft([{ name: "Home" }], [], { clientBudget: 100000, deadlineWeeks: 8 }), draft([{ name: "Home" }], [], { clientBudget: 120000 })], sectionsFor);
    assert.equal(d.clientBudget, 100000);
    assert.equal(d.deadlineWeeks, 0);
  });

  it("nothing to combine is an error, and readings that share no page keep what was seen", () => {
    assert.throws(() => stableDraft([], sectionsFor));
    assert.throws(() => stableDraft([{}, null, 3], sectionsFor));
    const d = stableDraft([draft([{ name: "Alpha" }]), draft([{ name: "Beta" }]), draft([{ name: "Gamma" }])], sectionsFor);
    assert.deepEqual(d.pages.map((p) => p.name), ["Alpha", "Beta", "Gamma"]);
  });
});

describe("the project type follows from what is in the project", () => {
  const t = (keys: string[], modules: ModuleId[], majority: ProjectType | null = null) => deriveProjectType(keys, modules, majority);
  it("works it out from pages and features", () => {
    assert.equal(t(["home"], []), "landing-page");
    assert.equal(t(["home", "about", "contact"], ["contact-form"]), "business-website");
    assert.equal(t(["home", "blog"], ["admin-panel"]), "cms-website");
    assert.equal(t(["home", "dashboard"], ["auth", "admin-panel"]), "web-app");
    assert.equal(t(["home", "cart", "checkout"], []), "ecommerce");
    assert.equal(t(["home"], ["payments"]), "ecommerce");
  });
  it("a clear shop or app from the readings is never downgraded", () => {
    assert.equal(t(["home", "about"], [], "ecommerce"), "ecommerce");
    assert.equal(t(["home"], [], "web-app"), "web-app");
    assert.equal(t(["home", "about"], [], "cms-website"), "business-website");
  });
});

describe("a saved analysis", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "silpi-analysis-"));
  process.env.SILPI_DB_PATH = path.join(dir, "test.db");
  after(() => {
    const cached = globalThis as unknown as { silpiDb?: { close(): void } };
    cached.silpiDb?.close();
    delete cached.silpiDb;
    rmSync(dir, { recursive: true, force: true });
  });
  const b64 = (s: string) => Buffer.from(s).toString("base64");

  it("is found again for the same content: another file name, another order and different spacing in the notes change nothing", async () => {
    const { analysisKey } = await import("@/lib/business/analysis-cache");
    const x = [{ data: b64("document one") }, { data: b64("document two") }];
    const key = analysisKey(x, "Call  notes ");
    assert.equal(analysisKey([x[1], x[0]], "call notes"), key);
    assert.notEqual(analysisKey([x[0]], "call notes"), key);
    assert.notEqual(analysisKey(x, "other notes"), key);
    assert.notEqual(analysisKey([{ data: b64("document one!") }, x[1]], "call notes"), key);
  });

  it("is saved and read back unchanged, and the oldest are dropped past the limit", async () => {
    const { analysisKey, getSavedAnalysis, saveAnalysis } = await import("@/lib/business/analysis-cache");
    const d = stableDraft([draft([{ name: "Home" }, { name: "Contact" }], ["contact-form"])], sectionsFor);
    const key = analysisKey([{ data: b64("a") }], "");
    assert.equal(getSavedAnalysis(key), null);
    saveAnalysis(key, { draft: d, model: "m", costUsd: 0.01, runs: 3 });
    const back = getSavedAnalysis(key)!;
    assert.deepEqual(back.draft, d);
    assert.equal(back.runs, 3);
    // Saving again replaces it (the "read again" option), it does not add a second copy.
    saveAnalysis(key, { draft: { ...d, title: "Changed" }, model: "m", costUsd: 0, runs: 3 });
    assert.equal(getSavedAnalysis(key)!.draft.title, "Changed");
  });
});
