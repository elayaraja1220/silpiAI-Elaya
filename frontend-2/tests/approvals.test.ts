// Quotation versions and approval records: what was agreed is frozen, an approved quotation cannot be changed, and a later change is a new version that needs approving again.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";

import { digestOf, termChanges, termsOf } from "@/lib/business/approvals";
import { MIGRATIONS } from "@/lib/business/migrations";
import { DEFAULT_RATE_CARD } from "@/lib/business/rate-card";
import type { Client, Requirement } from "@/lib/business/types";
import { parseClient, parseRequirement } from "@/lib/business/validate";

const dir = mkdtempSync(path.join(tmpdir(), "silpi-approvals-"));
const mods = async () => ({ s: await import("@/lib/business/store"), d: await import("@/server/pricing-data"), db: await import("@/lib/business/db") });
const fails = async (fn: () => unknown, pattern: RegExp) => { try { await fn(); } catch (e) { assert.match((e as Error).message, pattern); return; } assert.fail(`expected an error matching ${pattern}`); };
const base = { name: "Client", email: "c@example.com", phone: "+44 20 7946 0000", company: "", gstin: "", address: "" };
const uk = (): Client => parseClient({ ...base, state: "Outside India", country: "GB" });
const SIX = ["Home", "About Us", "Services", "Products / Portfolio", "Gallery", "Contact Us"];
const hourly = (rate = 50, hours = 40): Requirement => parseRequirement({ title: "Retainer", summary: "A senior developer for a month on the shop front end.", scope: "full", projectType: "business-website", complexity: "standard", pages: [], modules: [], design: "ai", billing: "hourly", hourly: { role: "Full-stack developer", rate: 1, rateNative: rate, estimatedHours: hours, rangePct: 20, cycle: "monthly", country: "GB", roleId: "full-stack", levelId: "mid" } }, DEFAULT_RATE_CARD);
const fixed = (): Requirement => parseRequirement({ title: "Site", summary: "A website for a small shop with six pages.", scope: "full", projectType: "business-website", pages: SIX, modules: ["contact-form"], design: "ai", domain: { needed: false, choice: "self", name: "", tld: ".com", years: 1 }, hosting: { needed: false, choice: "self", plan: "static", years: 1 }, fixedBasis: { roleId: "full-stack", levelId: "mid", country: "GB" } }, DEFAULT_RATE_CARD);
const SRC = "Test data entered for this test, 2026";

before(async () => {
  process.env.SILPI_DB_PATH = path.join(dir, "ap.db");
  const { s, d } = await mods();
  s.saveRateCard({ ...DEFAULT_RATE_CARD, countryPricing: { GBP: { hourlyRate: 25, inrPerUnit: 120, auto: false } } });
  d.addRate({ country: "GB", roleId: "full-stack", levelId: "mid", kind: "freelancer", min: 4000, median: 5500, max: 8000, source: SRC, effectiveDate: "2026-01-01" }, "test");
  d.addRate({ country: "GB", roleId: "full-stack", levelId: "mid", kind: "agency", min: 4000, median: 5500, max: 8000, source: SRC, effectiveDate: "2026-01-01" }, "test");
});
after(() => {
  const cached = globalThis as unknown as { silpiDb?: { close(): void } };
  cached.silpiDb?.close();
  delete cached.silpiDb;
  rmSync(dir, { recursive: true, force: true });
});

describe("1. versions", () => {
  it("every quotation issued is a numbered version with a fingerprint of what was written, and the reason", async () => {
    const { s, db } = await mods();
    const lead = s.createLead(uk(), hourly());
    s.requote(lead.id, 0);
    const rec = s.approvalRecord(lead.id);
    assert.deepEqual(rec.versions.map((v) => [v.versionNo, v.mode, v.currency]), [[1, "hourly", "GBP"], [2, "hourly", "GBP"]]);
    assert.equal(rec.versions[1]!.reason, "re-priced");
    const stored = db.getDb().prepare("SELECT data FROM quotations WHERE id = ?").get(rec.versions[0]!.quotationId) as { data: string };
    assert.equal(rec.versions[0]!.digest, digestOf(stored.data), "the fingerprint is of exactly the stored quotation");
    assert.equal(rec.approvals.length, 0);
    assert.equal(rec.pending, null, "nothing was approved, so nothing waits for approval");
  });
  it("the version table cannot be edited or emptied", async () => {
    const { s, db } = await mods();
    const lead = s.createLead(uk(), hourly());
    const d = db.getDb();
    assert.throws(() => d.prepare("UPDATE quotation_versions SET reason = 'x' WHERE lead_id = ?").run(lead.id), /append-only/);
    assert.throws(() => d.prepare("DELETE FROM quotation_versions WHERE lead_id = ?").run(lead.id), /append-only/);
  });
});

