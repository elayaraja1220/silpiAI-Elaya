// Running services (domain, hosting, maintenance): admin sees everything, the client sees only what was approved.
// The key promise: no public response, page, document or file ever contains a provider cost, a suggested price,
// a markup, an internal status or an internal note. Checked on real responses from the real route handlers.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

const root = mkdtempSync(path.join(tmpdir(), "silpi-running-"));
process.env.SILPI_DB_PATH = path.join(root, "test.db");
const ADMIN = "test-admin-token-for-silpi-tests-0123456789";
process.env.SILPI_ADMIN_TOKEN = ADMIN;
const AUTH = { authorization: `Bearer ${ADMIN}` };

import { NextRequest } from "next/server";

import { clientView } from "@/lib/business/client-view";
import { emptyCostConfig } from "@/lib/business/cost-config";
import { calcRecurring, suggestRecurringItems } from "@/lib/business/cost-recurring";
import {
  ARRANGEMENTS, adminRunningSummary, parseRunningServices, publicRunningServices, publicServiceLine, recurringIncome, runningTotals, seedRunningServices, serviceMarkup,
  type RunningService,
} from "@/lib/business/running-services";
import { formatINR } from "@/lib/business/pricing";
import type { Requirement } from "@/lib/business/types";

// Values that must NEVER appear in anything public. Chosen to be unmistakable.
const SECRET_COST = 4321.11;
const SECRET_PRICE = 9876.54;
const SECRET_NOTE = "SECRET-INTERNAL-NOTE-zq81";
const SECRET_PROVIDER = "SECRET-PROVIDER-Acme-Reseller-xk4";
const CLIENT_AMOUNT = 2500;

const mods = async () => ({
  store: await import("@/lib/business/store"),
  running: await import("@/lib/business/running-store"),
  validate: await import("@/lib/business/validate"),
  download: await import("@/lib/business/download"),
  documents: await import("@/lib/business/documents"),
});

after(() => {
  const cached = globalThis as unknown as { silpiDb?: { close(): void } };
  cached.silpiDb?.close();
  delete cached.silpiDb;
  try { rmSync(root, { recursive: true, force: true }); } catch { /* Windows may hold the file a moment */ }
});

const svc = (over: Partial<RunningService> & { id: string }): RunningService => ({
  service: "Service", category: "other", provider: SECRET_PROVIDER, providerCost: SECRET_COST, suggestedPrice: SECRET_PRICE, clientAmount: null, gstIncluded: false,
  frequency: "annual", arrangement: "client-direct", internalStatus: "confirmed", showToClient: true, renewalTerms: "", internalNotes: SECRET_NOTE, ...over,
});

const requirement = (): Requirement => ({
  title: "BrightWave site", summary: "A four page website that is long enough to be valid.", scope: "full", existingProject: "", version: "", projectType: "business-website", complexity: "basic",
  pages: ["Home", "About Us", "Contact Us"], modules: [], design: "ai", references: "", domain: { needed: false, choice: "self", name: "", tld: ".com", years: 1 },
  hosting: { needed: false, choice: "self", plan: "static", years: 1 }, deadlineWeeks: 0, budget: 0,
});
async function newLead() {
  const { store, validate } = await mods();
  const client = { name: "Test Client", email: "t@example.com", phone: "9876543210", company: "", gstin: "", state: "Tamil Nadu", address: "" };
  const lead = store.createLead(client, validate.parseRequirement(requirement(), store.getRateCard()), "standard");
  return { lead: store.getLead(lead.id)!, token: store.shareToken(lead.id) };
}
const req = (url: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) =>
  new NextRequest(`http://localhost:3000${url}`, { method: init.method ?? "GET", headers: { host: "localhost:3000", ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers }, body: init.body ? JSON.stringify(init.body) : undefined });

