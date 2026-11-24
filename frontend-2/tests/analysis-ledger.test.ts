// Requirement inventory and estimate: confirmed requirements are not lost to a blank questionnaire, unanswered questions are
// split by priority and add up, proposals wait for a decision, and the estimate is explained and versioned. Run: npm test
//
// The fixtures are small invented documents shaped like a large portal brief. No counts are typed into the expectations: they
// are calculated from the fixtures, the way the code under test must calculate them from a real document.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { stableDraft } from "@/lib/business/analysis-stable";
import { estimateStatus, itemsFromDraft, mergeInsights, summarize, type RawDiscovered, type RawQuestion, type RawRequirement } from "@/lib/business/clarifications";
import { buildLeadAnalysis, compareQuotes, consistencyChecks, estimateConfidence, moduleEffort, pageRole, pageViews } from "@/lib/business/estimate-ledger";
import { buildQuote, defaultSections } from "@/lib/business/pricing";
import { DEFAULT_RATE_CARD } from "@/lib/business/rate-card";
import type { Requirement, RequirementDraft } from "@/lib/business/types";
import { parseRequirement } from "@/lib/business/validate";

const rates = DEFAULT_RATE_CARD;
const TN = { state: "Tamil Nadu" };

// ---- a document shaped like a large portal brief ---------------------------------------------------------------------------------
const REQUIREMENTS: RawRequirement[] = [
  { text: "The system is a responsive web application with a public website and customer, agent and admin portals", source: "1. Project Overview", type: "functional", area: "overview" },
  { text: "Visitors can browse destinations and tour packages on the public website", source: "2.1 Public Website", type: "functional", area: "public-website" },
  { text: "Visitors can submit an enquiry and receive a unique reference number", source: "2.2 Enquiries", type: "functional", area: "public-website" },
  { text: "Customers register with email and password and sign in securely", source: "3.1 Authentication", type: "functional", area: "authentication" },
  { text: "Customers can reset a forgotten password through an email link", source: "3.2 Authentication", type: "functional", area: "authentication" },
  { text: "Customers can view their bookings, quotations and payment history", source: "4. Customer Portal", type: "functional", area: "customer-portal" },
  { text: "Agents apply for access and stay pending until an administrator approves them", source: "5.1 Agent Portal", type: "functional", area: "agent-portal" },
  { text: "Agents see only the leads and commissions assigned to them", source: "5.2 Agent Portal", type: "functional", area: "agent-portal" },
  { text: "Administrators manage packages, destinations, bookings and users", source: "6. Admin Portal", type: "functional", area: "admin-portal" },
  { text: "A booking moves from enquiry to quotation, confirmation and completion", source: "7. Booking Workflow", type: "functional", area: "booking" },
  { text: "Payments are recorded against a booking and refunds need administrator approval", source: "8. Payments and Refunds", type: "functional", area: "payments" },
  { text: "Customers upload travel documents up to 10 MB per file", source: "9. Document Management", type: "functional", area: "documents" },
  { text: "Customers and agents receive email notifications on booking status changes", source: "10. Notifications", type: "functional", area: "notifications" },
  { text: "Administrators can export booking and commission reports", source: "11. Reports", type: "functional", area: "reports" },
  { text: "Passwords are stored hashed and never shown in screens or logs", source: "12.1 Security", type: "non-functional", area: "security" },
  { text: "Sign-in is locked temporarily after repeated failed attempts", source: "12.2 Security", type: "non-functional", area: "security" },
  { text: "Pages load in under three seconds on a normal mobile connection", source: "13. Performance", type: "non-functional", area: "acceptance" },
  { text: "Every acceptance scenario in section 14 passes before go-live", source: "14. Acceptance Criteria", type: "non-functional", area: "acceptance" },
];
const Q = (question: string, priority: string, source: string, answer = ""): RawQuestion => ({ question, answer, status: answer ? "answered" : "unanswered", priority, source, origin: "document" });
const QUESTIONNAIRE: RawQuestion[] = [
  Q("Which travel services, destinations and tour packages are needed at launch?", "critical", "Q1"),
  Q("Do registrations need administrator approval, and does this differ between customers and agents?", "critical", "Q2"),
  Q("Which staff roles are required and what can each role view or edit?", "critical", "Q3"),
  Q("Which payment methods are accepted and is payment taken online?", "critical", "Q4"),
  Q("How is a payment confirmed and what are the refund rules?", "critical", "Q5"),
  Q("How is agent commission calculated and paid out?", "critical", "Q6"),
  Q("Which document formats and categories are accepted and for how long are they kept?", "high", "Q7"),
  Q("Which notification channels are required: email, SMS or WhatsApp?", "critical", "Q8"),
  Q("Must users verify their email address or mobile number at registration?", "medium", "Q9"),
  Q("Are external reservation systems, airlines or hotel suppliers connected?", "critical", "Q10"),
  Q("Will the client provide the text of the privacy policy and terms?", "low", "Q11"),
  Q("What is the expected number of users and bookings per month?", "medium", "Q12"),
  Q("Who is the authorised contact for approvals?", "low", "Q13"),
  Q("What is the target launch date and the budget range?", "high", "Q14"),
];
const DISCOVERED: RawDiscovered[] = [
  { item: "Search for destinations and packages on the public website", reason: "Visitors browsing many packages need to find one quickly", source: "2.1 Public Website", impact: "medium", module: "search" },
  { item: "Customers can print or download a booking invoice", reason: "Payments are recorded but no invoice is described", source: "8. Payments and Refunds", impact: "low", module: "" },
  { item: "Daily backup of the database", reason: "The system holds payments and personal documents", source: "12. Security", impact: "low", module: "" },
];
const ASSUMPTIONS = ["Documents are limited to PDF, JPG and PNG until the business confirms", "Staff record payments until the payment method is confirmed", "Enquiry notifications go by email only until channels are confirmed"];

