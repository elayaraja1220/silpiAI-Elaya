// Global pricing data on a real database: the starting data, adding rates with sources, history that cannot be edited, CSV import, settings, and who may change what.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { NextRequest } from "next/server";

const dir = mkdtempSync(path.join(tmpdir(), "silpi-pricing-data-"));
const ADMIN = "test-admin-token-0123456789abcdef";
const admin = { authorization: `Bearer ${ADMIN}` };
let seq = 0;
const mods = async () => ({ d: await import("@/server/pricing-data"), a: await import("@/server/audit"), db: await import("@/lib/business/db") });
function req(url: string, init: { method?: string; body?: object; headers?: Record<string, string>; cookie?: string } = {}): NextRequest {
  const headers: Record<string, string> = { host: "localhost:3000", origin: "http://localhost:3000", "x-forwarded-for": `10.4.0.${++seq % 250}`, ...(init.headers ?? {}) };
  if (init.cookie) headers.cookie = init.cookie;
  if (init.body) headers["content-type"] = "application/json";
  return new NextRequest(`http://localhost:3000${url}`, { method: init.method ?? "GET", headers, body: init.body ? JSON.stringify(init.body) : undefined });
}
const fails = async (fn: () => unknown, pattern: RegExp) => { try { await fn(); } catch (e) { assert.match((e as Error).message, pattern); return; } assert.fail(`expected an error matching ${pattern}`); };
const gbp = (over: Record<string, unknown> = {}) => ({ country: "GB", roleId: "full-stack", levelId: "mid", kind: "freelancer", min: 4000, median: 5500, max: 8000, source: "Office for National Statistics, ASHE 2025, table 14", effectiveDate: "2026-01-01", ...over });

before(() => {
  process.env.SILPI_DB_PATH = path.join(dir, "pricing.db");
  process.env.SILPI_ADMIN_TOKEN = ADMIN;
});
after(() => {
  const cached = globalThis as unknown as { silpiDb?: { close(): void } };
  cached.silpiDb?.close();
  delete cached.silpiDb;
  rmSync(dir, { recursive: true, force: true });
});

describe("1. what a fresh database starts with", () => {
  it("has the lists, and NO market rate except India's three labelled illustrative salaries", async () => {
    const { d } = await mods();
    const ref = d.listReference();
    assert.ok(ref.countries.length >= 30 && ref.countries.some((c) => c.code === "US" && c.currency === "USD") && ref.countries.some((c) => c.code === "IN"));
    assert.equal(ref.roles.length, 15, "the 14 roles in the brief and an any-role entry");
    assert.deepEqual(ref.levels.map((l) => l.id), ["junior", "mid", "senior", "expert"]);
    const rates = d.listRates();
    assert.equal(rates.length, 3);
    assert.ok(rates.every((r) => r.country === "IN" && r.kind === "employee" && r.illustrative && r.roleId === "any" && /not a market rate/i.test(r.source)));
    assert.deepEqual(rates.map((r) => [r.levelId, r.medianMinor]).sort(), [["junior", 28_846], ["mid", 72_115], ["senior", 144_231]]);
    assert.equal(rates.some((r) => r.country === "US"), false, "no rate for the USA is invented");
    assert.equal(rates.some((r) => r.levelId === "expert"), false, "and none for a level the brief gave no figure for");
  });
  it("starts with neutral settings that assume nothing about margin", async () => {
    const { d } = await mods();
    const c = d.getPricingConfig();
    assert.deepEqual([c.benchmark, c.riskAllowanceBp, c.hoursPerYear], [{ hourly: "freelancer", fixed: "agency" }, 0, 2080]);
    assert.ok(Object.values(c.billing).every((b) => b.multiplierBp === 10_000 && b.overheadBp === 0 && b.marginBp === 0));
  });
  it("prices nothing from a country until a verified row exists, and says so", async () => {
    const { d } = await mods();
    for (const country of ["US", "GB", "DE", "IN"]) {
      const r = d.rateFor({ country, roleId: "full-stack", levelId: "mid", mode: "hourly" });
      assert.deepEqual([r.ok, !r.ok && r.reason], [false, "no-rate"], country);
    }
  });
});