/** Everything a hostile reader must not find in a public payload. */
function assertNoInternal(payload: string, where: string) {
  for (const s of [String(SECRET_COST), String(SECRET_PRICE), SECRET_NOTE, SECRET_PROVIDER, "4,321", "9,876"]) assert.ok(!payload.includes(s), `${where} leaked ${s}`);
  for (const key of ["providerCost", "suggestedPrice", "internalNotes", "internalStatus", "markup", "\"provider\":", "showToClient", "\"arrangement\":"]) assert.ok(!payload.includes(key), `${where} exposes the internal field name ${key}`);
}

// =================================================================================================
describe("1. the service record is strictly validated, with safe defaults", () => {
  it("accepts a minimal record and fills the safe defaults (not shown to the client, client pays directly)", () => {
    const [s] = parseRunningServices([{ id: "domain", service: "Domain name renewal" }]);
    assert.deepEqual([s.arrangement, s.showToClient, s.internalStatus, s.providerCost, s.suggestedPrice, s.clientAmount, s.frequency, s.gstIncluded], ["client-direct", false, "to-review", null, null, null, null, false]);
  });
  it("rejects bad shapes, unknown fields, bad values and duplicates", () => {
    const bad = (x: unknown, re: RegExp) => assert.throws(() => parseRunningServices(x), re);
    bad("x", /must be a list/);
    bad([null], /must be an object/);
    bad([{ id: "a", service: "A", extra: 1 }], /unknown field/);
    bad([{ id: "a", service: "A", arrangement: "free-for-all" }], /arrangement must be one of/);
    bad([{ id: "a", service: "A", frequency: "weekly" }], /frequency must be one of/);
    bad([{ id: "a", service: "A", providerCost: -1 }], /provider cost must be a number/);
    bad([{ id: "a", service: "A", clientAmount: "12" }], /client amount must be a number/);
    bad([{ id: "a", service: "A", clientAmount: 1e12 }], /client amount must be a number/);
    bad([{ id: "a", service: "A", showToClient: "yes" }], /showToClient must be true or false/);
    bad([{ id: "Bad Id!", service: "A" }], /id may only use/);
    bad([{ id: "a", service: "" }], /name is required/);
    bad([{ id: "a", service: "A" }, { id: "a", service: "B" }], /duplicate id/);
    bad([{ id: "a", service: "A", renewalTerms: "x".repeat(301) }], /at most 300/);
    bad([{ id: "a", service: "A", arrangement: "client-direct", includedInPackage: true }], /includedInPackage must match/);
    bad(Array.from({ length: 31 }, (_, i) => ({ id: `s${i}`, service: "S" })), /At most 30/);
  });
  it("includedInPackage is derived from the arrangement and may only agree with it", () => {
    assert.equal(parseRunningServices([{ id: "a", service: "A", arrangement: "included", includedInPackage: true }])[0].arrangement, "included");
  });
  it("control characters are stripped from text", () => {
    assert.equal(parseRunningServices([{ id: "a", service: "A\u0000B\u0007" }])[0].service, "AB");
  });
  it("money is rounded to paise", () => {
    assert.equal(parseRunningServices([{ id: "a", service: "A", providerCost: 100.456 }])[0].providerCost, 100.46);
  });
});

// =================================================================================================
describe("2. the starting list comes from the existing cost engine and shows nothing to the client", () => {
  it("seeds from the suggested running costs: client-direct for mandatory, 'optional, not selected' for optional, hidden", () => {
    const config = { ...emptyCostConfig(), runningCosts: { "domain-renewal": { provider: "Registrar", kind: "recurring" as const, amount: 900, frequency: "annual" as const, necessity: "mandatory" as const, payer: "client" as const, status: "estimated" as const } } };
    const seed = seedRunningServices(calcRecurring(suggestRecurringItems(["shared-hosting"], { modules: [] }, config.runningCosts), config));
    const by = Object.fromEntries(seed.map((s) => [s.id, s]));
    assert.equal(by.domain.providerCost, 900);
    assert.equal(by.domain.provider, "Registrar");
    assert.equal(by.domain.arrangement, "client-direct");
    assert.equal(by["hosting-shared-hosting"].arrangement, "client-direct");
    assert.equal(by["hosting-shared-hosting"].providerCost, null, "an unknown amount stays unknown");
    assert.equal(by.maintenance.arrangement, "optional-not-selected");
    assert.ok(seed.every((s) => s.showToClient === false && s.clientAmount === null && s.internalStatus === "to-review"));
    assert.equal(publicRunningServices(seed), null, "nothing is client-visible until approved");
    assert.doesNotThrow(() => parseRunningServices(seed), "the seed is itself valid");
  });
});