describe("2. approving freezes what was agreed", () => {
  it("a client's approval records who, how, when and the rate, hours, cap, tax and where the rate came from", async () => {
    const { s } = await mods();
    const lead = s.createLead(uk(), hourly(55, 40));
    const token = s.shareToken(lead.id);
    s.respondAsClient(token, { action: "approved", name: "Ann Client", message: "Go ahead" });
    const a = s.approvalRecord(lead.id).approvals[0]!;
    assert.deepEqual([a.channel, a.approvedBy, a.note, a.versionNo, a.intact], ["client-link", "client: Ann Client", "Go ahead", 1, true]);
    const t = a.terms;
    assert.deepEqual([t.mode, t.currency, t.inrPerUnit, t.tax.mode, t.tax.total], ["hourly", "GBP", 120, "export", 0]);
    assert.deepEqual([t.hourly!.role, t.hourly!.expectedHours, t.hourly!.capHours, t.hourly!.minHours], ["Full-stack developer", 40, 48, 32]);
    assert.equal(t.hourlyRate, 55 * 120, "55 pounds an hour, held in rupees");
    assert.deepEqual([t.market?.source, t.market?.kind, t.market?.effectiveDate], [SRC, "freelancer", "2026-01-01"]);
    assert.match(a.approvedAt, /^\d{4}-\d\d-\d\dT/);
  });
  it("a team approval is recorded the same way, with the person and note", async () => {
    const { s } = await mods();
    const lead = s.createLead(uk(), fixed());
    s.setStage(lead.id, "approved", "agreed on the phone", "Asha (admin)");
    const a = s.approvalRecord(lead.id).approvals[0]!;
    assert.deepEqual([a.channel, a.approvedBy, a.note, a.terms.mode, a.terms.tax.mode], ["team", "Asha (admin)", "agreed on the phone", "fixed", "export"]);
    assert.equal(a.terms.market?.kind, "agency");
    assert.ok(a.terms.scope.pages.length > 0 && a.terms.totalHours > 0);
  });
  it("the approved record cannot be edited or removed, and neither can the approved quotation", async () => {
    const { s, db } = await mods();
    const lead = s.createLead(uk(), hourly());
    s.setStage(lead.id, "approved", "ok");
    const d = db.getDb();
    const a = s.approvalRecord(lead.id).approvals[0]!;
    assert.throws(() => d.prepare("UPDATE quotation_approvals SET approved_by = 'someone else' WHERE id = ?").run(a.id), /append-only/);
    assert.throws(() => d.prepare("DELETE FROM quotation_approvals WHERE id = ?").run(a.id), /append-only/);
    assert.throws(() => d.prepare("UPDATE quotations SET data = '{}' WHERE id = ?").run(a.quotationId), /approved quotation cannot be changed/);
    assert.throws(() => d.prepare("DELETE FROM quotations WHERE id = ?").run(a.quotationId), /cannot be deleted/);
    assert.equal(s.approvalRecord(lead.id).approvals[0]!.intact, true);
  });
  it("the team cannot re-price or change an approved quotation", async () => {
    const { s } = await mods();
    const lead = s.createLead(uk(), hourly());
    s.setStage(lead.id, "approved", "ok");
    await fails(() => s.requote(lead.id, 0), /locked once approved/);
    assert.equal(s.approvalRecord(lead.id).versions.length, 1, "no new version was made");
  });
  it("a project with an approved quotation is kept for the record: it cannot be deleted", async () => {
    const { s } = await mods();
    const lead = s.createLead(uk(), hourly());
    s.setStage(lead.id, "approved", "ok");
    await fails(() => s.assertDeletable(lead.id), /kept for the record/);
    await fails(() => s.deleteLead(lead.id), /kept for the record/);
    assert.ok(s.getLead(lead.id));
    const open = s.createLead(uk(), hourly());
    s.deleteLead(open.id);
    assert.equal(s.getLead(open.id), null, "a project that was never approved can still be deleted");
  });
  it("an approval is not recorded when the approval itself is refused", async () => {
    const { s } = await mods();
    const lead = s.createLead(uk(), hourly());
    s.setStage(lead.id, "lost", "no budget");
    await fails(() => s.setStage(lead.id, "approved", "x"), /Cannot move/);
    assert.equal(s.approvalRecord(lead.id).approvals.length, 0);
  });
});