function draft(extra: Partial<RequirementDraft> = {}): RequirementDraft {
  return {
    client: { name: "", email: "", phone: "", company: "", state: "Tamil Nadu" },
    title: "Travel portal", summary: "A travel web application with public website and customer, agent and admin portals.", scope: "full", existingProject: "",
    projectType: "web-app", complexity: "advanced",
    pages: [{ name: "Home", sections: 4, purpose: "" }, { name: "Customer Dashboard", sections: 4, purpose: "" }, { name: "Agent Dashboard", sections: 4, purpose: "" }, { name: "Admin Dashboard", sections: 4, purpose: "" }],
    supportingPages: [], sharedComponents: [], qualityRequirements: [], externalServices: [], modules: ["auth", "admin-panel", "booking"], mustHave: [], design: "ai", references: "",
    domainName: "", needsDomain: false, needsHosting: false, deadlineWeeks: 0, clientBudget: 0, seoKeywords: [], technologyPreference: [],
    confirmed: [], missingInfo: [], assumptions: ASSUMPTIONS, questionnaire: QUESTIONNAIRE, requirements: REQUIREMENTS, discovered: DISCOVERED, exclusions: [], ...extra,
  };
}

const sectionsFor = (page: string) => defaultSections(page, rates);

describe("confirmed requirements are not lost to a blank questionnaire", () => {
  it("every stated requirement is confirmed even though all questionnaire responses are blank", () => {
    const insights = mergeInsights(draft());
    const s = summarize(insights.tracker!, insights.confirmed.length, insights.lastChange);
    assert.equal(s.confirmedRequirements, REQUIREMENTS.length);
    assert.equal(insights.confirmed.length, REQUIREMENTS.length);
    assert.equal(s.functionalRequirements, REQUIREMENTS.filter((r) => r.type === "functional").length);
    assert.equal(s.nonFunctionalRequirements, REQUIREMENTS.filter((r) => r.type === "non-functional").length);
    assert.equal(s.unansweredQuestions, QUESTIONNAIRE.length);
    // A blank questionnaire does not turn requirements into questions.
    assert.equal(s.totalQuestions, QUESTIONNAIRE.length);
  });
  it("each requirement keeps the place in the document it came from", () => {
    const items = itemsFromDraft(draft()).items.filter((i) => i.kind === "requirement");
    for (const r of REQUIREMENTS) assert.equal(items.find((i) => i.text === r.text)?.source, r.source);
  });
  it("two requirements that differ are not merged; the same one worded twice is", () => {
    const twice = itemsFromDraft({ requirements: [...REQUIREMENTS, { text: "Visitors can submit an enquiry and get a unique reference number", source: "2.2 Enquiries (again)" }] });
    assert.equal(twice.items.filter((i) => i.kind === "requirement").length, REQUIREMENTS.length);
    assert.equal(twice.removed, 1);
    assert.match(twice.items.find((i) => /unique reference/.test(i.text))!.source ?? "", /2\.2 Enquiries \(again\)/);
  });
  it("a requirement the readings word differently is still kept (a majority vote on wording used to drop them all)", () => {
    const reworded = (n: number) => REQUIREMENTS.map((r, i) => ({ ...r, text: i % 3 === n ? `The system must: ${r.text}` : r.text }));
    const runs = [draft({ requirements: REQUIREMENTS }), draft({ requirements: reworded(1) }), draft({ requirements: reworded(2) })];
    const out = stableDraft(runs, sectionsFor);
    assert.equal(out.requirements!.length, REQUIREMENTS.length);
    assert.equal(out.confirmed.length, REQUIREMENTS.length);
    assert.deepEqual(stableDraft([runs[2], runs[0], runs[1]], sectionsFor).requirements, out.requirements, "the order of the readings does not matter");
  });
});

