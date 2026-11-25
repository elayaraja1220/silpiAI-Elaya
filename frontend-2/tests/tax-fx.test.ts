// Step 8: exchange rates (for reports only), tax rules, billing profiles, and the invoice document. Real SQLite, real services.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { NextRequest } from "next/server";

const dir = mkdtempSync(path.join(tmpdir(), "silpi-tax-"));
const ADMIN = "test-admin-token-0123456789abcdef";
const PASSWORD = "a-long-test-password";
const admin = { authorization: `Bearer ${ADMIN}` };
const T0 = Date.now();
let seq = 0;

const mods = async () => ({
  fx: await import("@/server/fx"),
  tax: await import("@/server/tax"),
  s: await import("@/server/subscriptions"),
  p: await import("@/server/payments/service"),
  f: await import("@/server/finance"),
  a: await import("@/server/audit"),
  t: await import("@/server/tenancy"),
  db: await import("@/lib/business/db"),
});
const newOrg = async () => (await mods()).t.createOrganization({ name: `Tax Org ${++seq}`, type: "business" }).id;
const fails = async (fn: () => unknown, pattern: RegExp) => { try { await fn(); } catch (e) { assert.match((e as Error).message, pattern); return; } assert.fail(`expected an error matching ${pattern}`); };
function req(url: string, init: { method?: string; body?: object; headers?: Record<string, string>; cookie?: string } = {}): NextRequest {
  const headers: Record<string, string> = { host: "localhost:3000", origin: "http://localhost:3000", "x-forwarded-for": `10.6.0.${++seq % 250}`, ...(init.headers ?? {}) };
  if (init.cookie) headers.cookie = init.cookie;
  if (init.body) headers["content-type"] = "application/json";
  return new NextRequest(`http://localhost:3000${url}`, { method: init.method ?? "GET", headers, body: init.body ? JSON.stringify(init.body) : undefined });
}
const profile = (over: Record<string, unknown> = {}) => ({ legalName: "Acme Ltd", country: "GB", addressLine1: "1 High Street", city: "London", postalCode: "N1 1AA", ...over });

before(async () => {
  process.env.SILPI_DB_PATH = path.join(dir, "tax.db");
  process.env.SILPI_ADMIN_TOKEN = ADMIN;
  delete process.env.ANTHROPIC_API_KEY;
});
after(() => {
  const cached = globalThis as unknown as { silpiDb?: { close(): void } };
  cached.silpiDb?.close();
  delete cached.silpiDb;
  rmSync(dir, { recursive: true, force: true });
});

