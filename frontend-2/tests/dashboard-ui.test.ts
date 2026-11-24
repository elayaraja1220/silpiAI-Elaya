// The requirement dashboard and the explained estimate: what each tab holds, search, grouping, paging, the step-by-step breakdown
// and the comparison of two versions. The screens only draw what these pure functions return. Run: npm test
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { itemsFromDraft, mergeInsights, summarize, type ClarificationItem, type RawDiscovered, type RawQuestion, type RawRequirement } from "@/lib/business/clarifications";
import { diffDigests, estimateBasis, moduleEffort, versionDigest } from "@/lib/business/estimate-ledger";
import { buildQuote } from "@/lib/business/pricing";
import { DEFAULT_RATE_CARD } from "@/lib/business/rate-card";
import {
  complexityOfItem, descriptionOf, documentsOf, FIRST_PAGE, filterCounts, groupItems, matchesFilter, moduleOfItem, nextCount, PAGE_STEP, priorityOfItem, searchItems, statusOf, titleOf,
  VIEW_FILTERS, visibleCount,
} from "@/lib/business/requirement-view";
import type { Quotation, Requirement, RequirementDraft } from "@/lib/business/types";
import { parseRequirement } from "@/lib/business/validate";

const rates = DEFAULT_RATE_CARD;
const TN = { state: "Tamil Nadu" };

// ---- fixtures ---------------------------------------------------------------------------------------------------------------------
const REQ = (text: string, source: string, area: string, complexity = "medium", type = "functional"): RawRequirement => ({ text, source, area, complexity, type });
const REQUIREMENTS: RawRequirement[] = [
  REQ("Visitors can browse tour packages and destinations", "2.1 Public Website", "public-website", "low"),
  REQ("Customers register and sign in with email and password", "3.1 Authentication", "authentication", "medium"),
  REQ("Agents apply for access and an administrator must approve them before sign-in", "3.2 Authentication", "authentication", "high"),
  REQ("Customers upload travel documents up to 10 MB per file", "4. Customer Portal", "documents", "medium"),
  REQ("Refunds need administrator approval and are recorded against the booking", "6. Payments and Refunds", "payments", "high"),
  REQ("Administrators can export booking and commission reports", "7. Reports", "reports", "medium"),
  REQ("Passwords are stored hashed and never shown in logs", "8.1 Security", "security", "low", "non-functional"),
];
const QUESTIONS: RawQuestion[] = [
  { question: "Which payment methods are accepted and is payment taken online?", priority: "critical", status: "unanswered", source: "Q1" },
  { question: "How is agent commission calculated and paid out?", priority: "critical", status: "unanswered", source: "Q2" },
  { question: "Which notification channels are required: email, SMS or WhatsApp?", priority: "high", status: "unanswered", source: "Q3" },
  { question: "Who is the authorised contact for approvals?", priority: "low", status: "answered", answer: "Meena, meena@example.com", source: "Q4" },
];
const DISCOVERED: RawDiscovered[] = [
  { item: "Search for destinations and packages on the public website", reason: "Visitors need to find a package quickly", source: "2.1 Public Website", impact: "medium", module: "search" },
  { item: "Daily backup of the database", reason: "The system holds payments and personal documents", source: "8. Security", impact: "low", module: "" },
];
const ASSUMPTIONS = ["Documents are limited to PDF, JPG and PNG until confirmed"];
const EXCLUDE = ["Native mobile apps are out of scope"];