describe("3. a change after approval is a new version that needs approving again", () => {
  it("reopening and re-pricing makes version 2, says what moved against the agreed terms, and the first approval stays intact", async () => {
    const { s } = await mods();
    const lead = s.createLead(uk(), hourly(50, 40));
    s.setStage(lead.id, "approved", "ok");
    s.setStage(lead.id, "quoted", "client asked for a change");
    // The team reopens and re-prices: the approved quotation row is untouched.
    s.requote(lead.id, 0);
    const rec = s.approvalRecord(lead.id);
    assert.equal(rec.versions.length, 2);
    assert.equal(rec.approvals.length, 1);
    assert.equal(rec.approvals[0]!.intact, true, "the approved version is exactly as agreed");
    assert.deepEqual([rec.pending?.versionNo, rec.pending?.needsApproval], [2, true]);
    assert.deepEqual(rec.pending!.changes, [], "re-pricing at the same rate changes none of the agreed terms");
    s.setStage(lead.id, "approved", "approved again");
    const again = s.approvalRecord(lead.id);
    assert.deepEqual(again.approvals.map((a) => a.versionNo), [1, 2], "both approvals are kept");
    assert.equal(again.pending, null);
  });
});

describe("3b. a changed exchange rate after approval", () => {
  it("is a new version that says the currency terms moved, and the approved one keeps its own figures", async () => {
    const { s } = await mods();
    const lead = s.createLead(uk(), hourly(50, 40));
    s.setStage(lead.id, "approved", "ok");
    const agreed = s.approvalRecord(lead.id).approvals[0]!;
    s.setStage(lead.id, "quoted", "reopened");
    s.saveRateCard({ ...DEFAULT_RATE_CARD, countryPricing: { GBP: { hourlyRate: 25, inrPerUnit: 130, auto: false } } });
    try {
      s.requote(lead.id, 0);
      const rec = s.approvalRecord(lead.id);
      assert.ok(rec.pending!.changes.includes("currency"), JSON.stringify(rec.pending));
      assert.equal(rec.approvals[0]!.terms.inrPerUnit, 120, "what was agreed still says 120");
      assert.equal(rec.approvals[0]!.digest, agreed.digest);
      assert.equal(rec.approvals[0]!.intact, true);
    } finally {
      s.saveRateCard({ ...DEFAULT_RATE_CARD, countryPricing: { GBP: { hourlyRate: 25, inrPerUnit: 120, auto: false } } });
    }
  });
});

describe("3c. a scope change after approval", () => {
  it("changing the package after approval needs a reopen, makes a new version that names the scope and price it changes, and the first approval stays intact", async () => {
    const { s } = await mods();
    const lead = s.createLead(uk(), fixed());
    const tiers = (lead.quotation!.proposals ?? []).map((p) => p.tier);
    const other = tiers.find((x) => x !== lead.quotation!.tier)!;
    assert.ok(other, "there is another package to choose");
    s.setStage(lead.id, "approved", "ok");
    await fails(() => s.chooseTier(lead.id, other), /locked once approved/);
    s.setStage(lead.id, "quoted", "client wants a different package");
    s.chooseTier(lead.id, other);
    const rec = s.approvalRecord(lead.id);
    assert.equal(rec.approvals.length, 1);
    assert.equal(rec.approvals[0]!.intact, true);
    assert.equal(rec.pending?.needsApproval, true);
    assert.ok(rec.pending!.changes.includes("scope") || rec.pending!.changes.includes("price"), JSON.stringify(rec.pending));
    assert.equal(s.getLead(lead.id)!.stage, "quoted", "it is open again, not approved");
    s.setStage(lead.id, "approved", "approved the new package");
    assert.deepEqual(s.approvalRecord(lead.id).approvals.map((x) => x.versionNo), [1, 2]);
  });
});

describe("4. the terms comparison", () => {
  const t = (over: Record<string, unknown> = {}) => ({ mode: "hourly", currency: "GBP", inrPerUnit: 120, grandTotal: 1000, subtotal: 1000, discount: 0, tax: { mode: "export", rate: 0, total: 0 }, totalHours: 40, hourlyRate: 6000, scope: { tier: null, pages: ["Home"], modules: [], deferredModules: [] }, market: null, validUntil: "2026-12-31", ...over }) as Parameters<typeof termChanges>[0];
  it("reports nothing when nothing agreed has moved, and names each thing that has", () => {
    assert.deepEqual(termChanges(t(), t({ validUntil: "2027-01-31" })), [], "a new expiry date alone is not a change to what was agreed");
    assert.deepEqual(termChanges(t(), t({ grandTotal: 1200, hourlyRate: 7000 })), ["price", "hourly price"]);
    assert.deepEqual(termChanges(t(), t({ totalHours: 50 })), ["hours"]);
    assert.deepEqual(termChanges(t(), t({ tax: { mode: "inter", rate: 18, total: 5 } })), ["tax"]);
    assert.deepEqual(termChanges(t(), t({ scope: { tier: null, pages: ["Home", "About"], modules: [], deferredModules: [] } })), ["scope"]);
    assert.deepEqual(termChanges(t(), t({ currency: "USD" })), ["currency"]);
    assert.deepEqual(termChanges(t(), t({ market: { source: "x", effectiveDate: "2026-01-01", kind: "agency", currency: "GBP", riskBp: 0, illustrative: false } })), ["market rate used"]);
  });
});

