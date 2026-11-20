// Technology recommendation engine (step 2): scenarios, rules, edge cases and "nothing else changes".
// Run: npm test
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildQuote } from "@/lib/business/pricing";
import { DEFAULT_RATE_CARD } from "@/lib/business/rate-card";
import { DEFAULT_TECH_CATALOG, buildCatalog, checkStack, type TechEntry } from "@/lib/business/tech-catalog";
import { SEPARATE_COSTS_NOTICE, recommendTechnology, resolveNeeds, usableCatalog } from "@/lib/business/tech-recommend";
import type { ModuleId, Requirement } from "@/lib/business/types";

const rates = DEFAULT_RATE_CARD;
const TN = { state: "Tamil Nadu" };
const PAGES = ["Home", "About Us", "Services", "Products", "Gallery", "Blog", "Contact Us", "Pricing", "FAQ", "Team"];

function req(type: Requirement["projectType"], pageCount: number, modules: ModuleId[], extra: Partial<Requirement> = {}): Requirement {
  return {
    title: "Project", summary: "A project requirement that is long enough to be valid.", scope: "full", existingProject: "", version: "", projectType: type, complexity: "standard",
    pages: PAGES.slice(0, pageCount), modules, design: "ai", references: "", domain: { needed: false, choice: "self", name: "", tld: ".com", years: 1 },
    hosting: { needed: false, choice: "self", plan: "static", years: 1 }, deadlineWeeks: 0, budget: 0, ...extra,
  };
}

const ENABLE_ALL = ["jquery", "bootstrap", "react", "angular", "php", "laravel", "nestjs", "mysql", "sqlite", "mongodb"];
/** Every technology switched on. */
const allOn = () => buildCatalog(Object.fromEntries(ENABLE_ALL.map((id) => [id, { enabled: true }])));
const FRAMEWORKS = ["nextjs", "react", "angular", "laravel", "nestjs"];
const shop = () => req("ecommerce", 8, ["payments", "auth", "admin-panel", "search"]);
const advancedShop = () => req("ecommerce", 10, ["payments", "auth", "admin-panel", "search", "reports", "notifications", "api-integration"], { complexity: "advanced" });

describe("A. static website, low budget", () => {
  const out = recommendTechnology(req("business-website", 7, ["contact-form"]), 10000, allOn(), rates);
  it("recommends plain HTML, CSS and JavaScript on simple hosting, with no server and no framework", () => {
    const top = out.options[0];
    assert.deepEqual(top.stack.frontend.map((t) => t.id), ["html", "css", "javascript"]);
    assert.deepEqual(top.stack.backend, []);
    assert.deepEqual(top.stack.database, []);
    assert.equal(top.stack.hosting[0].id, "shared-hosting");
    assert.equal(top.complexity, "low");
    for (const o of out.options) assert.ok(!o.ids.some((id) => FRAMEWORKS.includes(id)), `no framework without a real need: ${o.ids}`);
  });
  it("reports the budget mismatch clearly and never reduces the price", () => {
    const top = out.options[0];
    assert.equal(top.budget.status, "over");
    assert.equal(top.budget.amount, 10000);
    assert.equal(top.budget.difference, 10000 - top.estimate!.total);
    assert.ok(top.estimate!.total > 10000);
    assert.ok(top.tradeoffs.some((t) => t.includes("not reduced automatically")));
    assert.ok(out.notes.some((n) => n.includes("below the estimated development cost")));
    const noBudget = recommendTechnology(req("business-website", 7, ["contact-form"]), 0, allOn(), rates);
    assert.equal(noBudget.options[0].estimate!.total, top.estimate!.total, "the estimate does not depend on the budget");
    assert.ok(out.budgetPlan, "what the budget can build is offered");
  });
});