// =================================================================================================
describe("1. exchange rates", () => {
  it("reads a rate exactly, with no floating point", async () => {
    const { fx } = await mods();
    assert.deepEqual(["83.5", "83", "0.000001", "1234567.123456", 12.5, " 7 "].map((v) => fx.parseRate(v)), [83_500_000, 83_000_000, 1, 1_234_567_123_456, 12_500_000, 7_000_000]);
    for (const bad of ["", "abc", "-1", "0", "1e3", "1,5", "83.1234567", "99999999", "0.0000001", null, undefined, NaN]) assert.throws(() => fx.parseRate(bad as never), /rate|range/, String(bad));
  });
  it("converts between currencies through the dollar, exactly, rounding half away from zero", async () => {
    const { fx } = await mods();
    const rates: Map<string, number> = new Map([["USD", 1_000_000], ["INR", 85_000_000], ["GBP", 800_000], ["JPY", 150_000_000]]);
    const c = (n: number, from: string, to: string) => fx.convertMinor(n, from, to, rates);
    assert.equal(c(1000, "USD", "INR"), 85_000, "$10.00 is Rs 850.00");
    assert.equal(c(85_000, "INR", "USD"), 1000);
    assert.equal(c(100, "USD", "JPY"), 150, "yen have no minor unit: $1.00 is 150 yen");
    assert.equal(c(150, "JPY", "USD"), 100);
    assert.equal(c(1000, "INR", "GBP"), 9, "Rs 10.00 = $0.1176 = 0.0941 GBP = 9 pence (9.41 rounds down)");
    assert.equal(c(1, "USD", "INR"), 85);
    assert.equal(c(1, "INR", "USD"), 0, "a paisa is worth under a cent");
    assert.equal(c(1000, "USD", "USD"), 1000);
    assert.equal(c(-1900, "USD", "INR"), -161_500, "negative amounts convert the same way");
    assert.equal(c(1500, "INR", "USD"), 18, "17.647 rounds up");
    assert.equal(c(5, "INR", "USD"), 0);
    const half = new Map([["USD", 1_000_000], ["XAA", 2_000_000]]);
    assert.equal(fx.convertMinor(1, "USD", "AED", new Map([["USD", 1_000_000], ["AED", 500_000]])), 1, "0.5 rounds up");
    void half;
    assert.equal(c(9_007_199_254_740, "USD", "INR"), 765_611_936_652_900, "large amounts stay exact");
  });
  it("returns nothing, never a guess, when a rate is missing", async () => {
    const { fx } = await mods();
    const rates = new Map([["USD", 1_000_000]]);
    assert.equal(fx.convertMinor(100, "USD", "INR", rates), null);
    assert.equal(fx.convertMinor(100, "INR", "USD", rates), null);
    assert.equal(fx.convertMinor(100, "INR", "INR", rates), 100, "the same currency needs no rate");
  });
  it("stores rates append-only with their source, and validates what is typed", async () => {
    const { fx, db } = await mods();
    await fails(() => fx.setRate({ currency: "XYZ", perUsd: "1", source: "a bank" }), /not a currency/);
    await fails(() => fx.setRate({ currency: "USD", perUsd: "1", source: "a bank" }), /base/);
    await fails(() => fx.setRate({ currency: "INR", perUsd: "85", source: "x" }), /where the rate comes from/);
    await fails(() => fx.setRate({ currency: "INR", perUsd: "eighty", source: "a bank" }), /plain number/);
    assert.equal(fx.listRates().length, 0, "nothing was stored");
    const r = fx.setRate({ currency: "INR", perUsd: "85.25", source: "RBI reference rate, 2026-11-25", setBy: "admin" });
    assert.deepEqual([r.currency, r.perUsdMicro, r.source], ["INR", 85_250_000, "RBI reference rate, 2026-11-25"]);
    assert.throws(() => db.getDb().prepare("UPDATE exchange_rates SET per_usd_micro = 1").run(), /append-only/);
    assert.throws(() => db.getDb().prepare("DELETE FROM exchange_rates").run(), /append-only/);
  });
  it("a rate that jumps by more than 30% is refused until confirmed, and history is kept", async () => {
    const { fx } = await mods();
    await fails(() => fx.setRate({ currency: "INR", perUsd: "8.5", source: "typo?" }), /more than 30%/);
    await fails(() => fx.setRate({ currency: "INR", perUsd: "120", source: "typo?" }), /more than 30%/);
    assert.equal(fx.listRates().find((x) => x.currency === "INR")!.perUsdMicro, 85_250_000, "unchanged");
    fx.setRate({ currency: "INR", perUsd: "86", source: "next day" });
    fx.setRate({ currency: "INR", perUsd: "8.6", source: "really, a redenomination", confirm: true });
    assert.deepEqual(fx.rateHistory("INR").map((x) => x.perUsdMicro), [8_600_000, 86_000_000, 85_250_000], "newest first");
    fx.setRate({ currency: "INR", perUsd: "85", source: "back to normal", confirm: true });
  });
  it("adds amounts in several currencies in one, lists the ones it cannot, and says how old the rates are", async () => {
    const { fx, db } = await mods();
    fx.setRate({ currency: "GBP", perUsd: "0.8", source: "bank, today" });
    const rates = fx.rateMap(db.getDb());
    const c = fx.consolidate({ USD: 1000, INR: 85_000, GBP: 800, EUR: 500, JPY: 0 }, "USD", rates, db.getDb());
    assert.deepEqual([c.total, c.missing, c.currency], [1000 + 1000 + 1000, ["EUR"], "USD"], "EUR has no rate: left out and named; JPY zero is ignored");
    assert.ok(c.ratesFrom && c.ratesFrom <= new Date().toISOString());
    assert.deepEqual(fx.consolidate({ USD: 5 }, "USD", rates, db.getDb()), { currency: "USD", total: 5, missing: [], ratesFrom: null });
  });
});