describe("5. quotations that existed before approval records", () => {
  it("each gets its version and fingerprint, an earlier approval is recorded as such without inventing who made it, and the quotation is then locked", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE leads (id TEXT PRIMARY KEY, stage TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE quotations (id TEXT PRIMARY KEY, lead_id TEXT NOT NULL, number TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE stage_history (id INTEGER PRIMARY KEY AUTOINCREMENT, lead_id TEXT NOT NULL, from_stage TEXT, to_stage TEXT NOT NULL, note TEXT, at TEXT NOT NULL);`);
    const q = (id: string, lead: string, n: string, total: number) => ({ id, leadId: lead, number: n, createdAt: "2026-02-01T00:00:00.000Z", validUntil: "2026-03-01T00:00:00.000Z", grandTotal: total, subtotal: total, discount: 0, totalHours: 10, items: [{ unit: "hour", rate: 500 }], gst: { mode: "intra", rate: 18, total: 90 }, requirement: { pages: ["Home"], modules: [] } });
    db.prepare("INSERT INTO leads VALUES ('L1', 'approved', '2026-02-10'), ('L2', 'quoted', '2026-02-10')").run();
    for (const [id, lead, n, total, at] of [["Q1", "L1", "SQ-1", 100, "2026-02-01"], ["Q2", "L1", "SQ-2", 200, "2026-02-02"], ["Q3", "L2", "SQ-3", 300, "2026-02-03"]] as const) db.prepare("INSERT INTO quotations VALUES (?, ?, ?, ?, ?)").run(id, lead, n, JSON.stringify(q(id, lead, n, total)), at);
    db.prepare("INSERT INTO stage_history (lead_id, from_stage, to_stage, note, at) VALUES ('L1', 'quoted', 'approved', '', '2026-02-05T10:00:00.000Z')").run();
    MIGRATIONS.find((m) => m.id === 19)!.up(db);
    assert.deepEqual((db.prepare("SELECT lead_id, version_no, reason FROM quotation_versions ORDER BY id").all() as Record<string, unknown>[]).map((r) => [r.lead_id, r.version_no, r.reason]), [["L1", 1, "before version tracking"], ["L1", 2, "before version tracking"], ["L2", 1, "before version tracking"]]);
    const approvals = db.prepare("SELECT quotation_id, approved_by, channel, approved_at, version_no FROM quotation_approvals").all() as Record<string, unknown>[];
    assert.equal(approvals.length, 1, "only the approved lead has an approval");
    assert.deepEqual([approvals[0]!.quotation_id, approvals[0]!.channel, approvals[0]!.approved_at, approvals[0]!.version_no], ["Q2", "before-records", "2026-02-05T10:00:00.000Z", 2]);
    assert.match(String(approvals[0]!.approved_by), /unknown/);
    assert.throws(() => db.prepare("UPDATE quotations SET data = '{}' WHERE id = 'Q2'").run(), /approved quotation cannot be changed/);
    db.prepare("UPDATE quotations SET data = '{}' WHERE id = 'Q3'").run();
    db.close();
  });
});

describe("6. tampering is detected even if the database protection were bypassed", () => {
  it("an approval whose quotation no longer matches its fingerprint is reported as not intact, with the reason", async () => {
    const { s, db } = await mods();
    const lead = s.createLead(uk(), hourly());
    s.setStage(lead.id, "approved", "ok");
    const d = db.getDb();
    const id = s.approvalRecord(lead.id).approvals[0]!.quotationId;
    d.exec("DROP TRIGGER quotations_approved_no_update"); // only to prove the check; this is exactly what the trigger prevents
    d.prepare("UPDATE quotations SET data = replace(data, '\"grandTotal\"', '\"grandTotal \"') WHERE id = ?").run(id);
    const a = s.approvalRecord(lead.id).approvals[0]!;
    assert.deepEqual([a.intact, a.problem], [false, "The stored quotation no longer matches what was approved."]);
  });
});
