// The client chooses their own technology; the quotation price follows it. Run: npm test
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { applyClientTech, parseTechSelection, previewTech, techChoices } from "@/lib/business/client-tech";
import { buildProposals } from "@/lib/business/proposals";
import { DEFAULT_RATE_CARD } from "@/lib/business/rate-card";
import type { Requirement } from "@/lib/business/types";
import { ValidationError } from "@/lib/business/validate";

const rates = DEFAULT_RATE_CARD;
const TN = { state: "Tamil Nadu" };

const base = (extra: Partial<Requirement> = {}): Requirement => ({
  title: "Booking portal",
  summary: "A customer portal with logins and an admin area for bookings and payments.",
  scope: "full",
  existingProject: "",
  version: "",
  projectType: "web-app",
  complexity: "standard",
  pages: ["Home", "Dashboard", "Bookings", "Contact"],
  modules: ["auth", "admin-panel"],
  design: "ai",
  references: "",
  domain: { needed: false, choice: "self", name: "", tld: ".com", years: 1 },
  hosting: { needed: false, choice: "self", plan: "static", years: 1 },
  deadlineWeeks: 0,
  budget: 0,
  ...extra,
});
const site = (): Requirement => base({ projectType: "business-website", modules: ["contact-form"] });
const layer = (c: ReturnType<typeof techChoices>, name: string) => c.layers.find((l) => l.layer === name)!;
const opt = (l: ReturnType<typeof layer>, id: string) => l.options.find((o) => o.id === id)!;

describe("what each technology does to the price", () => {
  const c = techChoices(base(), TN, rates, "standard");

  it("shows frontend, backend and database, each with 'SILPI chooses' first at no price change", () => {
    assert.deepEqual(c.layers.map((l) => l.layer), ["frontend", "backend", "database", "styling"]);
    for (const l of c.layers) {
      assert.ok(l.applies);
      assert.equal(l.options[0].id, "");
      assert.equal(l.options[0].delta, 0);
    }
  });

  it("a cheaper technology lowers the total, a heavier one raises it, an equal one changes nothing", () => {
    assert.ok(opt(layer(c, "backend"), "supabase").delta < 0, "Supabase needs less backend code");
    assert.ok(opt(layer(c, "backend"), "django").delta > 0);
    assert.ok(opt(layer(c, "frontend"), "angular").delta > 0);
    assert.ok(opt(layer(c, "database"), "mongodb").delta > 0);
    assert.equal(opt(layer(c, "database"), "mysql").delta, 0);
    // The delta is the real difference of the real totals.
    const o = opt(layer(c, "backend"), "django");
    assert.equal(o.total, c.total + o.delta);
  });

  it("a static site has no backend or database to choose", () => {
    const s = techChoices(site(), TN, rates, "standard");
    assert.equal(layer(s, "frontend").applies, true);
    assert.equal(layer(s, "backend").applies, false);
    assert.deepEqual(layer(s, "backend").options, []);
    assert.equal(layer(s, "database").applies, false);
  });

  it("nothing internal is sent: only labels, details and totals", () => {
    assert.ok(!/factor|margin|cost/i.test(JSON.stringify(c)));
  });
});

describe("reading and applying the client's choice", () => {
  it("accepts known, available options and a blank 'SILPI chooses'", () => {
    assert.deepEqual(parseTechSelection({ frontend: "vue", backend: "supabase", database: "" }, base(), rates), { frontend: "vue", backend: "supabase" });
  });
  it("rejects unknown or unavailable options and non-objects", () => {
    assert.throws(() => parseTechSelection({ frontend: "cobol" }, base(), rates), ValidationError);
    assert.throws(() => parseTechSelection({ backend: "<script>" }, base(), rates), ValidationError);
    const off = { ...rates, technology: { ...rates.technology, backend: { ...rates.technology.backend, laravel: { ...rates.technology.backend.laravel, available: false } } } };
    assert.throws(() => parseTechSelection({ backend: "laravel" }, base(), off), ValidationError);
    assert.throws(() => parseTechSelection("vue", base(), rates), ValidationError);
    assert.throws(() => parseTechSelection(null, base(), rates), ValidationError);
  });
  it("ignores a backend or database on a project that has none", () => {
    assert.deepEqual(parseTechSelection({ frontend: "vue", backend: "node", database: "postgres" }, site(), rates), { frontend: "vue" });
  });
  it("the choice replaces an earlier stack selection and technology note", () => {
    const earlier = base({ clientTech: { stated: ["PHP"], ids: ["php"] }, selectedStack: { ids: ["nextjs", "nodejs"] }, tech: { frontend: "angular" } });
    const next = applyClientTech(earlier, { backend: "supabase" }, rates);
    assert.deepEqual(next.tech, { backend: "supabase" });
    assert.equal(next.clientTech, undefined);
    assert.equal(next.selectedStack, undefined);
    assert.deepEqual(applyClientTech(earlier, {}, rates).tech, {}, "all 'SILPI chooses' resets the choice");
    assert.deepEqual(applyClientTech(earlier, {}, rates).clientTech, earlier.clientTech, "nothing else is touched then");
  });
});