// =================================================================================================
describe("2. which tax applies", () => {
  const gross = async (orgId: string, currency: string, planId = "pro") => {
    const { s } = await mods();
    return s.startSubscription({ orgId, planId, currency, now: T0 }).invoice!;
  };

  it("behaves as before when nothing is set up: GST on rupee invoices, no tax on others", async () => {
    const inr = await gross(await newOrg(), "INR");
    assert.deepEqual([inr.subtotalPaise, inr.gstBasisPoints, inr.gstPaise, inr.taxLabel, inr.totalPaise], [149_900, 1800, 26_982, "GST", 176_882]);
    const usd = await gross(await newOrg(), "USD");
    assert.deepEqual([usd.gstBasisPoints, usd.gstPaise, usd.taxLabel, usd.totalPaise], [0, 0, "", 1900]);
  });
  it("a billing country with a rule gets that tax, in the currency the rule covers", async () => {
    const { tax } = await mods();
    tax.saveTaxRule({ country: "GB", currency: "GBP", label: "VAT", rateBasisPoints: 2000 });
    const org = await newOrg();
    tax.saveBillingProfile(org, profile());
    const inv = await gross(org, "GBP");
    assert.deepEqual([inv.subtotalPaise, inv.gstBasisPoints, inv.gstPaise, inv.taxLabel, inv.totalPaise], [1500, 2000, 300, "VAT", 1800]);
    const other = await newOrg();
    tax.saveBillingProfile(other, profile());
    assert.equal((await gross(other, "USD")).gstPaise, 0, "the rule only covers pounds, so dollars are untaxed");
  });
  it("a rule for every currency, a more specific rule beating it, and an inactive rule being ignored", async () => {
    const { tax, s } = await mods();
    s.setPlanPrice({ planId: "pro", currency: "EUR", period: "monthly", amountMinor: 1700 });
    tax.saveTaxRule({ country: "DE", label: "VAT", rateBasisPoints: 1900 });
    const org = await newOrg();
    tax.saveBillingProfile(org, profile({ country: "DE", city: "Berlin" }));
    assert.deepEqual([(await gross(org, "EUR")).gstPaise, (await gross(await orgWith("DE"), "USD")).gstPaise], [Math.round((1700 * 1900) / 10_000), Math.round((1900 * 1900) / 10_000)], "any currency");
    tax.saveTaxRule({ country: "DE", currency: "USD", label: "Special", rateBasisPoints: 500 });
    const usd = await gross(await orgWith("DE"), "USD");
    assert.deepEqual([usd.gstBasisPoints, usd.taxLabel], [500, "Special"], "the rule for that exact currency wins");
    tax.saveTaxRule({ country: "DE", currency: "USD", label: "Special", rateBasisPoints: 500, active: false });
    assert.equal((await gross(await orgWith("DE"), "USD")).gstBasisPoints, 1900, "switched off, so the general rule applies again");
    tax.saveTaxRule({ country: "DE", label: "VAT", rateBasisPoints: 1900, active: false });
    assert.equal((await gross(await orgWith("DE"), "USD")).gstPaise, 0, "no active rule: no tax");
  });
  it("Indian customers are charged GST on rupees only; a foreign billing country is not charged Indian GST", async () => {
    const { tax } = await mods();
    assert.deepEqual([(await gross(await orgWith("IN"), "INR")).taxLabel, (await gross(await orgWith("IN"), "USD")).gstPaise, (await gross(await orgWith("US"), "INR")).gstPaise], ["GST", 0, 0]);
    tax.saveTaxRule({ country: "IN", currency: "INR", label: "IGST", rateBasisPoints: 1200 });
    const inv = await gross(await orgWith("IN"), "INR");
    assert.deepEqual([inv.taxLabel, inv.gstBasisPoints], ["IGST", 1200], "an explicit rule for India replaces the built-in GST");
    tax.saveTaxRule({ country: "IN", currency: "INR", label: "IGST", rateBasisPoints: 1200, active: false });
  });
  it("credit packs are taxed the same way, and the invoice keeps its own tax afterwards", async () => {
    const { tax, p, s, db } = await mods();
    const org = await orgWith("GB");
    const order = p.createTopupOrder({ orgId: org, packageId: "pkg_100", currency: "GBP", now: T0 });
    assert.deepEqual([order.topup.gstBasisPoints, order.topup.gstMinor, order.topup.taxLabel, order.topup.totalMinor], [2000, 50, "VAT", 300]);
    const inv = await gross(org, "GBP");
    tax.saveTaxRule({ country: "GB", currency: "GBP", label: "VAT", rateBasisPoints: 500 });
    tax.saveBillingProfile(org, profile({ legalName: "Renamed Ltd", city: "Leeds" }));
    assert.deepEqual([s.getInvoice(inv.id)!.gstBasisPoints, s.getInvoice(inv.id)!.gstPaise, p.getTopup(order.topup.id)!.gstBasisPoints], [2000, 300, 2000], "raised invoices are not rewritten");
    const doc = tax.taxDocument(org, "invoice", inv.id, db.getDb())!;
    assert.equal(doc.billTo!.legalName, "Acme Ltd", "and still name the addressee they were raised to");
    assert.equal((await gross(await orgWith("GB"), "GBP", "creator")).gstBasisPoints, 500, "while a new invoice uses the new rate");
    tax.saveTaxRule({ country: "GB", currency: "GBP", label: "VAT", rateBasisPoints: 2000 });
  });
  /** An organization whose billing country is `country`. */
  async function orgWith(country: string) {
    const { tax } = await mods();
    const id = await newOrg();
    tax.saveBillingProfile(id, profile({ country, city: "Town" }));
    return id;
  }
});