describe("unanswered questions by priority", () => {
  it("critical + non-critical = total unanswered, whatever the mix", () => {
    const s = summarize(mergeInsights(draft()).tracker!, 0);
    const critical = QUESTIONNAIRE.filter((q) => q.priority === "critical").length;
    assert.equal(s.criticalUnanswered, critical);
    assert.equal(s.nonCriticalUnanswered, QUESTIONNAIRE.length - critical);
    assert.equal(s.unansweredQuestions, s.criticalUnanswered + s.nonCriticalUnanswered);
    assert.equal(s.unansweredQuestions, s.unansweredByPriority.critical + s.unansweredByPriority.high + s.unansweredByPriority.medium + s.unansweredByPriority.low);
  });
  it("answering a question lowers the right count", () => {
    const first = mergeInsights(draft());
    const answered = QUESTIONNAIRE.map((q, i) => (i === 0 ? { ...q, answer: "Domestic and Southeast Asia packages", status: "answered" } : q));
    const s = summarize(mergeInsights(draft({ questionnaire: answered }), first).tracker!, 0);
    assert.equal(s.criticalUnanswered, QUESTIONNAIRE.filter((q) => q.priority === "critical").length - 1);
    assert.equal(s.answeredQuestions, 1);
  });
  it("an unknown priority is medium, never silently critical", () => {
    const items = itemsFromDraft({ questionnaire: [{ question: "Preferred font?", priority: "urgent!!", status: "unanswered" }] }).items;
    assert.equal(items[0].priority, "medium");
  });
});

describe("newly discovered requirements are proposals, not scope", () => {
  it("they are listed with reason, source, impact and a pending status, and are not counted as confirmed", () => {
    const insights = mergeInsights(draft());
    const proposals = insights.tracker!.filter((i) => i.kind === "discovered");
    assert.equal(proposals.length, DISCOVERED.length);
    for (const p of proposals) {
      assert.equal(p.status, "pending-approval");
      assert.ok(p.reason && p.source && p.impact);
    }
    assert.equal(summarize(insights.tracker!, insights.confirmed.length).confirmedRequirements, REQUIREMENTS.length);
    assert.ok(!insights.confirmed.some((c) => DISCOVERED.some((d) => d.item === c)));
  });
  it("a gap the document already states is a duplicate, not a discovery", () => {
    const out = itemsFromDraft({ requirements: REQUIREMENTS, discovered: [{ item: "Customers can reset a forgotten password by email link", reason: "x", source: "3.2" }] });
    assert.equal(out.items.filter((i) => i.kind === "discovered").length, 0);
    assert.equal(out.removed, 1);
  });
  it("a decision made by the team is never undone by a revised document", () => {
    const first = mergeInsights(draft());
    const id = first.tracker!.find((i) => i.kind === "discovered")!.id;
    const decided = { ...first, tracker: first.tracker!.map((i) => (i.id === id ? { ...i, status: "rejected" as const } : i)) };
    const again = mergeInsights(draft(), decided);
    assert.equal(again.tracker!.find((i) => i.id === id)!.status, "rejected");
    assert.equal(again.tracker!.filter((i) => i.kind === "discovered").length, DISCOVERED.length, "not added a second time");
  });
});