describe("2. the benchmark chosen for a mode, and what is charged", () => {
  it("India's illustrative wage is used only once the administrator chooses the employee benchmark, and says it bills at cost until a multiplier is set", async () => {
    const { d } = await mods();
    d.savePricingConfig({ benchmark: { hourly: "employee", fixed: "agency" } }, "admin");
    const r = d.rateFor({ country: "IN", roleId: "full-stack", levelId: "mid", mode: "hourly" });
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.deepEqual([r.currency, r.medianMinor, r.billedMinor, r.billsAtCost, r.illustrative, r.matchedRole], ["INR", 72_115, 72_115, true, true, "any"]);
    d.savePricingConfig({ billing: { employee: { multiplierBp: 25_000, overheadBp: 1_000, marginBp: 2_000 } } as never }, "admin");
    const priced = d.rateFor({ country: "IN", roleId: "backend", levelId: "mid", mode: "hourly" });
    assert.ok(priced.ok && priced.billedMinor === 237_980, "72,115 x 2.5 = 180,288 (rounded); +10% = 198,317; +20% = 237,980");
    assert.ok(priced.ok && !priced.billsAtCost);
    assert.ok(d.rateFor({ country: "IN", roleId: "backend", levelId: "expert", mode: "hourly" }).ok === false, "no figure was given for the expert level");
  });
  it("refuses settings that are out of range instead of fixing them quietly", async () => {
    const { d } = await mods();
    await fails(() => d.savePricingConfig({ benchmark: { hourly: "wizard" as never, fixed: "agency" } }, "a"), /hourly benchmark must be one of/);
    await fails(() => d.savePricingConfig({ billing: { employee: { multiplierBp: 100, overheadBp: 0, marginBp: 0 } } as never }, "a"), /cannot be below 0\.10/);
    await fails(() => d.savePricingConfig({ billing: { agency: { multiplierBp: 10_000, overheadBp: -5, marginBp: 0 } } as never }, "a"), /overhead must be a whole number/);
    await fails(() => d.savePricingConfig({ riskAllowanceBp: 9_000 }, "a"), /risk allowance/);
    await fails(() => d.savePricingConfig({ staleAfterDays: 5 }, "a"), /out of date/);
    await fails(() => d.savePricingConfig({ hoursPerYear: 10 }, "a"), /Paid hours/);
  });
});