// =================================================================================================
describe("3. rules and billing profiles", () => {
  it("rules are checked, and saving the same country and currency again changes the rule instead of adding one", async () => {
    const { tax } = await mods();
    await fails(() => tax.saveTaxRule({ country: "United Kingdom", label: "VAT", rateBasisPoints: 2000 }), /two-letter/);
    await fails(() => tax.saveTaxRule({ country: "FR", currency: "ZZZ", label: "VAT", rateBasisPoints: 2000 }), /supported currency/);
    await fails(() => tax.saveTaxRule({ country: "FR", label: "V", rateBasisPoints: 2000 }), /tax name/);
    for (const bad of [-1, 10_001, 20.5, "2000", null]) await fails(() => tax.saveTaxRule({ country: "FR", label: "VAT", rateBasisPoints: bad }), /basis points/);
    const first = tax.saveTaxRule({ country: "fr", label: "TVA", rateBasisPoints: 2000 });
    const again = tax.saveTaxRule({ country: "FR", label: "TVA", rateBasisPoints: 2100, note: "raised" });
    assert.deepEqual([again.id, again.country, again.rateBasisPoints, again.note], [first.id, "FR", 2100, "raised"]);
    assert.equal(tax.listTaxRules().filter((r) => r.country === "FR").length, 1);
  });
  it("a profile is saved and read back; only the format of a tax number is checked", async () => {
    const { tax } = await mods();
    const org = await newOrg();
    assert.equal(tax.getBillingProfile(org), null);
    const saved = tax.saveBillingProfile(org, profile({ country: "gb", taxId: "gb 123 4567 89", taxIdType: "vat", region: "Greater London" }), "user_1");
    assert.deepEqual([saved.country, saved.taxId, saved.taxIdType, saved.region], ["GB", "GB 123 4567 89", "VAT", "Greater London"]);
    assert.equal(tax.getBillingProfile(org)!.legalName, "Acme Ltd");
    const changed = tax.saveBillingProfile(org, profile({ legalName: "New Name Ltd", taxId: "" }));
    assert.deepEqual([changed.legalName, changed.taxId, changed.taxIdType], ["New Name Ltd", "", ""], "saving again replaces it");
  });
  it("an Indian GSTIN must have its fixed shape; other tax numbers must be plain", async () => {
    const { tax } = await mods();
    const org = await newOrg();
    assert.equal(tax.saveBillingProfile(org, profile({ country: "IN", taxId: "22AAAAA0000A1Z5" })).taxIdType, "GSTIN", "the type is filled in");
    await fails(() => tax.saveBillingProfile(org, profile({ country: "IN", taxId: "22AAAAA0000A1Z" })), /GSTIN has 15/);
    await fails(() => tax.saveBillingProfile(org, profile({ country: "IN", taxId: "not a gstin at all" })), /GSTIN has 15/);
    assert.equal(tax.saveBillingProfile(org, profile({ country: "IN", taxId: "SOMETHING-ELSE-1", taxIdType: "PAN" })).taxId, "SOMETHING-ELSE-1", "another type of number is not held to the GSTIN shape");
    await fails(() => tax.saveBillingProfile(org, profile({ country: "GB", taxId: "<script>" })), /tax number may use/);
    await fails(() => tax.saveBillingProfile(org, profile({ country: "GB", taxId: "ab" })), /tax number may use/);
  });
  it("requires who and where, refuses nonsense, and an organization that does not exist", async () => {
    const { tax } = await mods();
    const org = await newOrg();
    await fails(() => tax.saveBillingProfile(org, profile({ country: "UK1" })), /two-letter/);
    await fails(() => tax.saveBillingProfile(org, profile({ legalName: "A" })), /legal name/);
    await fails(() => tax.saveBillingProfile(org, profile({ addressLine1: "" })), /address/);
    await fails(() => tax.saveBillingProfile(org, profile({ city: "" })), /city/);
    await fails(() => tax.saveBillingProfile(org, profile({ legalName: "x".repeat(121) })), /legal name/);
    await fails(() => tax.saveBillingProfile("org_missing", profile()), /does not exist/);
    assert.equal(tax.getBillingProfile(org), null, "nothing was stored");
  });
  it("the seller's details are saved, checked, and partial updates keep the rest", async () => {
    const { tax } = await mods();
    assert.equal(tax.getSeller().legalName, "");
    tax.saveSeller({ legalName: "SILPI Technologies", address: "Chennai, India", country: "in", taxId: "33aaaaa0000a1z5", taxIdType: "gstin", email: "billing@example.com" });
    tax.saveSeller({ address: "New address" });
    assert.deepEqual(tax.getSeller(), { legalName: "SILPI Technologies", address: "New address", country: "IN", taxId: "33AAAAA0000A1Z5", taxIdType: "GSTIN", email: "billing@example.com" });
    await fails(() => tax.saveSeller({ country: "India" }), /country/);
    await fails(() => tax.saveSeller({ email: "not an email" }), /email/);
  });
});