function draft(extra: Partial<RequirementDraft> = {}): RequirementDraft {
  return {
    client: { name: "", email: "", phone: "", company: "", state: "Tamil Nadu" }, title: "Portal", summary: "A travel portal with public website and customer, agent and admin portals.", scope: "full", existingProject: "",
    projectType: "web-app", complexity: "standard", pages: [{ name: "Home", sections: 4, purpose: "" }], supportingPages: [], sharedComponents: [], qualityRequirements: [], externalServices: [],
    modules: ["auth", "admin-panel"], mustHave: [], design: "ai", references: "From client documents: Orchid_Requirements_v3.docx", domainName: "", needsDomain: false, needsHosting: false, deadlineWeeks: 0, clientBudget: 0,
    seoKeywords: [], technologyPreference: [], confirmed: [], missingInfo: [], assumptions: ASSUMPTIONS, questionnaire: QUESTIONS, requirements: REQUIREMENTS, discovered: DISCOVERED, exclusions: EXCLUDE, ...extra,
  };
}
const tracker = () => mergeInsights(draft()).tracker!;

describe("the tabs hold exactly what the cards count", () => {
  it("each tab's number equals the summary card it belongs to", () => {
    const items = tracker();
    const s = summarize(items, 0);
    const c = filterCounts(items);
    assert.equal(c.all, items.length);
    assert.equal(c.confirmed, s.confirmedRequirements);
    assert.equal(c.unanswered, s.unansweredQuestions);
    assert.equal(c.assumed, s.assumedRequirements);
    assert.equal(c.pending, s.pendingApproval);
    assert.equal(c.discovered, s.newlyDiscovered);
    assert.equal(c["not-applicable"], s.notApplicable);
    assert.equal(c.confirmed, REQUIREMENTS.length);
    assert.equal(c.unanswered, QUESTIONS.filter((q) => q.status === "unanswered").length);
  });
  it("every tab lists only matching items, and an answered question is only under All", () => {
    const items = tracker();
    for (const f of VIEW_FILTERS) assert.equal(items.filter((i) => matchesFilter(i, f)).length, filterCounts(items)[f]);
    const answered = items.find((i) => i.kind === "question" && i.status === "confirmed")!;
    assert.deepEqual(VIEW_FILTERS.filter((f) => matchesFilter(answered, f)), ["all"]);
    assert.equal(statusOf(answered), "Answered");
  });
  it("a decision moves an item between tabs", () => {
    const items = tracker();
    const p = items.find((i) => i.kind === "discovered")!;
    const accepted = items.map((i) => (i.id === p.id ? { ...i, status: "confirmed" as const } : i));
    assert.equal(filterCounts(accepted).confirmed, REQUIREMENTS.length + 1);
    assert.equal(filterCounts(accepted).pending, filterCounts(items).pending - 1);
    assert.equal(filterCounts(accepted).discovered, filterCounts(items).discovered, "it is still a discovered item");
    assert.equal(statusOf({ ...p, status: "confirmed" }), "Accepted");
  });
  it("excluded requirements are not applicable", () => {
    const items = itemsFromDraft({ questionnaire: [{ question: "Should native mobile apps be built?", status: "unanswered", priority: "low" }], exclusions: EXCLUDE }).items;
    assert.equal(filterCounts(items)["not-applicable"], 1);
  });
});

describe("what each row shows", () => {
  it("shows ID, title, description, source, status, priority and complexity, and nothing made up", () => {
    const items = tracker();
    const req = items.find((i) => i.text.startsWith("Agents apply"))!;
    assert.match(req.id, /^R-/);
    assert.equal(req.source, "3.2 Authentication");
    assert.equal(statusOf(req), "Confirmed");
    assert.equal(complexityOfItem(req), "high");
    assert.equal(priorityOfItem(req), "", "a requirement has no priority, it is not invented");
    const q = items.find((i) => i.kind === "question" && i.text.startsWith("How is agent commission"))!;
    assert.equal(priorityOfItem(q), "critical");
    assert.equal(complexityOfItem(q), "");
    const answered = items.find((i) => i.kind === "question" && i.status === "confirmed")!;
    assert.equal(answered.answer, "Meena, meena@example.com");
    assert.equal(priorityOfItem(answered), "", "an answered question has no open priority");
    const proposal = items.find((i) => i.kind === "discovered" && i.module === "search")!;
    assert.equal(complexityOfItem(proposal), "medium");
  });
  it("a long text gets a short title and the full text as its description; a short one has no separate description", () => {
    const long = { text: "Agents apply for access and an administrator must approve them before they can sign in to the agent portal, and rejected agents are told why" };
    assert.ok(titleOf(long).length <= 84);
    assert.equal(descriptionOf(long), long.text);
    const short = { text: "Visitors can browse packages" };
    assert.equal(titleOf(short), short.text);
    assert.equal(descriptionOf(short), "");
    assert.equal(titleOf({ text: "Do you own a domain? If so, which one and where is it registered" }), "Do you own a domain?");
  });
});