describe("3. adding a rate", () => {
  it("keeps a verified rate with its source, the country's own currency, who entered it and when, and uses it", async () => {
    const { d, a } = await mods();
    d.savePricingConfig({ benchmark: { hourly: "freelancer", fixed: "agency" } }, "admin");
    const r = d.addRate(gbp(), "admin:sam@x.example");
    assert.deepEqual([r.currency, r.kind, r.medianMinor, r.enteredBy, r.enabled, r.illustrative], ["GBP", "freelancer", 5500, "admin:sam@x.example", true, false]);
    assert.match(r.source, /Office for National Statistics/);
    const found = d.rateFor({ country: "GB", roleId: "full-stack", levelId: "mid", mode: "hourly" });
    assert.ok(found.ok && found.billedMinor === 5500 && found.source === r.source);
    const log = a.listAudit({ action: "pricing.rate_added" })[0]!;
    assert.deepEqual([log.actor, log.detail.country, log.detail.median], ["admin:sam@x.example", "GB", 5500]);
  });
  it("refuses an unknown country, role, level or kind, a missing source, a future date, and figures out of order", async () => {
    const { d } = await mods();
    await fails(() => d.addRate(gbp({ country: "ZZ" }), "a"), /country is not in the list/);
    await fails(() => d.addRate(gbp({ roleId: "wizard" }), "a"), /role is not in the list/);
    await fails(() => d.addRate(gbp({ levelId: "god" }), "a"), /level is not in the list/);
    await fails(() => d.addRate(gbp({ kind: "charity" }), "a"), /kind of benchmark/);
    await fails(() => d.addRate(gbp({ source: "ONS" }), "a"), /where the figure comes from/);
    await fails(() => d.addRate(gbp({ effectiveDate: "2099-01-01" }), "a"), /cannot be in the future/);
    await fails(() => d.addRate(gbp({ min: 6000 }), "a"), /in order/);
    await fails(() => d.addRate(gbp({ median: 5500.5 }), "a"), /whole number/);
  });
  it("never edits a figure: a new one replaces it and the old one stays as history", async () => {
    const { d, db } = await mods();
    d.addRate(gbp({ median: 6200, max: 9000, effectiveDate: new Date().toISOString().slice(0, 10), source: "ONS ASHE 2026 provisional, table 14" }), "admin");
    const now = d.rateFor({ country: "GB", roleId: "full-stack", levelId: "mid", mode: "hourly" });
    assert.ok(now.ok && now.medianMinor === 6200, "today's figure is the newest");
    const history = d.listRates({ country: "GB" });
    assert.ok(history.length >= 2 && history.some((r) => r.medianMinor === 5500), "the old figure is still there");
    const raw = db.getDb();
    assert.throws(() => raw.prepare("UPDATE country_market_rates SET median_minor = 1 WHERE country = 'GB'").run(), /cannot be edited/);
    assert.throws(() => raw.prepare("UPDATE country_market_rates SET source = 'something else entirely' WHERE country = 'GB'").run(), /cannot be edited/);
    assert.throws(() => raw.prepare("DELETE FROM country_market_rates WHERE country = 'GB'").run(), /kept as history/);
  });
  it("lets a rate be switched off (it is then ignored) and back on, and records it", async () => {
    const { d, a } = await mods();
    const newest = d.listRates({ country: "GB" })[0]!;
    d.setRateEnabled(newest.id, false, "admin");
    const r = d.rateFor({ country: "GB", roleId: "full-stack", levelId: "mid", mode: "hourly" });
    assert.ok(r.ok && r.medianMinor === 5500, "falls back to the figure before it");
    d.setRateEnabled(newest.id, true, "admin");
    assert.equal((d.rateFor({ country: "GB", roleId: "full-stack", levelId: "mid", mode: "hourly" }) as { medianMinor: number }).medianMinor, 6200);
    assert.ok(a.listAudit({ action: "pricing.rate_switched" }).length >= 2);
    await fails(() => d.setRateEnabled(99_999, false, "a"), /does not exist/);
  });
});