// =================================================================================================
describe("4. the invoice document", () => {
  it("shows the seller, the addressee, the lines and the tax, adds up, and belongs to its organization only", async () => {
    const { tax, s, p, db } = await mods();
    const org = await newOrg();
    tax.saveBillingProfile(org, profile({ country: "IN", city: "Chennai", taxId: "33AAAAA0000A1Z5" }));
    const inv = s.startSubscription({ orgId: org, planId: "pro", currency: "INR", now: T0 }).invoice!;
    const doc = tax.taxDocument(org, "invoice", inv.id, db.getDb())!;
    assert.deepEqual([doc.kind, doc.number, doc.currency, doc.status, doc.taxLabel, doc.taxBasisPoints, doc.billTo!.taxId, doc.seller.legalName], ["invoice", inv.number, "INR", "open", "GST", 1800, "33AAAAA0000A1Z5", "SILPI Technologies"]);
    assert.equal(doc.lines[0]!.amountMinor - doc.discountMinor, doc.subtotalMinor, "the line less the discount is the amount taxed");
    assert.equal(doc.subtotalMinor + doc.taxMinor, doc.totalMinor);
    assert.match(doc.lines[0]!.description, /^Pro plan, \d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2}$/);
    assert.equal(tax.taxDocument(await newOrg(), "invoice", inv.id, db.getDb()), null, "another organization cannot read it");
    assert.equal(tax.taxDocument(org, "invoice", "inv_nope", db.getDb()), null);
    const order = p.createTopupOrder({ orgId: org, packageId: "pkg_250", currency: "INR", now: T0 });
    const top = tax.taxDocument(org, "topup", order.topup.id, db.getDb())!;
    assert.deepEqual([top.kind, top.number, top.lines[0]!.description, top.subtotalMinor, top.taxMinor, top.totalMinor], ["topup", order.topup.number, "Credit pack: 250 credits", 69_900, 12_582, 82_482]);
    assert.equal(tax.taxDocument(org, "topup", inv.id, db.getDb()), null, "an invoice id is not a top-up id");
  });
  it("a discount shows as the list price, the discount and the amount taxed", async () => {
    const { tax, s, db } = await mods();
    const coupons = await import("@/server/coupons");
    coupons.saveCoupon({ code: "TAX10", percentBasisPoints: 1000, duration: "once" });
    const org = await newOrg();
    const inv = s.startSubscription({ orgId: org, planId: "pro", currency: "USD", couponCode: "TAX10", now: T0 }).invoice!;
    const doc = tax.taxDocument(org, "invoice", inv.id, db.getDb())!;
    assert.deepEqual([doc.lines[0]!.amountMinor, doc.discountMinor, doc.couponCode, doc.subtotalMinor, doc.totalMinor], [1900, 190, "TAX10", 1710, 1710]);
  });
});