// =================================================================================================
describe("3. what the client may see, by arrangement", () => {
  const view = (...items: RunningService[]) => publicRunningServices(items);
  it("1. SILPI provides and bills: client sees the approved charge, frequency, responsibility and renewal terms; no cost", () => {
    const v = view(svc({ id: "hosting", service: "Hosting", arrangement: "agency-bills", clientAmount: CLIENT_AMOUNT, frequency: "annual", renewalTerms: "Renews every year on 1 April." }))!;
    assert.deepEqual(v.services[0], { service: "Hosting", status: "billed-by-us", statusLabel: "Billed separately by SILPI", responsibility: "SILPI bills the client", amount: CLIENT_AMOUNT, amountNote: "+ GST", frequency: "Every year", renewalTerms: "Renews every year on 1 April." });
    assertNoInternal(JSON.stringify(v), "agency-bills");
  });
  it("GST wording follows the flag", () => {
    assert.equal(view(svc({ id: "a", arrangement: "agency-bills", clientAmount: 100, gstIncluded: true }))!.services[0].amountNote, "incl. GST");
  });
  it("billed by SILPI without a client amount yet: no amount, no invented number", () => {
    const s = view(svc({ id: "a", arrangement: "agency-bills", clientAmount: null }))!.services[0];
    assert.equal(s.amount, null);
    assert.equal(s.amountNote, null);
  });
  it("2. client buys directly: told to buy it separately; NO amount, even if one was typed; no provider suggestions", () => {
    const v = view(svc({ id: "hosting", service: "Hosting", arrangement: "client-direct", clientAmount: CLIENT_AMOUNT, frequency: "annual" }))!;
    const s = v.services[0];
    assert.deepEqual([s.status, s.amount, s.amountNote, s.responsibility], ["client-buys-directly", null, null, "Client pays the provider directly"]);
    assert.match(s.statusLabel, /purchased separately by you from the provider/);
    assertNoInternal(JSON.stringify(v), "client-direct");
  });
  it("3. included in the package: 'Included', no amount, no provider cost", () => {
    const v = view(svc({ id: "hosting", service: "Hosting", arrangement: "included", clientAmount: CLIENT_AMOUNT }))!;
    const s = v.services[0];
    assert.deepEqual([s.status, s.statusLabel, s.amount, s.frequency], ["included", "Included in your package", null, null]);
    assertNoInternal(JSON.stringify(v), "included");
  });
  it("4. optional and not selected: shown as optional, with no amount", () => {
    const s = view(svc({ id: "m", service: "Maintenance", arrangement: "optional-not-selected", clientAmount: CLIENT_AMOUNT, renewalTerms: "Monthly" }))!.services[0];
    assert.deepEqual([s.status, s.amount, s.renewalTerms], ["optional", null, null]);
  });
  it("5. not applicable: never shown", () => {
    assert.equal(view(svc({ id: "n", arrangement: "not-applicable" })), null);
  });
  it("a service the admin has not approved for the client is never shown", () => {
    assert.equal(view(svc({ id: "a", arrangement: "agency-bills", clientAmount: 100, showToClient: false })), null);
    const v = view(svc({ id: "a", service: "Shown", showToClient: true }), svc({ id: "b", service: "Hidden", showToClient: false }))!;
    assert.deepEqual(v.services.map((s) => s.service), ["Shown"]);
  });
  it("nothing configured: no public object at all (existing quotations are unchanged)", () => {
    assert.equal(publicRunningServices(null), null);
    assert.equal(publicRunningServices(undefined), null);
    assert.equal(publicRunningServices([]), null);
  });
  it("the public object has exactly the allow-listed keys, whatever the internal record contains", () => {
    const v = view(...ARRANGEMENTS.map((a) => svc({ id: a, service: a, arrangement: a, clientAmount: 1 })))!;
    for (const s of v.services) assert.deepEqual(Object.keys(s).sort(), ["amount", "amountNote", "frequency", "renewalTerms", "responsibility", "service", "status", "statusLabel"]);
    assert.deepEqual(Object.keys(v).sort(), ["note", "services"]);
    // a field added to the internal record later cannot leak: the serializer copies named fields only
    const extra = { ...svc({ id: "x", arrangement: "agency-bills", clientAmount: 5 }), futureSecret: "SECRET-FUTURE" } as RunningService;
    assert.ok(!JSON.stringify(view(extra)).includes("SECRET-FUTURE"));
  });
  it("a document line uses the same wording as the screen", () => {
    const s = view(svc({ id: "a", service: "Hosting", arrangement: "agency-bills", clientAmount: 2500, renewalTerms: "Renews yearly." }))!.services[0];
    assert.equal(publicServiceLine(s, formatINR), `Hosting: Billed separately by SILPI · ${formatINR(2500)} + GST · Every year · Renews yearly.`);
  });
  it("admin-only helpers: markup and summary", () => {
    assert.deepEqual(serviceMarkup(svc({ id: "a", arrangement: "agency-bills", providerCost: 1000, clientAmount: 1500 })), { amount: 500, percent: 50 });
    assert.equal(serviceMarkup(svc({ id: "a", arrangement: "client-direct", providerCost: 1000, clientAmount: 1500 })), null, "no markup when the client pays the provider");
    assert.equal(serviceMarkup(svc({ id: "a", arrangement: "agency-bills", providerCost: null, clientAmount: 1500 })), null);
    const sum = adminRunningSummary([svc({ id: "a", arrangement: "agency-bills" }), svc({ id: "b", showToClient: false })]);
    assert.deepEqual([sum.total, sum.visibleToClient, sum.priceMissing, sum.byArrangement["agency-bills"]], [2, 1, 1, 1]);
  });
});