describe("B. e-commerce, medium budget", () => {
  it("evaluates PHP/Laravel when it is enabled, and suits the shop's payment and admin needs", () => {
    const out = recommendTechnology(shop(), 120000, allOn(), rates);
    assert.equal(out.needs.demand, "heavy");
    assert.equal(out.needs.security, "elevated");
    assert.ok(out.options.some((o) => o.ids.includes("laravel")), "a Laravel option is offered");
    for (const o of out.options) {
      assert.ok(o.meetsRequirements);
      assert.ok(!o.ids.includes("shared-hosting") && !o.ids.includes("sqlite"), "not on shared hosting or SQLite when payments are taken");
      assert.ok(o.stack.backend.length > 0 && o.stack.database.length > 0);
    }
    assert.equal(out.options[0].budget.status, "within");
  });
  it("with only the default catalog, uses what is enabled: Next.js, Node.js and PostgreSQL", () => {
    const out = recommendTechnology(shop(), 120000, buildCatalog(), rates);
    assert.deepEqual(out.options[0].ids, ["javascript", "nextjs", "nodejs", "postgresql", out.options[0].stack.hosting[0].id]);
    assert.ok(out.options.every((o) => !o.ids.includes("laravel") && !o.ids.includes("php")), "disabled technologies are never recommended");
  });
});

describe("C. advanced application, high budget", () => {
  const needs = { scalability: "large", expectedUsers: "large", security: "high" } as const;
  const out = recommendTechnology(advancedShop(), 500000, allOn(), rates, { needs });
  it("justifies a modern stack and infrastructure because the requirements demand it", () => {
    const top = out.options[0];
    assert.equal(out.needs.scale, "large");
    assert.equal(out.needs.security, "high");
    assert.equal(out.needs.confidence, "high");
    assert.ok(top.ids.includes("nextjs") && top.ids.includes("nodejs") && top.ids.includes("postgresql"), top.ids.join());
    assert.ok(["vps", "cloud-hosting"].includes(top.stack.hosting[0].id));
    assert.equal(top.scalability, "large");
    assert.ok(top.meetsRequirements && top.security.length > 0);
    assert.equal(top.budget.status, "within");
    assert.ok(top.complexity === "high");
  });
  it("every option handles the large scale and high security", () => {
    for (const o of out.options) {
      assert.ok(o.meetsRequirements);
      assert.equal(o.scalability, "large");
      assert.ok(!o.ids.includes("shared-hosting") && !o.ids.includes("sqlite"));
    }
  });
});

describe("D. simple requirements, high budget", () => {
  it("does not over-engineer just because the budget is large", () => {
    const big = recommendTechnology(req("business-website", 5, ["contact-form"]), 500000, allOn(), rates);
    const small = recommendTechnology(req("business-website", 5, ["contact-form"]), 50000, allOn(), rates);
    assert.deepEqual(big.options[0].ids, small.options[0].ids, "the budget does not change the stack");
    assert.equal(big.options[0].complexity, "low");
    for (const o of big.options) assert.ok(!o.ids.some((id) => FRAMEWORKS.includes(id)));
    assert.ok(big.notes.some((n) => n.includes("well above the estimated cost")));
  });
  it("even with Next.js enabled (the default), a simple site stays static", () => {
    const out = recommendTechnology(req("landing-page", 1, ["contact-form"]), 500000, buildCatalog(), rates);
    assert.deepEqual(out.options[0].stack.frontend.map((t) => t.id), ["html", "css", "javascript"]);
  });
});

describe("E. disabled technologies", () => {
  it("never appears in any option", () => {
    const out = recommendTechnology(req("business-website", 5, ["contact-form"]), 50000, buildCatalog({ html: { enabled: false } }), rates);
    assert.ok(out.options.length > 0);
    for (const o of out.options) assert.ok(!o.ids.includes("html"));
  });
  it("explains when nothing is enabled or nothing can be combined", () => {
    const none = buildCatalog(Object.fromEntries(DEFAULT_TECH_CATALOG.map((t) => [t.id, { enabled: false }])));
    const out = recommendTechnology(shop(), 120000, none, rates);
    assert.deepEqual(out.options, []);
    assert.ok(out.notes.some((n) => n.includes("No technology is enabled")));

    const onlyHosting = buildCatalog({ nextjs: { enabled: false }, nodejs: { enabled: false }, postgresql: { enabled: false } });
    const stuck = recommendTechnology(shop(), 120000, onlyHosting, rates);
    assert.deepEqual(stuck.options, []);
    assert.ok(stuck.notes.some((n) => n.includes("No enabled technologies can be combined")));
  });
});