describe("requirements that differ in one word are not duplicates", () => {
  it("short sentences about different things stay separate", () => {
    const names = ["packages", "bookings", "agents", "customers", "destinations", "invoices"];
    const items = itemsFromDraft({ requirements: names.map((n) => REQ(`Administrators manage ${n}`, "5. Admin Portal", "admin-portal")) }).items;
    assert.equal(items.filter((i) => i.kind === "requirement").length, names.length);
    const views = itemsFromDraft({ requirements: [REQ("Customers can view their bookings", "4", "customer-portal"), REQ("Customers can view their payments", "4", "customer-portal"), REQ("Customers can view their documents", "4", "customer-portal")] });
    assert.equal(views.items.length, 3);
    assert.equal(views.removed, 0);
  });
  it("a template with different specifics is not collapsed (hundreds of items stay hundreds)", () => {
    const many = itemsFromDraft({ requirements: Array.from({ length: 120 }, (_, i) => REQ(`The system shall support capability number ${i} for ${["invoices", "bookings", "agents", "reports", "documents"][i % 5]} with variant${i * 13}`, `${i}`, "payments")) });
    assert.equal(many.items.length, 120);
    assert.equal(many.removed, 0);
  });
  it("the same requirement reworded is still one", () => {
    const a = "Agents apply for access and an administrator must approve them before they can sign in";
    const out = itemsFromDraft({ requirements: [REQ(a, "3.2", "authentication"), REQ(`The system must: ${a}`, "3.2 (again)", "authentication"), REQ("Agents apply for access and an administrator must approve them before they sign in", "3.2 (third)", "authentication")] });
    assert.equal(out.items.length, 1);
    assert.equal(out.removed, 2);
    assert.match(out.items[0].source ?? "", /3\.2 \(again\)/, "every place it is written is kept");
  });
});

describe("search", () => {
  it("every word typed must be found; ids, sections and answers are searched too", () => {
    const items = tracker();
    assert.equal(searchItems(items, "").length, items.length);
    const refund = searchItems(items, "refund administrator");
    assert.ok(refund.length >= 1 && refund.every((i) => /refund/i.test(i.text) && /administrator/i.test(i.text)));
    assert.ok(searchItems(items, "refund zebra").length === 0);
    assert.ok(searchItems(items, "REFUND").length >= 1, "not case sensitive");
    const byId = items[2];
    assert.deepEqual(searchItems(items, byId.id).map((i) => i.id), [byId.id]);
    assert.ok(searchItems(items, "3.2 authentication").some((i) => i.source === "3.2 Authentication"));
    assert.ok(searchItems(items, "meena").some((i) => i.kind === "question"), "the client's answer is searchable");
  });
});