describe("a preliminary estimate stays preliminary until the approvals are done", () => {
  it("blocked by critical questions, undecided proposals and unapproved assumptions", () => {
    const items = mergeInsights(draft()).tracker!;
    const status = estimateStatus(items);
    assert.equal(status.level, "preliminary");
    assert.equal(status.blockers.criticalQuestions, QUESTIONNAIRE.filter((q) => q.priority === "critical").length);
    assert.equal(status.blockers.proposals, DISCOVERED.length);
    assert.equal(status.blockers.assumptions, ASSUMPTIONS.length);
    assert.equal(status.reasons.length, status.blockers.criticalQuestions + status.blockers.proposals + status.blockers.assumptions);
  });
  it("is validated only when none of them is open (non-critical questions do not block)", () => {
    const answered = QUESTIONNAIRE.map((q) => (q.priority === "critical" ? { ...q, answer: "Confirmed with the client", status: "answered" } : q));
    const items = itemsFromDraft(draft({ questionnaire: answered, discovered: [], assumptions: [] })).items;
    assert.equal(estimateStatus(items).level, "validated");
    assert.ok(summarize(items, 0).unansweredQuestions > 0);
  });
});

describe("page counts", () => {
  it("role-specific views of one page are not unique pages", () => {
    const v = pageViews(["Home", "Admin Dashboard", "Agent Dashboard", "Customer Dashboard", "Admin Sign In", "Agent Bookings", "My Bookings", "Booking Management"]);
    assert.equal(v.listed, 8);
    assert.equal(v.unique + v.roleSpecificViews, v.listed);
    assert.equal(v.shared.find((s) => /dashboard/i.test(s.page))?.roles.length, 3);
    assert.ok(v.unique < v.listed);
    assert.equal(pageRole("Admin Dashboard"), "admin");
    assert.equal(pageRole("My Bookings"), "customer");
    assert.equal(pageRole("About Us"), "public");
  });
});

describe("module-wise effort supports the development hours", () => {
  const requirement = (): Requirement => ({
    title: "Portal", summary: "A travel portal with a public website and three role portals for a travel company.", scope: "full", existingProject: "", version: "", projectType: "web-app", complexity: "standard",
    pages: ["Home", "About Us", "Customer Dashboard", "Agent Dashboard", "Admin Dashboard"], pageDetails: {}, modules: ["auth", "admin-panel", "booking"], design: "ai", references: "",
    domain: { needed: false, choice: "self", name: "", tld: ".com", years: 1 }, hosting: { needed: false, choice: "self", plan: "static", years: 1 }, deadlineWeeks: 0, budget: 0,
  });
  it("the groups add up to the quote's hours and amount", () => {
    const quote = buildQuote(requirement(), TN, rates);
    const effort = moduleEffort(quote);
    assert.ok(effort.matchesQuote);
    assert.equal(effort.totalHours, quote.totalHours);
    assert.equal(Math.round(effort.groups.reduce((s, g) => s + g.amount, 0) * 100) / 100, quote.subtotal);
    assert.ok(effort.groups.some((g) => g.group === "Customer portal pages") && effort.groups.some((g) => g.group.startsWith("Feature:")));
  });
  it("a changed scope changes the effort and the reasons say what was added", () => {
    const a = { ...buildQuote(requirement(), TN, rates), id: "1", number: "Q1", leadId: "l", createdAt: "2026-01-01T00:00:00Z", validUntil: "", business: rates.business, client: {} as never } as never as Parameters<typeof compareQuotes>[0];
    const b = { ...buildQuote({ ...requirement(), modules: ["auth", "admin-panel", "booking", "search"] }, TN, rates), id: "2", number: "Q2", leadId: "l", createdAt: "2026-01-02T00:00:00Z", validUntil: "", business: rates.business, client: {} as never } as never as Parameters<typeof compareQuotes>[0];
    const diff = compareQuotes(a, b);
    assert.ok(diff.changes.some((c) => c.what === "Development hours" && c.to > c.from));
    assert.ok(diff.changes.some((c) => c.what === "GST" && c.to > c.from));
    assert.ok(diff.changes.some((c) => c.what === "Grand total"));
    assert.ok(diff.reasons.some((r) => r.startsWith("Added:") && r.includes(rates.modules.search.label)));
    assert.deepEqual(compareQuotes(a, a), { changes: [], reasons: [] });
  });
});