describe("the new price is the price the quotation will carry", () => {
  it("the preview equals the proposals priced with that technology, for every package", () => {
    const tech = { frontend: "vue", backend: "supabase" };
    const p = previewTech(base(), TN, rates, "standard", tech);
    const direct = buildProposals({ ...base(), tech }, TN, rates);
    for (const t of ["basic", "standard", "premium"] as const) assert.equal(p.tiers[t], direct.find((x) => x.tier === t)!.grandTotal);
    assert.equal(p.total, p.tiers.standard);
    assert.equal(p.delta, p.total - previewTech(base(), TN, rates, "standard", {}).total);
    assert.equal(p.advance, Math.round((p.total * rates.advancePercent) / 100));
    assert.match(p.stack.backend, /Supabase/);
  });
});

describe("approving with a technology choice", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "silpi-clienttech-"));
  process.env.SILPI_DB_PATH = path.join(dir, "test.db");
  after(() => {
    const cached = globalThis as unknown as { silpiDb?: { close(): void } };
    cached.silpiDb?.close();
    delete cached.silpiDb;
    rmSync(dir, { recursive: true, force: true });
  });
  const client = { name: "Test", email: "t@example.com", phone: "9876543210", company: "Acme", gstin: "", state: "Tamil Nadu", address: "" };

  it("saves the choice, prices the quotation again with it and records it in the history", async () => {
    const store = await import("@/lib/business/store");
    const { parseRequirement } = await import("@/lib/business/validate");
    const lead = store.createLead(client, parseRequirement(base(), store.getRateCard()), "standard");
    const before = lead.quotation!;
    const token = store.shareToken(lead.id);

    const answered = store.respondAsClient(token, { action: "approved", tier: "standard", name: "Pat Client", message: "", tech: { frontend: "vue", backend: "supabase" } });
    assert.equal(answered.stage, "approved");
    assert.deepEqual(answered.requirement.tech, { frontend: "vue", backend: "supabase" });
    const after = answered.quotation!;
    assert.notEqual(after.id, before.id, "a new quotation was issued");
    assert.match(after.stack.backend, /Supabase/);
    assert.match(after.stack.frontend, /Vue/);
    assert.equal(after.grandTotal, previewTech(before.requirement!, TN, store.getRateCard(), "standard", { frontend: "vue", backend: "supabase" }).total);
    assert.ok(after.grandTotal !== before.grandTotal, "the price followed the technology");
    assert.ok(store.stageHistory(lead.id).some((h) => /Client chose the technology/.test(h.note)));
  });

  it("a team discount survives the change (never above the limit), and a choice that changes nothing issues nothing", async () => {
    const store = await import("@/lib/business/store");
    const { parseRequirement } = await import("@/lib/business/validate");
    const lead = store.createLead(client, parseRequirement(base(), store.getRateCard()), "standard");
    const discounted = store.requote(lead.id, 500);
    assert.equal(discounted.quotation!.discount, 500);
    const same = store.respondAsClient(store.shareToken(lead.id), { action: "approved", tier: "standard", name: "Pat Client", message: "", tech: {} });
    assert.equal(same.quotation!.id, discounted.quotation!.id, "no tech change, no new quotation");

    const second = store.createLead(client, parseRequirement(base(), store.getRateCard()), "standard");
    store.requote(second.id, 500);
    const changed = store.respondAsClient(store.shareToken(second.id), { action: "approved", name: "Pat Client", message: "", tech: { backend: "django" } });
    assert.equal(changed.quotation!.discount, 500, "the discount the team gave is kept");
  });

  it("the team can set the technology too: same prices, discount kept, and only while the quotation is open", async () => {
    const store = await import("@/lib/business/store");
    const { parseRequirement } = await import("@/lib/business/validate");
    const lead = store.createLead(client, parseRequirement(base(), store.getRateCard()), "standard");
    store.requote(lead.id, 500);
    const set = store.setTechnology(lead.id, { backend: "supabase" });
    assert.deepEqual(set.requirement.tech, { backend: "supabase" });
    assert.equal(set.quotation!.discount, 500);
    assert.match(set.quotation!.stack.backend, /Supabase/);
    assert.equal(set.quotation!.tier, "standard");
    assert.throws(() => store.setTechnology(lead.id, { backend: "cobol" } as never), ValidationError);
    store.setStage(lead.id, "approved");
    assert.throws(() => store.setTechnology(lead.id, { backend: "node" }), /locked/);
  });

  it("a bad or unavailable technology is refused and nothing changes; an hourly engagement is left alone", async () => {
    const store = await import("@/lib/business/store");
    const { parseRequirement } = await import("@/lib/business/validate");
    const lead = store.createLead(client, parseRequirement(base(), store.getRateCard()), "standard");
    const token = store.shareToken(lead.id);
    assert.throws(() => store.respondAsClient(token, { action: "approved", name: "Pat Client", message: "", tech: { frontend: "cobol" } }), ValidationError);
    assert.equal(store.getLead(lead.id)!.stage, "quoted", "still open");

    const hourly = store.createLead(client, parseRequirement({ ...base(), pages: [], modules: [], billing: "hourly", hourly: { role: "Consultant", rate: 1000, estimatedHours: 10, rangePct: 20, cycle: "monthly" } }, store.getRateCard()));
    const done = store.respondAsClient(store.shareToken(hourly.id), { action: "approved", name: "Pat Client", message: "", tech: { frontend: "vue" } });
    assert.deepEqual(done.requirement.tech ?? {}, {}, "no technology is attached to an hourly engagement");
  });
});

