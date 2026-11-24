// Hourly engagement (freelancer / consultant billing) next to the fixed-price flow.
// Run: npm test
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { buildHourlyQuote, hourlyBounds, hourlyProgress, hourlyTerms, hourlyTotal, isHourly } from "@/lib/business/hourly";
import { buildQuote } from "@/lib/business/pricing";
import { DEFAULT_RATE_CARD } from "@/lib/business/rate-card";
import type { Requirement } from "@/lib/business/types";
import { parseRequirement, ValidationError } from "@/lib/business/validate";

const rates = DEFAULT_RATE_CARD;
const TN = { state: "Tamil Nadu" };
const KA = { state: "Karnataka" };

const hourlyReq = (extra: Partial<Requirement> = {}, hourly: Partial<NonNullable<Requirement["hourly"]>> = {}): Requirement => ({
  title: "Security review",
  summary: "Review the website for security and performance problems and fix the important ones.",
  scope: "full",
  existingProject: "",
  version: "",
  projectType: "business-website",
  complexity: "standard",
  pages: [],
  modules: [],
  design: "ai",
  references: "",
  domain: { needed: false, choice: "self", name: "", tld: ".com", years: 1 },
  hosting: { needed: false, choice: "self", plan: "static", years: 1 },
  deadlineWeeks: 0,
  budget: 0,
  billing: "hourly",
  hourly: { role: "Senior developer", rate: 1000, estimatedHours: 40, rangePct: 20, cycle: "monthly", ...hourly },
  ...extra,
});

describe("hourly pricing", () => {
  it("the estimate is rate x hours, the cap is the top of the range, and GST follows the client's state", () => {
    const b = hourlyBounds({ estimatedHours: 40, rangePct: 20 });
    assert.deepEqual(b, { min: 32, expected: 40, cap: 48 });
    const q = buildHourlyQuote(hourlyReq(), TN, rates);
    assert.equal(q.subtotal, 40_000);
    assert.equal(q.discount, 0);
    assert.equal(q.gst.mode, "intra");
    assert.equal(q.grandTotal, hourlyTotal(40, 1000, TN, rates));
    assert.equal(q.hourly?.capHours, 48);
    assert.equal(q.hourly?.capTotal, hourlyTotal(48, 1000, TN, rates));
    assert.ok(q.hourly!.minTotal < q.grandTotal && q.grandTotal < q.hourly!.capTotal);
    assert.equal(buildHourlyQuote(hourlyReq(), KA, rates).gst.mode, "inter");
    assert.equal(buildHourlyQuote(hourlyReq(), { state: "Outside India" }, rates).gst.total, 0);
  });

  it("the cap is rounded up and never below the estimate; no range means cap = estimate", () => {
    assert.equal(hourlyBounds({ estimatedHours: 7, rangePct: 10 }).cap, 8);
    assert.equal(hourlyBounds({ estimatedHours: 10, rangePct: 0 }).cap, 10);
    assert.equal(hourlyTerms(hourlyReq().hourly!, TN, rates).capHours >= 40, true);
  });

  it("the advance is a share of the estimate; the balance makes up the rest", () => {
    const q = buildHourlyQuote(hourlyReq(), TN, rates);
    assert.equal(q.schedule[0].amount + q.schedule[1].amount, q.grandTotal);
    assert.equal(q.schedule[0].percent, rates.advancePercent);
  });

  it("refuses a missing rate or estimate", () => {
    assert.throws(() => buildHourlyQuote(hourlyReq({}, { rate: 0 }), TN, rates));
    assert.throws(() => buildHourlyQuote(hourlyReq({}, { estimatedHours: 0 }), TN, rates));
  });

  it("the fixed-price engine is untouched: a normal requirement has no hourly terms", () => {
    const fixed = buildQuote({ ...hourlyReq(), billing: "fixed", hourly: undefined, pages: ["Home", "Contact"] }, TN, rates);
    assert.equal(fixed.hourly, undefined);
    assert.ok(fixed.items.some((i) => i.description.startsWith("Page: ")));
    assert.equal(isHourly({ billing: "fixed" }), false);
    assert.equal(isHourly({}), false);
  });

  it("tracks hours worked against the estimate and the cap", () => {
    const t = hourlyTerms(hourlyReq().hourly!, TN, rates);
    assert.equal(hourlyProgress(t, 10).status, "on-track");
    assert.equal(hourlyProgress(t, 42).status, "near", "42 of a 48 h cap is close to the cap");
    const wide = hourlyTerms(hourlyReq({}, { rangePct: 50 }).hourly!, TN, rates);
    assert.equal(wide.capHours, 60);
    assert.equal(hourlyProgress(wide, 41).status, "above-estimate", "past the estimate, well under a wide cap");
    assert.equal(hourlyProgress(t, 40 * 1.2 * 0.85).status, "near");
    assert.equal(hourlyProgress(t, 50).status, "over");
    assert.equal(hourlyProgress(t, 50).remainingToCap, 0);
    assert.equal(hourlyProgress(t, 10).amountWorked, 10_000);
  });
});