describe("F. incompatible combinations", () => {
  it("refuses them and every returned option passes checkStack", () => {
    const catalog = allOn();
    for (const r of [req("business-website", 5, ["contact-form"]), shop(), advancedShop()]) {
      const out = recommendTechnology(r, 300000, catalog, rates);
      for (const o of out.options) {
        assert.ok(checkStack(catalog, o.ids).ok, o.ids.join());
        assert.ok(!(o.ids.includes("nodejs") && o.ids.includes("shared-hosting")));
        for (const alt of o.hostingAlternatives) assert.ok(checkStack(catalog, [...o.ids.slice(0, -1), alt.id]).ok);
      }
    }
    const out = recommendTechnology(req("business-website", 5, ["contact-form"]), 50000, catalog, rates);
    assert.ok(out.rejectedCount > 0, "Next.js on shared hosting is refused");
    assert.ok(out.rejected.some((x) => x.issues.some((m) => m.includes("cannot be combined"))));
  });
  it("respects requirements such as Laravel needing PHP", () => {
    const out = recommendTechnology(shop(), 120000, buildCatalog({ laravel: { enabled: true } }), rates);
    assert.ok(out.options.every((o) => !o.ids.includes("laravel")), "Laravel without PHP is never offered");
  });
});

describe("G. missing or incomplete requirements", () => {
  it("lists what is missing instead of inventing it", () => {
    const out = recommendTechnology(req("business-website", 0, []), undefined, buildCatalog(), rates);
    assert.equal(out.needs.confidence, "low");
    assert.ok(out.needs.missing.some((m) => m.includes("No pages or features")));
    assert.ok(out.needs.missing.some((m) => m.includes("traffic")));
    assert.equal(out.needs.scaleSource, "assumed");
    assert.ok(out.needs.assumptions.some((a) => a.startsWith("Assumed small scale")));
    assert.equal(out.options[0].budget.status, "none");
    assert.equal(out.options[0].budget.amount, 0);
  });
  it("uses stated information as stated", () => {
    const n = resolveNeeds(req("business-website", 3, ["contact-form"]), rates, { traffic: "large", security: "standard" });
    assert.equal(n.scale, "large");
    assert.equal(n.scaleSource, "stated");
    assert.equal(n.securitySource, "stated");
    assert.equal(n.confidence, "high");
  });
  it("does not throw on a missing or unknown requirement", () => {
    for (const bad of [null, undefined, "x", {}, { projectType: "spaceship" }]) {
      const out = recommendTechnology(bad as never, 1000, buildCatalog(), rates);
      assert.deepEqual(out.options, []);
      assert.ok(out.notes.length > 0);
    }
  });
});

describe("H. budget below the estimated cost", () => {
  it("flags it and keeps the price", () => {
    const low = recommendTechnology(shop(), 20000, buildCatalog(), rates);
    const none = recommendTechnology(shop(), 0, buildCatalog(), rates);
    assert.equal(low.options[0].budget.status, "over");
    assert.ok(low.options[0].budget.difference! < 0);
    assert.equal(low.options[0].estimate!.total, none.options[0].estimate!.total);
    assert.ok(low.notes.some((n) => n.includes("Prices are not reduced automatically")));
  });
  it("uses the requirement's own budget when none is passed", () => {
    const out = recommendTechnology({ ...shop(), budget: 20000 }, undefined, buildCatalog(), rates);
    assert.equal(out.options[0].budget.amount, 20000);
  });
});

