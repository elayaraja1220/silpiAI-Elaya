// Technology catalog foundation: defaults, availability, compatibility, overrides, persistence.
// Run: npm test
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { buildQuote } from "@/lib/business/pricing";
import { DEFAULT_RATE_CARD } from "@/lib/business/rate-card";
import {
  CATALOG_LAYERS,
  DEFAULT_TECH_CATALOG,
  LEVELS,
  SCALES,
  buildCatalog,
  checkStack,
  conflicts,
  enabledTech,
  findTech,
  mergeTechOverrides,
  parseTechOverrides,
  techForProject,
} from "@/lib/business/tech-catalog";
import { PROJECT_TYPES, type Requirement } from "@/lib/business/types";

const REQUESTED = ["html", "css", "javascript", "jquery", "bootstrap", "react", "nextjs", "angular", "php", "laravel", "nodejs", "nestjs", "mysql", "postgresql", "sqlite", "mongodb", "shared-hosting", "vps", "cloud-hosting"];

describe("1. catalog contents", () => {
  it("contains every requested technology exactly once", () => {
    const ids = DEFAULT_TECH_CATALOG.map((t) => t.id);
    assert.deepEqual([...ids].sort(), [...REQUESTED].sort());
    assert.equal(new Set(ids).size, ids.length);
  });
  it("every entry is complete and consistent", () => {
    for (const t of DEFAULT_TECH_CATALOG) {
      assert.ok(CATALOG_LAYERS.includes(t.layer), t.id);
      assert.ok(LEVELS.includes(t.maintenance), t.id);
      assert.ok(t.projectTypes.length > 0 && t.projectTypes.every((p) => PROJECT_TYPES.includes(p)), t.id);
      assert.ok(t.scalability.length > 0 && t.scalability.every((s) => SCALES.includes(s)), t.id);
      assert.ok(t.devFactor >= 0.1 && t.devFactor <= 5, t.id);
      assert.ok(t.label && t.description, t.id);
      for (const ref of [...t.requires, ...t.incompatibleWith]) assert.ok(findTech(DEFAULT_TECH_CATALOG, ref), `${t.id} refers to unknown ${ref}`);
    }
  });
  it("only technologies the current quotation flow already uses start enabled", () => {
    assert.deepEqual(
      enabledTech(DEFAULT_TECH_CATALOG).map((t) => t.id).sort(),
      ["cloud-hosting", "css", "html", "javascript", "nextjs", "nodejs", "postgresql", "shared-hosting", "vps"].sort(),
    );
  });
});

describe("2. availability and suitability", () => {
  it("only enabled technologies are offered, and the administrator can switch them", () => {
    assert.ok(!enabledTech(buildCatalog()).some((t) => t.id === "angular"));
    const on = buildCatalog({ angular: { enabled: true }, nextjs: { enabled: false } });
    assert.ok(enabledTech(on).some((t) => t.id === "angular"));
    assert.ok(!enabledTech(on).some((t) => t.id === "nextjs"));
  });
  it("filters by project type and layer, enabled only", () => {
    const catalog = buildCatalog({ laravel: { enabled: true } });
    const shopBackends = techForProject(catalog, "ecommerce", "backend").map((t) => t.id);
    assert.ok(shopBackends.includes("nodejs") && shopBackends.includes("laravel"));
    assert.ok(!shopBackends.includes("nestjs"), "disabled stays out");
    assert.ok(!techForProject(catalog, "landing-page", "database").some((t) => t.id === "postgresql"), "not suited to a landing page");
  });
});

describe("3. compatibility", () => {
  const catalog = buildCatalog({ laravel: { enabled: true }, php: { enabled: true }, mysql: { enabled: true } });
  it("accepts a valid stack", () => {
    assert.deepEqual(checkStack(catalog, ["javascript", "nextjs", "nodejs", "postgresql", "vps"]), { ok: true, issues: [] });
  });
  it("reports a missing requirement", () => {
    const r = checkStack(catalog, ["laravel", "mysql"]);
    assert.ok(!r.ok && r.issues.some((i) => i.kind === "missing-requirement" && i.with === "php"));
  });
  it("reports incompatible pairs from either side, e.g. Node.js on shared hosting", () => {
    assert.ok(conflicts(catalog, "nodejs", "shared-hosting") && conflicts(catalog, "shared-hosting", "nodejs"));
    const r = checkStack(catalog, ["php", "laravel", "mysql", "shared-hosting"]);
    assert.ok(r.ok, "PHP stack on shared hosting is fine");
    assert.ok(checkStack(catalog, ["javascript", "nextjs", "nodejs", "postgresql", "shared-hosting"]).issues.some((i) => i.kind === "incompatible"));
  });
  it("reports unknown and disabled technologies", () => {
    const r = checkStack(buildCatalog(), ["cobol", "angular"]);
    assert.ok(r.issues.some((i) => i.kind === "unknown" && i.id === "cobol"));
    assert.ok(r.issues.some((i) => i.kind === "disabled" && i.id === "angular"));
  });
});