describe("4. loading many rates from a spreadsheet", () => {
  const header = "country,role,level,kind,min,median,max,source,source_url,effective_date";
  it("reads amounts in the main unit exactly (45.50 pounds is 4550 pence), in all or none", async () => {
    const { d } = await mods();
    const csv = [header, 'DE,backend,senior,agency,85.50,110,150,"Statistisches Bundesamt, 2025, table 62",https://example.org/t62,2026-01-01', "JP,frontend,junior,freelancer,2500,3500,5000,Ministry survey 2025 table 9,,2026-02-01"].join("\n");
    assert.deepEqual(d.importRates(csv, "admin"), { added: 2 });
    const de = d.listRates({ country: "DE" })[0]!;
    assert.deepEqual([de.minMinor, de.medianMinor, de.maxMinor, de.currency, de.source, de.sourceUrl], [8550, 11_000, 15_000, "EUR", "Statistisches Bundesamt, 2025, table 62", "https://example.org/t62"], "a comma inside quotes stays inside the source");
    const jp = d.listRates({ country: "JP" })[0]!;
    assert.deepEqual([jp.currency, jp.minMinor, jp.maxMinor], ["JPY", 2500, 5000], "yen have no decimals");
  });
  it("adds nothing at all if any line is wrong, and names the line", async () => {
    const { d } = await mods();
    const before = d.listRates().length;
    const csv = [header, "AU,backend,mid,agency,60,80,120,Australian Bureau of Statistics 2025,,2026-01-01", "AU,backend,mid,agency,abc,80,120,Australian Bureau of Statistics 2025,,2026-01-01"].join("\n");
    await fails(() => d.importRates(csv, "a"), /Line 3: the amounts must be plain numbers/);
    await fails(() => d.importRates([header, "AU,backend,mid,agency,60,80,120,ABS,,2026-01-01"].join("\n"), "a"), /Line 2: .*where the figure comes from/);
    await fails(() => d.importRates([header, "ZZ,backend,mid,agency,60,80,120,Some survey 2025,,2026-01-01"].join("\n"), "a"), /Line 2: unknown country/);
    await fails(() => d.importRates([header, "JP,backend,mid,agency,60.5,80,120,Some survey 2025,,2026-01-01"].join("\n"), "a"), /at most 0 decimals/);
    await fails(() => d.importRates("country,role\nAU,backend", "a"), /header is missing/);
    await fails(() => d.importRates(header, "a"), /at least one row/);
    assert.equal(d.listRates().length, before, "the good first line was not kept either");
  });
});

describe("5. the lists", () => {
  it("a country, currency, role or level can be switched off for new quotations (nothing is deleted), but the any-role entry cannot", async () => {
    const { d } = await mods();
    d.setActive("country", "NP", false, "admin");
    assert.ok(!d.listReference().countries.some((c) => c.code === "NP"));
    assert.ok(d.listReference({ includeInactive: true }).countries.some((c) => c.code === "NP" && !c.active));
    d.setActive("country", "NP", true, "admin");
    await fails(() => d.setActive("role", "any", false, "a"), /cannot be switched off/);
    await fails(() => d.setActive("level", "nope", false, "a"), /does not exist/);
    d.addRole({ id: "data-engineer", label: "Data Engineer" }, "admin");
    assert.ok(d.listReference().roles.some((r) => r.id === "data-engineer"));
    await fails(() => d.addRole({ id: "data-engineer", label: "Again" }, "a"), /already a role/);
    await fails(() => d.addRole({ id: "X", label: "Bad id" }, "a"), /2 to 41 lowercase/);
  });
});