describe("grouping by module and paging", () => {
  it("every item is in exactly one group, in a fixed module order, in document order inside it", () => {
    const items = tracker();
    const groups = groupItems(items);
    assert.equal(groups.reduce((n, g) => n + g.items.length, 0), items.length);
    assert.equal(new Set(groups.flatMap((g) => g.items.map((i) => i.id))).size, items.length);
    assert.equal(new Set(groups.map((g) => g.key)).size, groups.length);
    const auth = groups.find((g) => g.key === "authentication")!;
    assert.deepEqual(auth.items.filter((i) => i.kind === "requirement").map((i) => i.source), ["3.1 Authentication", "3.2 Authentication"]);
    assert.deepEqual(groupItems(items.slice().reverse()).map((g) => g.key), groups.map((g) => g.key), "the order of the groups does not depend on the order of the items");
  });
  it("items the AI did not file are put under the module their words are about", () => {
    const items = tracker();
    const by = (text: string) => items.find((i) => i.text.startsWith(text))!;
    assert.equal(moduleOfItem(by("How is agent commission")).key, "commission");
    assert.equal(moduleOfItem(by("Which payment methods")).key, "payments");
    assert.equal(moduleOfItem(by("Which notification channels")).key, "notifications");
    assert.equal(moduleOfItem(by("Search for destinations")).key, "public-website", "from the feature it would add");
    assert.equal(moduleOfItem({ ...by("Daily backup"), text: "Something unrelated to anything" }).key, "general");
  });
  it("only a few rows of a group are drawn at first and Load more adds a fixed number, never past the end", () => {
    assert.equal(visibleCount(300, undefined), FIRST_PAGE);
    assert.equal(visibleCount(3, undefined), 3);
    assert.equal(nextCount(300, undefined), FIRST_PAGE + PAGE_STEP);
    let loaded: number | undefined;
    let steps = 0;
    while (visibleCount(300, loaded) < 300) { loaded = nextCount(300, loaded); steps++; }
    assert.equal(visibleCount(300, loaded), 300);
    assert.equal(steps, Math.ceil((300 - FIRST_PAGE) / PAGE_STEP));
    assert.equal(nextCount(300, 300), 300);
  });
  it("a document with hundreds of requirements draws only a handful of rows at first", () => {
    const many: ClarificationItem[] = itemsFromDraft({
      requirements: Array.from({ length: 400 }, (_, i) => REQ(`Requirement number ${i} about ${["invoices", "bookings", "agents", "reports"][i % 4]} handling item${i} variant${i * 7}`, `${i}. Section`, ["payments", "booking", "agent-portal", "reports"][i % 4])),
    }).items;
    const groups = groupItems(many);
    const drawn = groups.reduce((n, g) => n + visibleCount(g.items.length, undefined), 0);
    assert.ok(many.length > 300);
    assert.ok(drawn <= groups.length * FIRST_PAGE);
    assert.ok(drawn < many.length / 10, `${drawn} of ${many.length} rows drawn at first`);
  });
  it("finds the source documents from the reference notes", () => {
    assert.deepEqual(documentsOf("Brand blue\nFrom client documents: a.docx, b.pdf"), ["a.docx", "b.pdf"]);
    assert.deepEqual(documentsOf("nothing here"), []);
    assert.deepEqual(documentsOf(undefined), []);
  });
});

// ---- the estimate: breakdown and version comparison ---------------------------------------------------------------------------------
const base = (): Requirement => ({
  title: "Portal", summary: "A travel portal with a public website and three role portals for a travel company.", scope: "full", existingProject: "", version: "", projectType: "web-app", complexity: "standard",
  pages: ["Home", "About Us", "Customer Dashboard", "Admin Dashboard"], pageDetails: { Home: { sections: 4, purpose: "" }, "About Us": { sections: 3, purpose: "" }, "Customer Dashboard": { sections: 4, purpose: "" }, "Admin Dashboard": { sections: 4, purpose: "" } },
  modules: ["auth", "admin-panel"], design: "ai", references: "", domain: { needed: false, choice: "self", name: "", tld: ".com", years: 1 }, hosting: { needed: false, choice: "self", plan: "static", years: 1 }, deadlineWeeks: 0, budget: 0,
});
let counter = 0;
function quotation(req: Requirement, over: Partial<Quotation> = {}, discount = 0): Quotation {
  counter += 1;
  return { ...buildQuote(req, TN, rates, discount), id: `id${counter}`, number: `Q-${counter}`, leadId: "l", createdAt: `2026-01-0${counter}T00:00:00Z`, validUntil: "", business: rates.business, client: {} as never, requirement: req, tier: "standard", ...over };
}