// =================================================================================================
describe("5. reports in one currency", () => {
  it("the finance view adds currencies up in US dollars at the entered rates, and lists the ones it has no rate for", async () => {
    const { fx, f, s, p } = await mods();
    s.setPlanPrice({ planId: "creator", currency: "EUR", period: "monthly", amountMinor: 1100 });
    const usdOrg = await newOrg();
    p.recordManualPayment({ invoiceId: s.startSubscription({ orgId: usdOrg, planId: "creator", currency: "USD", now: T0 }).invoice!.id, reference: "TAX-USD", now: T0 });
    const eurOrg = await newOrg();
    p.recordManualPayment({ invoiceId: s.startSubscription({ orgId: eurOrg, planId: "creator", currency: "EUR", now: T0 }).invoice!.id, reference: "TAX-EUR", now: T0 });
    const inrOrg = await newOrg();
    const inrInvoice = s.startSubscription({ orgId: inrOrg, planId: "creator", currency: "INR", now: T0 }).invoice!;
    p.recordManualPayment({ invoiceId: inrInvoice.id, reference: "TAX-INR", now: T0 });
    const net = (await f.financeOverview(T0 + 60_000)).revenue.thisMonth.net;
    assert.ok((net.USD ?? 0) >= 1200 && net.EUR !== undefined && net.INR !== undefined, JSON.stringify(net));
    const before = f.financeOverview(T0 + 60_000).inUsd.netThisMonth;
    assert.deepEqual(before.missing, ["EUR"], "euros have no rate yet");
    const inrUsd = Math.round(((net.INR ?? 0) * 1_000_000) / 85_000_000); // rate INR = 85 (set above), in cents: paise / 85 / 100 * 100
    assert.equal(before.total, (net.USD ?? 0) + inrUsd + 0 * (net.GBP ?? 0), "dollars as they are, rupees at the rate, euros left out");
    fx.setRate({ currency: "EUR", perUsd: "0.9", source: "bank, today" });
    const after = f.financeOverview(T0 + 60_000).inUsd.netThisMonth;
    assert.deepEqual(after.missing, []);
    assert.equal(after.total, before.total + Math.round(((net.EUR ?? 0) * 1_000_000) / 900_000));
    assert.ok(after.ratesFrom, "and it says how old the rates it used are");
  });
});