describe("styling and UI libraries", () => {
  const c = techChoices(base(), TN, rates, "standard");
  const styling = layer(c, "styling");

  it("offers Bootstrap, Ant Design, PrimeNG and Material UI, each tagged with the frontends it works with", () => {
    for (const id of ["bootstrap", "antd", "primeng", "mui", "angular-material", "vuetify", "primevue", "skeleton"]) assert.ok(opt(styling, id), id);
    assert.deepEqual(opt(styling, "primeng").frameworks, ["angular"]);
    assert.ok(opt(styling, "antd").frameworks!.includes("react"));
  });
  it("covers React, Next.js, Angular, Vue and Svelte frontends", () => {
    const front = layer(c, "frontend");
    for (const id of ["next", "react", "angular", "vue", "svelte"]) assert.ok(opt(front, id), id);
  });
  it("accepts a UI library that fits the frontend and drops one that does not", () => {
    assert.deepEqual(parseTechSelection({ frontend: "angular", styling: "primeng" }, base(), rates), { frontend: "angular", styling: "primeng" });
    assert.deepEqual(parseTechSelection({ frontend: "vue", styling: "primeng" }, base(), rates), { frontend: "vue" });
    assert.deepEqual(parseTechSelection({ styling: "mui" }, base(), rates), { styling: "mui" }, "no frontend picked = Next.js, which Material UI fits");
    assert.throws(() => parseTechSelection({ styling: "nope" }, base(), rates), ValidationError);
  });
  it("the chosen library shows in the stack and the price follows it", () => {
    const p = previewTech(base(), TN, rates, "standard", { frontend: "angular", styling: "primeng" });
    assert.equal(p.stack.styling, "PrimeNG");
    const plain = previewTech(base(), TN, rates, "standard", { frontend: "angular" });
    assert.equal(plain.stack.styling, "Tailwind CSS");
    assert.ok(p.total < plain.total, "a ready-made component library saves hours");
  });
  it("a library that does not fit the frontend is never priced or shown", () => {
    const p = previewTech(base(), TN, rates, "standard", { frontend: "vue", styling: "primeng" });
    assert.equal(p.stack.styling, "Tailwind CSS");
  });
});