describe("4. overrides are validated and never overwrite the defaults", () => {
  it("drops unknown ids, unknown fields and out-of-range values", () => {
    const parsed = parseTechOverrides({
      angular: { enabled: true, devFactor: 99, maintenance: "extreme", label: "Hacked", projectTypes: ["web-app", "robot"], security: ["  keep updated  ", 5] },
      cobol: { enabled: true },
      nextjs: "yes",
    });
    assert.deepEqual(parsed, { angular: { enabled: true, projectTypes: ["web-app"], security: ["keep updated"] } });
  });
  it("applying overrides leaves the built-in defaults untouched", () => {
    const before = JSON.stringify(DEFAULT_TECH_CATALOG);
    const catalog = buildCatalog({ angular: { enabled: true, devFactor: 1.5 } });
    catalog.find((t) => t.id === "angular")!.security.push("mutated");
    assert.equal(JSON.stringify(DEFAULT_TECH_CATALOG), before);
    assert.equal(findTech(catalog, "angular")!.devFactor, 1.5);
  });
  it("merging keeps entries that are not in the change", () => {
    const merged = mergeTechOverrides({ angular: { enabled: true }, php: { enabled: true } }, { angular: { devFactor: 1.3 } });
    assert.deepEqual(merged, { angular: { enabled: true, devFactor: 1.3 }, php: { enabled: true } });
  });
  it("saved ids that no longer exist are ignored when reading", () => {
    assert.equal(buildCatalog({ ghost: { enabled: true } } as never).length, DEFAULT_TECH_CATALOG.length);
  });
});

describe("5. existing pricing is unchanged", () => {
  const base = (extra: Partial<Requirement> = {}): Requirement => ({
    title: "Site", summary: "Six page responsive informational website.", scope: "full", existingProject: "", version: "", projectType: "web-app",
    complexity: "standard", pages: ["Home", "Contact Us"], modules: ["contact-form", "auth"], design: "ai", references: "",
    domain: { needed: false, choice: "self", name: "", tld: ".com", years: 1 }, hosting: { needed: false, choice: "self", plan: "static", years: 1 }, deadlineWeeks: 0, budget: 0, ...extra,
  });
  it("the catalog does not affect quotes: enabling technologies changes nothing", () => {
    const quote = buildQuote(base(), { state: "Tamil Nadu" }, DEFAULT_RATE_CARD);
    buildCatalog({ angular: { enabled: true, devFactor: 3 } });
    assert.deepEqual(buildQuote(base(), { state: "Tamil Nadu" }, DEFAULT_RATE_CARD), quote);
  });
});

describe("6. persistence (separate from saved quotations and the rate card)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "silpi-tech-"));
  process.env.SILPI_DB_PATH = path.join(dir, "test.db");
  after(() => {
    const cached = globalThis as unknown as { silpiDb?: { close(): void } };
    cached.silpiDb?.close();
    delete cached.silpiDb;
    rmSync(dir, { recursive: true, force: true });
  });

  it("starts from the defaults, saves changes and merges later ones", async () => {
    const store = await import("@/lib/business/store");
    assert.deepEqual(store.getTechOverrides(), {});
    assert.equal(findTech(store.getTechCatalog(), "angular")!.enabled, false);

    store.saveTechOverrides({ angular: { enabled: true } });
    store.saveTechOverrides({ php: { enabled: true, devFactor: 1.1 } });
    const saved = store.getTechOverrides();
    assert.deepEqual(saved, { angular: { enabled: true }, php: { enabled: true, devFactor: 1.1 } });
    assert.equal(findTech(store.getTechCatalog(), "angular")!.enabled, true);
    assert.equal(findTech(store.getTechCatalog(), "php")!.devFactor, 1.1);
  });
  it("saving the catalog does not touch the rate card or existing quotes", async () => {
    const store = await import("@/lib/business/store");
    const rateCardBefore = JSON.stringify(store.getRateCard());
    store.saveTechOverrides({ mongodb: { enabled: true } });
    assert.equal(JSON.stringify(store.getRateCard()), rateCardBefore);
  });
  it("corrupt saved data falls back to the defaults", async () => {
    const store = await import("@/lib/business/store");
    const { getDb } = await import("@/lib/business/db");
    getDb().prepare("UPDATE settings SET value = ? WHERE key = 'tech_catalog'").run("{not json");
    assert.deepEqual(store.getTechOverrides(), {});
    assert.equal(store.getTechCatalog().length, DEFAULT_TECH_CATALOG.length);
  });
});