describe("I. security and scalability needs", () => {
  it("high security rules out shared hosting and SQLite", () => {
    const out = recommendTechnology(req("business-website", 6, ["auth", "contact-form"]), 80000, allOn(), rates, { needs: { security: "high" } });
    assert.equal(out.needs.security, "high");
    for (const o of out.options) assert.ok(!o.ids.includes("shared-hosting") && !o.ids.includes("sqlite"));
  });
  it("a stack that cannot reach the needed scale is flagged, not silently offered", () => {
    const phpOnly = buildCatalog({ php: { enabled: true }, mysql: { enabled: true }, nextjs: { enabled: false }, nodejs: { enabled: false }, postgresql: { enabled: false } });
    const out = recommendTechnology(shop(), 200000, phpOnly, rates, { needs: { scalability: "large" } });
    assert.ok(out.options.length > 0);
    for (const o of out.options) {
      assert.equal(o.meetsRequirements, false);
      assert.ok(o.tradeoffs.some((t) => t.includes("Only suited for")));
    }
    assert.ok(out.notes.some((n) => n.includes("fully meets")));
  });
  it("a stack suited for the scale is reported with its limit", () => {
    const out = recommendTechnology(shop(), 200000, allOn(), rates, { needs: { traffic: "medium" } });
    assert.ok(out.options.every((o) => o.scalability !== "small"));
  });
});

describe("J. empty or invalid catalog data", () => {
  it("never throws and explains the problem", () => {
    for (const bad of [[], null, undefined, "catalog", 42, {}, [null, 1, "x"]]) {
      const out = recommendTechnology(shop(), 120000, bad, rates);
      assert.deepEqual(out.options, []);
      assert.ok(out.notes.length > 0);
    }
    assert.ok(recommendTechnology(shop(), 1, null, rates).catalogProblems.length > 0);
  });
  it("ignores bad or duplicate entries and still uses the good ones", () => {
    const good = buildCatalog();
    const broken = [...good, { id: "ghost", layer: "frontend" }, { ...good[0] }, null as unknown as TechEntry];
    const { entries, problems } = usableCatalog(broken);
    assert.equal(entries.length, good.length);
    assert.equal(problems.length, 3);
    const out = recommendTechnology(shop(), 120000, broken, rates);
    assert.ok(out.options.length > 0);
    assert.equal(out.catalogProblems.length, 3);
  });
});

describe("K. nothing else changes", () => {
  it("the rate card is not modified and quotes are identical before and after", () => {
    const before = JSON.stringify(rates);
    const quote = buildQuote(shop(), TN, rates);
    recommendTechnology(shop(), 120000, allOn(), rates);
    recommendTechnology(advancedShop(), 500000, buildCatalog(), rates);
    assert.equal(JSON.stringify(rates), before);
    assert.deepEqual(buildQuote(shop(), TN, rates), quote);
  });
  it("the estimate is the existing pricing: a standard stack costs exactly what buildQuote gives", () => {
    const out = recommendTechnology(shop(), 120000, buildCatalog(), rates);
    const top = out.options[0];
    assert.equal(top.devFactor, 1);
    assert.equal(top.estimate!.total, buildQuote(shop(), TN, rates).grandTotal);
  });
  it("domain and hosting are never part of the estimate, and a separate-billing notice is always returned", () => {
    const out = recommendTechnology(shop(), 120000, allOn(), rates);
    assert.equal(out.separateCosts, SEPARATE_COSTS_NOTICE);
    assert.match(out.separateCosts, /domain, hosting/i);
    for (const o of out.options) assert.equal(o.estimate!.total, buildQuote(shop(), TN, { ...rates, stacks: { ...rates.stacks, custom: { ...rates.stacks.custom, devFactor: o.devFactor } } }).grandTotal);
  });
  it("is deterministic and returns a ranking", () => {
    const a = recommendTechnology(shop(), 120000, allOn(), rates);
    const b = recommendTechnology(shop(), 120000, allOn(), rates);
    assert.deepEqual(a, b);
    assert.deepEqual(a.options.map((o) => o.rank), a.options.map((_, i) => i + 1));
    for (let i = 1; i < a.options.length; i++) assert.ok(a.options[i - 1].score >= a.options[i].score);
  });
  it("honours maxOptions", () => {
    assert.equal(recommendTechnology(shop(), 120000, allOn(), rates, { maxOptions: 1 }).options.length, 1);
  });
});