// =================================================================================================
describe("4. public responses never carry internal data (real route handlers, real database)", () => {
  const FULL: RunningService[] = [
    svc({ id: "domain", service: "Domain name renewal", category: "domain-renewal", arrangement: "client-direct", frequency: "annual", renewalTerms: "Renews yearly with the registrar." }),
    svc({ id: "hosting", service: "Hosting", category: "shared-hosting", arrangement: "agency-bills", clientAmount: CLIENT_AMOUNT, frequency: "annual", renewalTerms: "Renews every year on the same date." }),
    svc({ id: "ssl", service: "SSL certificate", arrangement: "included" }),
    svc({ id: "maint", service: "Maintenance", category: "maintenance-support", arrangement: "optional-not-selected" }),
    svc({ id: "cdn", service: "CDN", arrangement: "not-applicable" }),
    svc({ id: "hidden", service: "Internal-only backup service", arrangement: "agency-bills", clientAmount: 777, showToClient: false }),
  ];

  it("an existing quotation with no arrangements is exactly as before", async () => {
    const { store } = await mods();
    const { lead, token } = await newLead();
    const before = JSON.stringify(clientView(lead, store.getRateCard().business));
    const route = await import("@/app/api/client/[token]/route");
    const res = await route.GET(req(`/api/client/${token}`), { params: Promise.resolve({ token }) });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.ok(!("running" in body.view), "no running key when nothing is approved");
    assert.equal(JSON.stringify(body.view), before.replace(/"payment":.*?\}(?=,"|\})/, (m) => m), "the public view did not change");
  });

  it("GET /api/client/:token shows only approved services, with client-safe fields", async () => {
    const { running } = await mods();
    const { lead, token } = await newLead();
    running.saveRunningServices(lead.id, FULL);
    const route = await import("@/app/api/client/[token]/route");
    const res = await route.GET(req(`/api/client/${token}`), { params: Promise.resolve({ token }) });
    const text = await res.text();
    assert.equal(res.status, 200);
    const body = JSON.parse(text);
    assert.deepEqual(body.view.running.services.map((s: { service: string }) => s.service), ["Domain name renewal", "Hosting", "SSL certificate", "Maintenance"]);
    assert.equal(body.view.running.services.find((s: { service: string }) => s.service === "Hosting").amount, CLIENT_AMOUNT);
    assertNoInternal(text, "GET /api/client/:token");
    assert.ok(!text.includes("Internal-only backup service") && !text.includes("777"), "a service not approved for the client is absent");
    assert.ok(!text.includes("CDN"), "a not-applicable service is absent");
  });

  it("the client's approval response (POST) carries no internal data either", async () => {
    const { running } = await mods();
    const { lead, token } = await newLead();
    running.saveRunningServices(lead.id, FULL);
    const route = await import("@/app/api/client/[token]/route");
    const res = await route.POST(req(`/api/client/${token}`, { method: "POST", body: { action: "approved", tier: "standard", name: "Test Client", message: "", agree: true } }), { params: Promise.resolve({ token }) });
    const text = await res.text();
    assert.equal(res.status, 200, text.slice(0, 200));
    assert.equal(JSON.parse(text).view.stage, "approved");
    assertNoInternal(text, "POST /api/client/:token");
    assert.ok(text.includes("Hosting"), "the approved services are still shown");
  });

  it("the client's document download (Word and PDF) contains the approved services and no internal data", async () => {
    const { running, documents, store } = await mods();
    const { lead } = await newLead();
    running.saveRunningServices(lead.id, FULL);
    const full = store.getLead(lead.id)!;
    const pub = running.publicRunningFor(lead.id);
    const outline = documents.quotationOutline(full.quotation!, full.requirement, pub);
    const text = JSON.stringify(outline);
    assert.ok(text.includes("Running services (billed separately from development)"));
    assert.ok(text.includes(`Hosting: Billed separately by SILPI · ${formatINR(CLIENT_AMOUNT)} + GST`));
    assertNoInternal(text, "document content");
    const route = await import("@/app/api/client/[token]/document/route");
    const token = store.shareToken(lead.id);
    for (const format of ["docx", "pdf"]) {
      const res = await route.GET(req(`/api/client/${token}/document?format=${format}`), { params: Promise.resolve({ token }) });
      assert.equal(res.status, 200, format);
      const bytes = Buffer.from(await res.arrayBuffer());
      assert.ok(bytes.length > 1000, format);
      assert.ok(!bytes.toString("latin1").includes(SECRET_NOTE), `${format} file contains an internal note`);
    }
  });

  it("the team's own document route sends the same client-safe version", async () => {
    const { running } = await mods();
    const { lead } = await newLead();
    running.saveRunningServices(lead.id, FULL);
    const route = await import("@/app/api/business/leads/[id]/document/route");
    const res = await route.GET(req(`/api/business/leads/${lead.id}/document?format=docx`), { params: Promise.resolve({ id: lead.id }) });
    assert.equal(res.status, 200);
    assert.ok(!Buffer.from(await res.arrayBuffer()).toString("latin1").includes(SECRET_NOTE));
  });

  it("a damaged stored row never reaches the client: the quotation simply has no running services", async () => {
    const { running } = await mods();
    const { lead, token } = await newLead();
    const { getDb } = await import("@/lib/business/db");
    getDb().prepare("INSERT INTO running_services (lead_id, data, updated_at) VALUES (?, ?, ?)").run(lead.id, "{not json", new Date().toISOString());
    assert.equal(running.getRunningServices(lead.id), null);
    const route = await import("@/app/api/client/[token]/route");
    const body = await (await route.GET(req(`/api/client/${token}`), { params: Promise.resolve({ token }) })).json();
    assert.ok(!("running" in body.view));
    getDb().prepare("UPDATE running_services SET data = ? WHERE lead_id = ?").run(JSON.stringify([{ id: "a", service: "A", arrangement: "hack" }]), lead.id);
    assert.equal(running.getRunningServices(lead.id), null, "a row that fails validation is ignored");
  });

  it("the stored internal record keeps its internal data (admin can still see it)", async () => {
    const { running } = await mods();
    const { lead } = await newLead();
    running.saveRunningServices(lead.id, FULL);
    const back = running.getRunningServices(lead.id)!;
    assert.equal(back[1].providerCost, SECRET_COST);
    assert.equal(back[1].suggestedPrice, SECRET_PRICE);
    assert.equal(back[1].internalNotes, SECRET_NOTE);
  });
});

// =================================================================================================
describe("5. the admin API: signed-in administrator only", () => {
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
  it("no credentials or wrong credentials: 401, and nothing about the lead is revealed", async () => {
    const route = await import("@/app/api/business/leads/[id]/running-services/route");
    const { lead } = await newLead();
    for (const r of [req(`/x`), req(`/x`, { headers: { authorization: "Bearer wrong-token-value-here" } })]) {
      const res = await route.GET(r, ctx(lead.id));
      assert.equal(res.status, 401);
      assert.ok(!(await res.text()).includes(SECRET_COST.toString()));
    }
    const put = await route.PUT(req("/x", { method: "PUT", body: { services: [] } }), ctx(lead.id));
    assert.equal(put.status, 401);
  });
  it("with the admin token: a seeded starting list, then a validated save, and the full internal record comes back", async () => {
    const route = await import("@/app/api/business/leads/[id]/running-services/route");
    const { lead } = await newLead();
    const first = await (await route.GET(req("/x", { headers: AUTH }), ctx(lead.id))).json();
    assert.equal(first.success, true);
    assert.equal(first.saved, false);
    assert.ok(first.services.length >= 3 && first.services.every((s: RunningService) => s.showToClient === false));
    assert.equal(first.clientPreview, null, "nothing is client-visible until approved");

    const services = [svc({ id: "hosting", service: "Hosting", arrangement: "agency-bills", clientAmount: CLIENT_AMOUNT, providerCost: 1000 })];
    const put = await (await route.PUT(req("/x", { method: "PUT", headers: AUTH, body: { services } }), ctx(lead.id))).json();
    assert.equal(put.success, true);
    assert.equal(put.saved, true);
    assert.equal(put.services[0].providerCost, 1000, "admin sees the provider cost");
    assert.equal(put.services[0].internalNotes, SECRET_NOTE, "admin sees the internal notes");
    assert.deepEqual(put.markups.hosting, { amount: 1500, percent: 150 }, "admin sees the markup");
    assert.equal(put.clientPreview.services[0].amount, CLIENT_AMOUNT);
    assertNoInternal(JSON.stringify(put.clientPreview), "admin's own client preview");
    const again = await (await route.GET(req("/x", { headers: AUTH }), ctx(lead.id))).json();
    assert.equal(again.saved, true);
    assert.equal(again.services.length, 1);
  });
  it("invalid input is rejected with 400 and saves nothing", async () => {
    const route = await import("@/app/api/business/leads/[id]/running-services/route");
    const { running } = await mods();
    const { lead } = await newLead();
    for (const body of [{ services: "x" }, { services: [{ id: "a", service: "A", arrangement: "nope" }] }, { services: [{ id: "a", service: "A", providerCost: -5 }] }, {}]) {
      const res = await route.PUT(req("/x", { method: "PUT", headers: AUTH, body }), ctx(lead.id));
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    assert.equal(running.getRunningServices(lead.id), null);
  });
  it("bad or unknown project ids are refused", async () => {
    const route = await import("@/app/api/business/leads/[id]/running-services/route");
    assert.equal((await route.GET(req("/x", { headers: AUTH }), ctx("../../etc"))).status, 400);
    assert.equal((await route.GET(req("/x", { headers: AUTH }), ctx("11111111-1111-4111-8111-111111111111"))).status, 404);
  });
  it("a lead without a quotation cannot be seeded", async () => {
    const route = await import("@/app/api/business/leads/[id]/running-services/route");
    const { getDb } = await import("@/lib/business/db");
    const { lead } = await newLead();
    getDb().prepare("DELETE FROM quotations WHERE lead_id = ?").run(lead.id);
    assert.equal((await route.GET(req("/x", { headers: AUTH }), ctx(lead.id))).status, 400);
  });
  it("the existing costs route still answers exactly as before (it now shares one helper)", async () => {
    const route = await import("@/app/api/business/leads/[id]/costs/route");
    const { lead } = await newLead();
    const body = await (await route.GET(req(`/api/business/leads/${lead.id}/costs`), ctx(lead.id))).json();
    assert.equal(body.success, true);
    assert.deepEqual(Object.keys(body).sort(), ["config", "costs", "runningCosts", "success", "suggestedRunningCosts"]);
    assert.ok(body.costs.clientDevelopment.total > 0);
  });
});

// =================================================================================================
describe("6. security by construction", () => {
  const read = (f: string) => readFileSync(path.resolve(f), "utf8");
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));

  it("no public file reads the internal record, the store or the internal fields", () => {
    const publicFiles = [...walk(path.resolve("src/app/q")), "src/lib/business/client-view.ts", "src/components/business/quotation-document.tsx", "src/components/business/running-services-view.tsx"].map((f) => path.resolve(f));
    for (const f of publicFiles) {
      const code = readFileSync(f, "utf8");
      assert.ok(!/providerCost|suggestedPrice|internalNotes|internalStatus|serviceMarkup|getRunningServices|running-store/.test(code), `${path.relative(process.cwd(), f)} touches internal running-service data`);
    }
  });
  it("public API files only use the allow-listed serializer", () => {
    for (const f of walk(path.resolve("src/app/api/client"))) {
      const code = readFileSync(f, "utf8");
      assert.ok(!/getRunningServices|providerCost|suggestedPrice|internalNotes/.test(code), f);
    }
    assert.ok(read("src/app/api/client/[token]/route.ts").includes("publicRunningFor("));
    assert.ok(read("src/lib/business/download.ts").includes("publicRunningFor("));
  });
  it("the only way a stored record reaches the client is publicRunningServices()", () => {
    const callers = walk(path.resolve("src")).filter((f) => /getRunningServices\(/.test(readFileSync(f, "utf8"))).map((f) => path.relative(path.resolve("src"), f).replace(/\\/g, "/")).sort();
    assert.deepEqual(callers, ["app/api/business/leads/[id]/running-services/route.ts", "lib/business/running-store.ts"], "only the admin route and the store read the full record");
    const store = read("src/lib/business/running-store.ts");
    assert.ok(/publicRunningFor[\s\S]*publicRunningServices\(getRunningServices/.test(store));
  });
  it("the admin route requires the admin sign-in on both methods", () => {
    const route = read("src/app/api/business/leads/[id]/running-services/route.ts");
    assert.equal((route.match(/requireAdmin\(request\)/g) ?? []).length, 2);
  });
  it("the cost engines and the quotation calculation were not touched by this feature", () => {
    for (const f of ["cost-recurring.ts", "cost-estimate.ts", "cost-internal.ts", "cost-profit.ts", "pricing.ts", "proposals.ts"]) {
      assert.ok(!/running-services|running-store/.test(read(`src/lib/business/${f}`)), `${f} must not depend on running services`);
    }
  });
  it("running services never enter the development total: the quotation totals are the same with or without them", async () => {
    const { running, store } = await mods();
    const { lead } = await newLead();
    const before = JSON.stringify(store.getLead(lead.id)!.quotation);
    running.saveRunningServices(lead.id, [svc({ id: "hosting", arrangement: "agency-bills", clientAmount: 99999 })]);
    assert.equal(JSON.stringify(store.getLead(lead.id)!.quotation), before);
  });
});

// =================================================================================================
describe("running totals: what SILPI bills after launch", () => {
  const totalsOf = (...items: RunningService[]) => runningTotals(publicRunningServices(items)!);
  it("adds up what SILPI bills per period, GST kept apart, monthly first", () => {
    const t = totalsOf(
      svc({ id: "a", arrangement: "agency-bills", clientAmount: 1000, frequency: "annual" }),
      svc({ id: "b", arrangement: "agency-bills", clientAmount: 500, frequency: "monthly" }),
      svc({ id: "c", arrangement: "agency-bills", clientAmount: 300, frequency: "monthly" }),
      svc({ id: "d", arrangement: "agency-bills", clientAmount: 200, frequency: "monthly", gstIncluded: true }),
    );
    assert.deepEqual(t.totals.map((x) => [x.label, x.amount, x.amountNote]), [["Monthly", 800, "+ GST"], ["Monthly", 200, "incl. GST"], ["Every year", 1000, "+ GST"]]);
    assert.equal(t.unpriced, 0);
  });
  it("only services SILPI bills are counted; client-direct, included and optional are not", () => {
    const t = totalsOf(
      svc({ id: "a", arrangement: "client-direct", clientAmount: 999, frequency: "monthly" }),
      svc({ id: "b", arrangement: "included", clientAmount: 999 }),
      svc({ id: "c", arrangement: "optional-not-selected", clientAmount: 999 }),
    );
    assert.deepEqual(t, { totals: [], unpriced: 0 });
  });
  it("a billed service with no amount yet is counted as unpriced, never as a number", () => {
    const t = totalsOf(svc({ id: "a", arrangement: "agency-bills", clientAmount: null }), svc({ id: "b", arrangement: "agency-bills", clientAmount: 100, frequency: "monthly" }));
    assert.deepEqual([t.totals.length, t.unpriced], [1, 1]);
  });
});

// =================================================================================================
describe("recurring income across clients (admin)", () => {
  const bill = (id: string, over: Partial<RunningService>) => svc({ id, arrangement: "agency-bills", showToClient: true, ...over });
  it("turns every period into a monthly figure, before GST, and totals markup", () => {
    const r = recurringIncome([
      { leadId: "L1", services: [bill("a", { clientAmount: 1200, providerCost: 600, frequency: "monthly" }), bill("b", { clientAmount: 12000, providerCost: 6000, frequency: "annual" })] },
      { leadId: "L2", services: [bill("c", { clientAmount: 1180, gstIncluded: true, providerCost: 500, frequency: "monthly" })] },
    ], 18);
    assert.deepEqual([r.monthlyRevenue, r.monthlyCost, r.monthlyMarkup, r.yearlyRevenue, r.clients], [3200, 1600, 1600, 38400, 2]);
  });
  it("skips what is not recurring income: one-time, client-direct, hidden, no amount", () => {
    const r = recurringIncome([{ leadId: "L1", services: [
      bill("a", { clientAmount: 500, frequency: "one-time" }),
      svc({ id: "b", arrangement: "client-direct", showToClient: true, clientAmount: 500, frequency: "monthly" }),
      bill("c", { clientAmount: 500, frequency: "monthly", showToClient: false }),
      bill("d", { clientAmount: null, frequency: "monthly" }),
    ] }], 18);
    assert.deepEqual([r.rows.length, r.monthlyRevenue, r.unpriced], [0, 0, 1]);
  });
  it("a missing provider cost is counted as unknown, never as free profit", () => {
    const r = recurringIncome([{ leadId: "L1", services: [bill("a", { clientAmount: 1000, providerCost: null, frequency: "monthly" })] }], 18);
    assert.deepEqual([r.monthlyRevenue, r.monthlyMarkup, r.costUnknown, r.rows[0].monthlyMarkup], [1000, 0, 1, null]);
  });
  it("the route is admin-only and the card sits behind the admin gate", () => {
    assert.ok(/requireAdmin\(request\)/.test(readFileSync(path.resolve("src/app/api/business/recurring-income/route.ts"), "utf8")));
    assert.ok(/<AdminGate[\s\S]*<Figures \/>/.test(readFileSync(path.resolve("src/components/business/recurring-income-card.tsx"), "utf8")));
  });
});