// =================================================================================================
describe("6. the HTTP doors", () => {
  async function customer(name: string, role?: string, orgId?: string) {
    const users = await import("@/app/api/admin/users/route");
    const login = await import("@/app/api/auth/login/route");
    const email = `${role ?? "owner"}@${name}.example`;
    const made = await users.POST(req("/api/admin/users", { method: "POST", headers: admin, body: orgId ? { email, name: email, password: PASSWORD, orgId, role } : { email, name: email, password: PASSWORD, newOrg: { name, type: "agency" } } }));
    assert.equal(made.status, 200, await made.clone().text());
    const org = (await made.json()).organization.id as string;
    const res = await login.POST(req("/api/auth/login", { method: "POST", body: { email, password: PASSWORD } }));
    return { org, cookie: `silpi_session=${/silpi_session=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")![1]}` };
  }
  it("the administrator's rate, tax and seller tools need the token, work, and are written to the audit log", async () => {
    const fxRoute = await import("@/app/api/admin/fx/route");
    const taxRoute = await import("@/app/api/admin/tax/route");
    const sellerRoute = await import("@/app/api/admin/seller/route");
    const { a } = await mods();
    const anon = req("/api/admin/fx", { method: "PUT", body: {} });
    assert.equal((await fxRoute.PUT(anon)).status, 401);
    assert.equal((await taxRoute.GET(req("/api/admin/tax"))).status, 401);
    assert.equal((await taxRoute.PUT(req("/api/admin/tax", { method: "PUT", body: {} }))).status, 401);
    assert.equal((await sellerRoute.GET(req("/api/admin/seller"))).status, 401);
    assert.equal((await sellerRoute.PUT(req("/api/admin/seller", { method: "PUT", body: {} }))).status, 401);
    const set = await fxRoute.PUT(req("/api/admin/fx", { method: "PUT", headers: admin, body: { currency: "AED", perUsd: "3.6725", source: "central bank, today" } }));
    assert.equal(set.status, 200, await set.clone().text());
    assert.equal((await fxRoute.PUT(req("/api/admin/fx", { method: "PUT", headers: admin, body: { currency: "AED", perUsd: "36.725", source: "typo" } }))).status, 400, "a 10x jump is refused");
    const listed = await (await fxRoute.GET(req("/api/admin/fx?currency=AED", { headers: admin }))).json();
    assert.deepEqual([listed.rates.some((r: { currency: string }) => r.currency === "AED"), listed.history.length], [true, 1]);
    assert.equal((await taxRoute.PUT(req("/api/admin/tax", { method: "PUT", headers: admin, body: { country: "AE", label: "VAT", rateBasisPoints: 500 } }))).status, 200);
    const rules = await (await taxRoute.GET(req("/api/admin/tax", { headers: admin }))).json();
    assert.ok(rules.rules.some((r: { country: string }) => r.country === "AE") && rules.gstBasisPoints === 1800);
    assert.equal((await sellerRoute.PUT(req("/api/admin/seller", { method: "PUT", headers: admin, body: { legalName: "SILPI Technologies" } }))).status, 200);
    assert.equal((await sellerRoute.PUT(req("/api/admin/seller", { method: "PUT", headers: admin, body: { email: "nope" } }))).status, 400);
    const actions = new Set(a.listAudit({ limit: 200 }).map((e) => e.action));
    for (const want of ["fx.rate_set", "tax_rule.saved", "seller.saved"]) assert.ok(actions.has(want), want);
  });
  it("a customer's own billing details: owners and admins only, their own organization only, an audit entry, and the document", async () => {
    const route = await import("@/app/api/workspace/billing/profile/route");
    const docRoute = await import("@/app/api/workspace/billing/document/route");
    const planRoute = await import("@/app/api/workspace/billing/plan/route");
    const { a } = await mods();
    const owner = await customer("profile-api");
    const viewer = await customer("profile-api", "viewer", owner.org);
    const stranger = await customer("profile-other");
    const put = (cookie: string | undefined, body: object) => route.PUT(req("/api/workspace/billing/profile", { method: "PUT", cookie, body }));
    assert.equal((await put(undefined, profile())).status, 401);
    assert.equal((await put(viewer.cookie, profile())).status, 403);
    assert.equal((await put(owner.cookie, profile({ country: "GB", taxId: "GB1234567" }))).status, 200);
    assert.equal((await put(owner.cookie, profile({ country: "IN", taxId: "bad" }))).status, 400);
    assert.equal((await route.GET(req("/api/workspace/billing/profile", { cookie: viewer.cookie }))).status, 403);
    assert.equal((await (await route.GET(req("/api/workspace/billing/profile", { cookie: owner.cookie }))).json()).profile.legalName, "Acme Ltd");
    assert.equal((await (await route.GET(req("/api/workspace/billing/profile", { cookie: stranger.cookie }))).json()).profile, null, "another organization sees nothing of it");
    const entry = a.listAudit({ action: "billing_profile.saved", orgId: owner.org })[0]!;
    assert.deepEqual([entry.detail.country, entry.detail.hasTaxId], ["GB", true]);
    assert.ok(!JSON.stringify(entry).includes("GB1234567"), "the tax number is not copied into the audit log");

    const made = await (await planRoute.POST(req("/api/workspace/billing/plan", { method: "POST", cookie: owner.cookie, body: { planId: "pro", currency: "GBP" } }))).json();
    const invoice = made.result.invoice;
    assert.deepEqual([invoice.taxLabel, invoice.gstBasisPoints], ["VAT", 2000], "the customer's own profile decides the tax");
    const get = (cookie: string, q: string) => docRoute.GET(req(`/api/workspace/billing/document?${q}`, { cookie }));
    const doc = await (await get(owner.cookie, `kind=invoice&id=${invoice.id}`)).json();
    assert.deepEqual([doc.document.number, doc.document.billTo.legalName, doc.document.totalMinor], [invoice.number, "Acme Ltd", invoice.totalPaise]);
    assert.equal((await get(stranger.cookie, `kind=invoice&id=${invoice.id}`)).status, 400, "not theirs");
    assert.equal((await get(viewer.cookie, `kind=invoice&id=${invoice.id}`)).status, 403);
    assert.equal((await get(owner.cookie, `kind=other&id=${invoice.id}`)).status, 400);
    assert.equal((await docRoute.GET(req(`/api/workspace/billing/document?kind=invoice&id=${invoice.id}`))).status, 401);
  });
});