describe("6. the HTTP doors", () => {
  it("the public rate and reference routes are read only and answer plainly", async () => {
    const rate = await import("@/app/api/business/market-rate/route");
    const refRoute = await import("@/app/api/business/pricing-reference/route");
    const ok = await (await rate.GET(req("/api/business/market-rate?country=GB&role=full-stack&level=mid&mode=hourly"))).json();
    assert.deepEqual([ok.rate.ok, ok.rate.currency, ok.rate.billedMinor, ok.minorDigits], [true, "GBP", 6200, 2]);
    const none = await (await rate.GET(req("/api/business/market-rate?country=US&role=full-stack&level=mid"))).json();
    assert.deepEqual([none.rate.ok, none.rate.reason], [false, "no-rate"]);
    assert.equal((await rate.GET(req("/api/business/market-rate?country=GB&role=Bad Role&level=mid"))).status, 400);
    assert.equal("POST" in rate || "PUT" in rate || "DELETE" in rate, false, "there is no way to change a rate here");
    const reference = await (await refRoute.GET(req("/api/business/pricing-reference", { headers: { "x-vercel-ip-country": "DE" } }))).json();
    assert.deepEqual([reference.location, reference.benchmark.hourly, reference.roles.length > 10], [{ code: "DE", source: "location" }, "freelancer", true]);
    assert.equal((await (await refRoute.GET(req("/api/business/pricing-reference"))).json()).location, null, "with no header there is no guess");
  });
  it("every administrator pricing route needs the token; a viewer can look but not change; changes are written to the audit log under the person", async () => {
    const overview = await import("@/app/api/admin/pricing/route");
    const rates = await import("@/app/api/admin/pricing/rates/route");
    const importer = await import("@/app/api/admin/pricing/rates/import/route");
    const config = await import("@/app/api/admin/pricing/config/route");
    const reference = await import("@/app/api/admin/pricing/reference/route");
    const { a } = await mods();
    const anon = (fn: (r: NextRequest) => Promise<Response>, method: string) => fn(req("/api/admin/pricing", { method, body: method === "GET" ? undefined : {} }));
    for (const [fn, method] of [[overview.GET, "GET"], [rates.POST, "POST"], [rates.PUT, "PUT"], [importer.POST, "POST"], [config.PUT, "PUT"], [reference.PUT, "PUT"], [reference.POST, "POST"]] as const) assert.equal((await anon(fn, method)).status, 401, `${method} without the token`);
    const view = await (await overview.GET(req("/api/admin/pricing", { headers: admin }))).json();
    assert.ok(view.rates.length >= 5 && view.config && view.reference.countries.length >= 30 && view.rates.every((r: { source: string }) => r.source.length >= 8), "every rate shown has a source");
    const add = await rates.POST(req("/api/admin/pricing/rates", { method: "POST", headers: admin, body: gbp({ levelId: "senior", median: 8000, max: 11_000, min: 6000 }) }));
    assert.equal(add.status, 200, await add.clone().text());
    assert.equal((await rates.POST(req("/api/admin/pricing/rates", { method: "POST", headers: admin, body: gbp({ source: "" }) }))).status, 400);
    assert.equal((await config.PUT(req("/api/admin/pricing/config", { method: "PUT", headers: admin, body: { riskAllowanceBp: 500 } }))).status, 200);
    assert.equal((await config.PUT(req("/api/admin/pricing/config", { method: "PUT", headers: admin, body: { riskAllowanceBp: 9999 } }))).status, 400);
    assert.equal((await reference.PUT(req("/api/admin/pricing/reference", { method: "PUT", headers: admin, body: { kind: "country", id: "NP", active: true } }))).status, 200);
    assert.equal((await importer.POST(req("/api/admin/pricing/rates/import", { method: "POST", headers: admin, body: { csv: "x" } }))).status, 400);
    const changed = a.listAudit({ action: "pricing.config_changed" })[0]!;
    assert.ok((changed.detail.before as { riskAllowanceBp: number }).riskAllowanceBp === 0 && (changed.detail.after as { riskAllowanceBp: number }).riskAllowanceBp === 500, "the before and after are recorded");

    // a viewer account
    const accounts = await import("@/server/admin-accounts");
    const session = await import("@/app/api/admin/session/route");
    await accounts.createAdminAccount({ email: "viewer@pricing.example", name: "Viewer", password: "a-correct-horse-battery", role: "viewer" });
    const login = await session.POST(req("/api/admin/session", { method: "POST", body: { email: "viewer@pricing.example", password: "a-correct-horse-battery" } }));
    const cookie = `silpi_admin=${/silpi_admin=([^;]+)/.exec(login.headers.get("set-cookie") ?? "")![1]}`;
    assert.equal((await overview.GET(req("/api/admin/pricing", { cookie }))).status, 200, "a viewer can look");
    assert.equal((await rates.POST(req("/api/admin/pricing/rates", { method: "POST", cookie, body: gbp({ levelId: "junior" }) }))).status, 403, "but not add a rate");
    assert.equal((await config.PUT(req("/api/admin/pricing/config", { method: "PUT", cookie, body: { riskAllowanceBp: 100 } }))).status, 403, "or change the settings");
    assert.equal((await importer.POST(req("/api/admin/pricing/rates/import", { method: "POST", cookie, body: { csv: "x" } }))).status, 403);
  });
});