describe("confidence and consistency", () => {
  it("confidence falls as more is open and is unknown without an analysis", () => {
    const open = mergeInsights(draft()).tracker!;
    const answeredAll = itemsFromDraft(draft({ questionnaire: QUESTIONNAIRE.map((q) => ({ ...q, answer: "ok", status: "answered" })), discovered: [], assumptions: [] })).items;
    assert.ok(estimateConfidence(answeredAll).score > estimateConfidence(open).score);
    assert.equal(estimateConfidence(answeredAll).level, "high");
    assert.equal(estimateConfidence([]).level, "unknown");
    assert.ok(estimateConfidence(open).reasons.length > 0);
  });
  it("every check passes for a consistent analysis, and a broken one is caught", () => {
    const insights = mergeInsights(draft());
    const ok = consistencyChecks({ items: insights.tracker!, confirmedLines: insights.confirmed.length, confirmedTexts: insights.confirmed, pages: ["Home", "Admin Dashboard", "Agent Dashboard"] });
    assert.ok(ok.every((c) => c.ok), JSON.stringify(ok.filter((c) => !c.ok)));
    // A proposal that is still pending but listed among the confirmed requirements.
    const pending = insights.tracker!.find((i) => i.kind === "discovered")!;
    const leaked = consistencyChecks({ items: insights.tracker!, confirmedLines: insights.confirmed.length + 1, confirmedTexts: [...insights.confirmed, pending.text], pages: [] });
    assert.equal(leaked.find((c) => c.id === "pending-not-confirmed")!.ok, false);
    assert.equal(leaked.find((c) => c.id === "confirmed-count")!.ok, false);
    // A duplicate left in the list.
    const dup = consistencyChecks({ items: [...insights.tracker!, { ...insights.tracker![0], id: "R-dup0001" }], confirmedLines: insights.confirmed.length, confirmedTexts: insights.confirmed, pages: [] });
    assert.equal(dup.find((c) => c.id === "no-duplicates")!.ok, false);
    // Approved while approvals were still open.
    const early = consistencyChecks({ items: insights.tracker!, confirmedLines: insights.confirmed.length, confirmedTexts: insights.confirmed, pages: [], stage: "approved" });
    assert.equal(early.find((c) => c.id === "final-blocked")!.ok, false);
  });
});