describe("hourly validation", () => {
  it("an hourly requirement needs no pages and keeps its terms", () => {
    const r = parseRequirement(hourlyReq({ pages: [] }), rates);
    assert.equal(r.billing, "hourly");
    assert.deepEqual(r.hourly, { role: "Senior developer", rate: 1000, estimatedHours: 40, rangePct: 20, cycle: "monthly" });
  });
  it("rejects a missing rate, an impossible estimate and a missing description", () => {
    assert.throws(() => parseRequirement(hourlyReq({}, { rate: 0 }), rates), ValidationError);
    assert.throws(() => parseRequirement(hourlyReq({}, { estimatedHours: 0 }), rates), ValidationError);
    assert.throws(() => parseRequirement(hourlyReq({ summary: "short" }), rates), ValidationError);
  });
  it("unknown billing cycles and silly ranges are corrected, not trusted", () => {
    const r = parseRequirement(hourlyReq({}, { cycle: "daily" as never, rangePct: 900 }), rates);
    assert.equal(r.hourly?.cycle, "monthly");
    assert.equal(r.hourly?.rangePct, 100);
  });
  it("a fixed-price requirement without a billing field still needs pages (nothing changed)", () => {
    assert.throws(() => parseRequirement({ ...hourlyReq(), billing: undefined, hourly: undefined, pages: [] }, rates), ValidationError);
  });
});

describe("hourly engagement end to end", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "silpi-hourly-"));
  process.env.SILPI_DB_PATH = path.join(dir, "test.db");
  after(() => {
    const cached = globalThis as unknown as { silpiDb?: { close(): void } };
    cached.silpiDb?.close();
    delete cached.silpiDb;
    rmSync(dir, { recursive: true, force: true });
  });
  const client = { name: "Test", email: "t@example.com", phone: "9876543210", company: "Acme", gstin: "", state: "Tamil Nadu", address: "" };

  it("creates one quotation with no packages, shows the client the terms, and prints them", async () => {
    const store = await import("@/lib/business/store");
    const requirement = parseRequirement(hourlyReq(), store.getRateCard());
    const lead = store.createLead(client, requirement);
    const q = lead.quotation!;
    assert.equal(lead.stage, "quoted");
    assert.ok(q.hourly && q.hourly.capHours === 48);
    assert.deepEqual(q.proposals ?? [], []);
    assert.equal(q.tier, undefined);

    const reopened = store.getLead(lead.id)!;
    assert.deepEqual(reopened.quotation, q, "reopens unchanged");

    // No packages to choose, and no discount: the rate is the lever.
    assert.throws(() => store.chooseTier(lead.id, "basic"), /no packages/);
    assert.throws(() => store.requote(lead.id, 100), /rate/);
    assert.equal(store.requote(lead.id, 0).quotation?.hourly?.capHours, 48);

    const { clientView } = await import("@/lib/business/client-view");
    const view = clientView(store.getLead(lead.id)!, store.getRateCard().business)!;
    assert.equal(view.quotation.hourly?.rate, 1000);
    assert.ok(!("budgetCheck" in view.quotation) || view.quotation.budgetCheck === undefined);

    const { quotationOutline, quotationPdf, quotationDocx } = await import("@/lib/business/documents");
    const text = JSON.stringify(quotationOutline(q, reopened.requirement));
    assert.ok(/Hourly engagement terms/.test(text) && /Not to exceed/.test(text), "terms printed");
    assert.ok(!/Recommended for this project|Domain expenses/.test(text), "no website sections on an hourly quotation");
    assert.ok((await quotationPdf(q, reopened.requirement)).length > 500);
    assert.ok((await quotationDocx(q, reopened.requirement)).length > 500);
  });

  it("cost screens and the AI brief still work for an hourly project", async () => {
    const store = await import("@/lib/business/store");
    const lead = store.listLeads().find((l) => l.quotation?.hourly)!;
    const { computeLeadCosts } = await import("@/lib/business/lead-costs");
    assert.doesNotThrow(() => computeLeadCosts(lead));
    const { buildBrief } = await import("@/lib/business/brief");
    assert.doesNotThrow(() => buildBrief(lead, store.getRateCard()));
  });

  it("the team logs hours and the hourly progress follows them", async () => {
    const store = await import("@/lib/business/store");
    const lead = store.listLeads().find((l) => l.quotation?.hourly)!;
    store.setStage(lead.id, "approved");
    const logged = store.addWorkEntry(lead.id, { item: "Extra work / changes", hours: 20, note: "review", loggedOn: "2026-11-22" });
    const worked = logged.workLog.reduce((s, e) => s + e.hours, 0);
    assert.equal(hourlyProgress(logged.quotation!.hourly!, worked).status, "on-track");
    assert.equal(hourlyProgress(logged.quotation!.hourly!, worked).remainingToCap, 28);
  });
});