describe("the breakdown explains the quote it is given", () => {
  it("module hours and cost add up to the quote, and the basis shows what the hours are multiplied by", () => {
    const q = quotation(base());
    const effort = moduleEffort(q);
    assert.ok(effort.matchesQuote);
    assert.equal(effort.totalHours, q.totalHours);
    assert.equal(Math.round(effort.groups.reduce((s, g) => s + g.amount, 0) * 100) / 100, q.subtotal);
    const basis = estimateBasis(base(), rates);
    assert.equal(basis.complexityMultiplier, rates.complexity.standard.multiplier);
    assert.equal(basis.hourlyRate, rates.hourlyRate);
    // The money steps agree: taxable + GST (+ round off) = the final quotation.
    assert.equal(Math.round(q.taxable + q.gst.total), q.grandTotal);
    assert.equal(Math.round((q.subtotal - q.discount) * 100) / 100, q.taxable);
  });
});

describe("comparing two versions of the estimate", () => {
  it("a feature added shows as added, raises the amount, GST and hours, and the hours are fully explained", () => {
    const a = versionDigest(quotation(base()));
    const b = versionDigest(quotation({ ...base(), modules: ["auth", "admin-panel", "search"] }), "Decision: accepted - Search for destinations");
    const d = diffDigests(a, b);
    const total = d.totals[0];
    assert.ok(total.delta > 0 && total.to === b.totals.grandTotal && total.from === a.totals.grandTotal);
    assert.ok(d.totals.find((t) => t.what === "GST")!.delta > 0);
    assert.ok(d.totals.find((t) => t.what === "Development hours")!.delta > 0);
    assert.deepEqual(d.addedFeatures, [rates.modules.search.label]);
    assert.equal(d.removedFeatures.length, 0);
    assert.equal(d.hoursExplained, true);
    assert.ok(d.reasons[0].startsWith("Recorded reason: Decision: accepted"));
    assert.ok(d.reasons.some((r) => r.startsWith("Added ") && r.includes(rates.modules.search.label)));
    assert.equal(total.percent, Math.round(((total.to - total.from) / total.from) * 1000) / 10);
  });
  it("removing a feature and a page shows as removed with a lower amount", () => {
    const a = versionDigest(quotation(base()));
    const b = versionDigest(quotation({ ...base(), modules: ["auth"], pages: ["Home", "About Us", "Customer Dashboard"] }));
    const d = diffDigests(a, b);
    assert.ok(d.totals[0].delta < 0);
    assert.deepEqual(d.removedPages, ["Admin Dashboard"]);
    assert.ok(d.removedFeatures.length >= 1);
    assert.equal(d.hoursExplained, true);
  });
  it("a changed complexity is reported as a changed assumption that rescales the effort", () => {
    const a = versionDigest(quotation(base()));
    const b = versionDigest(quotation({ ...base(), complexity: "advanced" }));
    const d = diffDigests(a, b);
    assert.ok(d.assumptionChanges.some((c) => c.what === "Complexity" && c.from === "standard" && c.to === "advanced"));
    assert.ok(d.effortChanges.length > 0);
    assert.ok(d.reasons.some((r) => /Complexity changed from standard to advanced/.test(r)));
    assert.equal(d.hoursExplained, true);
    assert.equal(d.addedFeatures.length + d.removedFeatures.length, 0);
  });
  it("a changed number of sections on a page is reported against that page", () => {
    const more = { ...base(), pageDetails: { ...base().pageDetails, Home: { sections: 6, purpose: "" } } };
    const d = diffDigests(versionDigest(quotation(base())), versionDigest(quotation(more)));
    const home = d.effortChanges.find((c) => c.line === "Page: Home")!;
    assert.ok(home.delta > 0);
    assert.match(home.why, /4 sections to 6 sections/);
    assert.equal(d.hoursExplained, true);
  });
  it("a discount changes the amount but not the hours, and says so", () => {
    const d = diffDigests(versionDigest(quotation(base())), versionDigest(quotation(base(), {}, 5000)));
    assert.equal(d.totals.find((t) => t.what === "Development hours")!.delta, 0);
    assert.ok(d.totals[0].delta < 0);
    assert.ok(d.reasons.some((r) => /Discount changed/.test(r)));
    assert.equal(d.hoursExplained, true);
  });
  it("requirements added to the scope are listed, and identical versions say nothing changed", () => {
    const withReq = (confirmed: string[]) => quotation({ ...base(), insights: { confirmed, assumptions: [], questions: [] } });
    const d = diffDigests(versionDigest(withReq(["A"])), versionDigest(withReq(["A", "B"])));
    assert.deepEqual(d.addedRequirements, ["B"]);
    assert.deepEqual(d.removedRequirements, []);
    const q = quotation(base());
    const same = diffDigests(versionDigest(q), versionDigest(q));
    assert.deepEqual(same.reasons, ["Nothing changed between these two versions"]);
    assert.ok(same.totals.every((t) => t.delta === 0));
  });
  it("a gap in the explanation is reported instead of hidden", () => {
    const a = versionDigest(quotation(base()));
    const b = { ...versionDigest(quotation(base())), totals: { ...a.totals, hours: a.totals.hours + 8 } };
    const d = diffDigests(a, b);
    assert.equal(d.hoursExplained, false);
    assert.equal(d.unexplainedHours, 8);
  });
});