// ---- the saved project: decisions, repricing, history, and the approval gate -------------------------------------------------------
describe("decisions on proposals, repricing and the approval gate", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "silpi-ledger-"));
  process.env.SILPI_DB_PATH = path.join(dir, "test.db");
  after(() => {
    const cached = globalThis as unknown as { silpiDb?: { close(): void } };
    cached.silpiDb?.close();
    delete cached.silpiDb;
    rmSync(dir, { recursive: true, force: true });
  });
  const client = { name: "Test", email: "t@example.com", phone: "9876543210", company: "", gstin: "", state: "Tamil Nadu", address: "" };

  async function newLead(d: Partial<RequirementDraft>) {
    const store = await import("@/lib/business/store");
    const insights = mergeInsights(draft(d));
    const requirement = parseRequirement(
      {
        title: "Portal", summary: "A travel portal with a public website and three role portals for a travel company.", scope: "full", projectType: "web-app", complexity: "standard",
        pages: ["Home", "About Us", "Customer Dashboard", "Admin Dashboard"], modules: ["auth", "admin-panel"], design: "ai",
        domain: { needed: false, choice: "self", name: "", tld: ".com", years: 1 }, hosting: { needed: false, choice: "self", plan: "static", years: 1 }, insights,
      },
      store.getRateCard(),
    );
    return { store, lead: store.createLead(client, requirement, "standard") };
  }

  it("the whole tracker is saved and comes back", async () => {
    const { store, lead } = await newLead({});
    assert.equal(lead.requirement.insights!.tracker!.length, itemsFromDraft(draft()).items.length);
    assert.equal(lead.requirement.insights!.confirmed.length, REQUIREMENTS.length);
    assert.deepEqual(store.getLead(lead.id)!.requirement.insights, lead.requirement.insights);
  });

  it("a preliminary estimate cannot be approved, by the team or by the client", async () => {
    const { store, lead } = await newLead({});
    assert.throws(() => store.setStage(lead.id, "approved"), /preliminary estimate/);
    const token = store.shareToken(lead.id);
    assert.throws(() => store.respondAsClient(token, { action: "approved", name: "Client", message: "" }), /preliminary estimate/);
    // Asking for changes is still allowed.
    store.respondAsClient(token, { action: "changes_requested", name: "Client", message: "Please add a few things" });
    const { clientView } = await import("@/lib/business/client-view");
    assert.equal(clientView(store.getLead(lead.id)!, store.getRateCard().business)!.preliminary, true);
  });

  it("accepting a proposal that maps to a feature adds it, prices the quotation again and keeps the old version", async () => {
    const { store, lead } = await newLead({});
    const proposal = lead.requirement.insights!.tracker!.find((i) => i.kind === "discovered" && i.module === "search")!;
    assert.ok(!lead.requirement.modules.includes("search"));
    const accepted = store.decideInsight(lead.id, proposal.id, "accept");
    assert.ok(accepted.requirement.modules.includes("search"));
    assert.equal(accepted.requirement.insights!.tracker!.find((i) => i.id === proposal.id)!.status, "confirmed");
    assert.ok(accepted.requirement.insights!.confirmed.includes(proposal.text), "accepted proposals join the confirmed list");
    const versions = store.quotationVersions(lead.id);
    assert.equal(versions.length, 2);
    assert.ok(versions[1].totalHours > versions[0].totalHours);
    assert.ok(versions[1].gst.total > versions[0].gst.total);
    assert.equal(versions[0].number, lead.quotation!.number, "the earlier version is unchanged");

    const analysis = buildLeadAnalysis({ requirement: accepted.requirement, quotation: accepted.quotation, versionsOldestFirst: versions, stage: accepted.stage });
    assert.equal(analysis.versions.length, 2);
    assert.ok(analysis.versions[1].reasons.some((r) => r.startsWith("Added:")));
    assert.ok(analysis.consistent, JSON.stringify(analysis.checks.filter((c) => !c.ok)));
    assert.equal(analysis.summary.discoveredAccepted, 1);
    assert.equal(analysis.summary.confirmedRequirements, REQUIREMENTS.length + 1);

    // Turning it down later takes the feature out again and prices a third version.
    const rejected = store.decideInsight(lead.id, proposal.id, "reject");
    assert.ok(!rejected.requirement.modules.includes("search"));
    const after3 = store.quotationVersions(lead.id);
    assert.equal(after3.length, 3);
    assert.equal(after3[2].totalHours, after3[0].totalHours);
    assert.ok(!rejected.requirement.insights!.confirmed.includes(proposal.text));
  });

  it("a decision with no feature behind it saves the decision without a new quotation", async () => {
    const { store, lead } = await newLead({});
    const proposal = lead.requirement.insights!.tracker!.find((i) => i.kind === "discovered" && !i.module)!;
    const marked = store.decideInsight(lead.id, proposal.id, "clarify");
    assert.equal(marked.requirement.insights!.tracker!.find((i) => i.id === proposal.id)!.status, "needs-clarification");
    assert.equal(store.quotationVersions(lead.id).length, 1);
    assert.equal(estimateStatus(marked.requirement.insights!.tracker!).blockers.proposals, DISCOVERED.length, "still waiting for the client");
    assert.throws(() => store.decideInsight(lead.id, "nope", "accept"), /not found/);
    const question = lead.requirement.insights!.tracker!.find((i) => i.kind === "question")!;
    assert.throws(() => store.decideInsight(lead.id, question.id, "accept"), /you can only start without it/);
  });

  it("deferred items are left out of the price, shown to the client, and must be acknowledged before approving", async () => {
    const { store, lead } = await newLead({});
    const { clientView } = await import("@/lib/business/client-view");
    const { deferredTexts } = await import("@/lib/business/clarifications");
    let current = lead;
    // Set every blocker aside: critical questions, proposals and assumptions.
    for (const i of lead.requirement.insights!.tracker!) {
      const open = (i.kind === "question" && i.status === "unanswered" && i.priority === "critical") || (i.kind !== "question" && i.kind !== "requirement" && i.status === "pending-approval");
      if (open) current = store.decideInsight(lead.id, i.id, "defer");
    }
    const tracker = current.requirement.insights!.tracker!;
    const status = estimateStatus(tracker);
    assert.equal(status.level, "validated", "deferred items do not block a final quotation");
    assert.ok(status.deferred.length > 0);
    assert.equal(status.label, "Final for the confirmed scope");
    assert.equal(store.quotationVersions(lead.id).length, 1, "deferring a gap with no feature behind it does not change the price");

    // The client is told what is not in the price.
    const view = clientView(current, store.getRateCard().business)!;
    assert.deepEqual(view.deferred, deferredTexts(tracker));
    assert.ok(!view.preliminary);

    // Approving without acknowledging is refused; acknowledging records exactly what the client was told.
    const token = store.shareToken(lead.id);
    assert.throws(() => store.respondAsClient(token, { action: "approved", name: "Client", message: "" }), /not included in this price/);
    const done = store.respondAsClient(token, { action: "approved", name: "Client", message: "", acknowledgeDeferred: true });
    assert.deepEqual(done.clientResponse!.acknowledgedDeferred, deferredTexts(tracker));

    // A deferred question can be put back until the quotation is approved; once approved it is locked.
    assert.throws(() => store.decideInsight(lead.id, tracker.find((i) => i.status === "deferred")!.id, "reset"), /locked/);
  });

  it("a deferred question goes back to unanswered when undone, and is listed in the Deferred tab", async () => {
    const { store, lead } = await newLead({});
    const { matchesFilter } = await import("@/lib/business/requirement-view");
    const question = lead.requirement.insights!.tracker!.find((i) => i.kind === "question" && i.status === "unanswered" && i.priority === "critical")!;
    const deferred = store.decideInsight(lead.id, question.id, "defer");
    const item = deferred.requirement.insights!.tracker!.find((i) => i.id === question.id)!;
    assert.equal(item.status, "deferred");
    assert.ok(matchesFilter(item, "deferred"));
    assert.ok(!matchesFilter(item, "unanswered"));
    const back = store.decideInsight(lead.id, question.id, "reset");
    assert.equal(back.requirement.insights!.tracker!.find((i) => i.id === question.id)!.status, "unanswered");
  });

  it("once every required approval is done the quotation can be approved", async () => {
    // Nothing critical is open; one proposal is waiting.
    const answered = QUESTIONNAIRE.map((q) => (q.priority === "critical" ? { ...q, answer: "Confirmed", status: "answered" } : q));
    const { store, lead } = await newLead({ questionnaire: answered, assumptions: [] });
    assert.equal(estimateStatus(lead.requirement.insights!.tracker!).level, "preliminary");
    assert.throws(() => store.setStage(lead.id, "approved"), /new requirement/);
    let current = lead;
    for (const p of lead.requirement.insights!.tracker!.filter((i) => i.kind === "discovered")) current = store.decideInsight(lead.id, p.id, "reject");
    assert.equal(estimateStatus(current.requirement.insights!.tracker!).level, "validated");
    assert.equal(store.setStage(lead.id, "approved").stage, "approved");
  });
});