// ---- from the saved project -------------------------------------------------------------------------------------------------------------
describe("the analysis for a saved project", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "silpi-dash-"));
  process.env.SILPI_DB_PATH = path.join(dir, "test.db");
  after(() => {
    const cached = globalThis as unknown as { silpiDb?: { close(): void } };
    cached.silpiDb?.close();
    delete cached.silpiDb;
    rmSync(dir, { recursive: true, force: true });
  });

  it("carries every version, the reason each was made, and the basis; a decision adds a compared version", async () => {
    const store = await import("@/lib/business/store");
    const { leadAnalysis } = await import("@/lib/business/lead-analysis");
    const client = { name: "Test", email: "t@example.com", phone: "9876543210", company: "", gstin: "", state: "Tamil Nadu", address: "" };
    const requirement = parseRequirement(
      { title: "Portal", summary: "A travel portal with a public website and three role portals for a travel company.", scope: "full", projectType: "web-app", complexity: "standard",
        pages: ["Home", "About Us", "Customer Dashboard", "Admin Dashboard"], modules: ["auth", "admin-panel"], design: "ai",
        domain: { needed: false, choice: "self", name: "", tld: ".com", years: 1 }, hosting: { needed: false, choice: "self", plan: "static", years: 1 }, insights: mergeInsights(draft()) },
      store.getRateCard(),
    );
    const lead = store.createLead(client, requirement, "standard");
    const first = leadAnalysis(lead);
    assert.equal(first.digests.length, 1);
    assert.ok(first.basis && first.basis.hourlyRate === store.getRateCard().hourlyRate);
    assert.equal(first.team, null, "no role split is invented when the cost allocation is not set up");

    const proposal = lead.requirement.insights!.tracker!.find((i) => i.kind === "discovered" && i.module === "search")!;
    const next = store.decideInsight(lead.id, proposal.id, "accept");
    const analysis = leadAnalysis(next);
    assert.equal(analysis.digests.length, 2);
    assert.match(analysis.digests[1].note, /^Decision: accepted - Search for destinations/);
    assert.equal(analysis.digests[0].note, "", "the first quotation has no reason to give");
    const diff = diffDigests(analysis.digests[0], analysis.digests[1]);
    assert.ok(diff.totals[0].delta > 0);
    assert.equal(diff.hoursExplained, true);
    assert.ok(diff.addedRequirements.some((r) => /Search for destinations/.test(r)), "the accepted requirement is listed as added");
    assert.ok(diff.reasons.some((r) => r.startsWith("Recorded reason: Decision: accepted")));
    assert.ok(analysis.consistent, JSON.stringify(analysis.checks.filter((c) => !c.ok)));
  });
});
