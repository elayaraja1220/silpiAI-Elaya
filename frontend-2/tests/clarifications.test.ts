// Clarification questions are tracked, not guessed: answered questions are not "unanswered", duplicates are one, and a revised
// document updates the answers. Run: npm test
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { stableDraft } from "@/lib/business/analysis-stable";
import {
  applyKnowledge,
  consensus,
  dedupe,
  estimateStatus,
  itemsFromDraft,
  legacyLists,
  mergeInsights,
  parseItems,
  reconcile,
  similarity,
  summarize,
  type RawQuestion,
} from "@/lib/business/clarifications";
import { defaultSections } from "@/lib/business/pricing";
import { DEFAULT_RATE_CARD } from "@/lib/business/rate-card";
import type { RequirementDraft } from "@/lib/business/types";
import { parseRequirement } from "@/lib/business/validate";

/** The 14 questions of a client clarification questionnaire. Calculated, never hardcoded, by the code under test. */
const QUESTIONS = [
  "Do you already own a domain name, and if so which one?",
  "Which hosting provider do you want to use?",
  "Should the website support Tamil and English languages?",
  "Do you have a logo and brand colours?",
  "Who will supply the page content and the product photos?",
  "Which payment gateway should be used for online payments?",
  "Will customers need to create an account and log in?",
  "What is the expected launch deadline?",
  "What is your maximum budget?",
  "How many products will be listed at launch?",
  "Do you need an admin panel to manage orders?",
  "Should the contact form send emails to your address?",
  "Do you need ongoing maintenance and support after launch?",
  "Do you want a blog or news section?",
];
const ANSWERS = [
  "Yes, murugantex.in",
  "We will use our own server",
  "Both Tamil and English",
  "Yes, we will send the logo; colours are blue and gold",
  "We will give the content and the photos",
  "Razorpay",
  "Yes, with email and password",
  "Within 6 weeks, before Diwali",
  "Rs 80,000",
  "About 120 products",
  "Yes, to see orders and update stock",
  "Yes, to orders@murugantex.in",
  "Yes, a yearly maintenance plan",
  "No blog is needed",
];

const asked = (answers: (string | null)[] = []): RawQuestion[] =>
  QUESTIONS.map((question, i) => ({ question, answer: answers[i] ?? "", status: answers[i] ? "answered" : "unanswered", critical: i < 9, origin: "document" }));

function draft(extra: Partial<RequirementDraft> = {}): RequirementDraft {
  return {
    client: { name: "", email: "", phone: "", company: "", state: "Tamil Nadu" },
    title: "Murugan Textiles store",
    summary: "An online store for sarees.",
    scope: "full",
    existingProject: "",
    projectType: "ecommerce",
    complexity: "standard",
    pages: [{ name: "Home", sections: 4, purpose: "" }, { name: "Products", sections: 4, purpose: "" }],
    supportingPages: [],
    sharedComponents: [],
    qualityRequirements: [],
    externalServices: [],
    modules: [],
    mustHave: [],
    design: "ai",
    references: "",
    domainName: "",
    needsDomain: false,
    needsHosting: false,
    deadlineWeeks: 0,
    clientBudget: 0,
    seoKeywords: [],
    technologyPreference: [],
    confirmed: ["Online store for sarees"],
    missingInfo: [],
    assumptions: [],
    ...extra,
  };
}

const unanswered = (items: { kind: string; status: string }[]) => items.filter((i) => i.kind === "question" && i.status === "unanswered").length;

describe("meaning of a question", () => {
  it("the same question in other words is the same question", () => {
    assert.ok(similarity("Do you already own a domain name?", "Which domain name do you own?") >= 0.6);
    assert.ok(similarity("Should the website support Tamil and English?", "Does the site need to be in Tamil and English languages?") >= 0.6);
    assert.ok(similarity("What is the expected launch deadline?", "Expected delivery timeline / launch date?") >= 0.6);
  });
  it("different questions stay different (none of the 14 collapses into another)", () => {
    const { items, removed } = dedupe(itemsFromDraft({ questionnaire: asked() }).items);
    assert.equal(items.length, QUESTIONS.length);
    assert.equal(removed, 0);
  });
});

describe("the questionnaire is not a list of requirements", () => {
  it("all 14 questions are tracked once each, with stable ids", () => {
    const { items } = itemsFromDraft({ questionnaire: asked() });
    assert.equal(items.length, QUESTIONS.length);
    assert.equal(new Set(items.map((i) => i.id)).size, QUESTIONS.length);
    assert.equal(unanswered(items), QUESTIONS.length);
  });
  it("a duplicate question (even reworded) is merged: the count does not grow, the detail is kept", () => {
    const q = asked();
    q.push({ question: "Which domain name do you already own?", answer: "", status: "unanswered", critical: false, origin: "document" });
    q.push({ question: "Domain name: do you already have one?", answer: "GoDaddy", status: "answered", critical: true, origin: "document" });
    const { items, removed } = itemsFromDraft({ questionnaire: q });
    assert.equal(items.length, QUESTIONS.length);
    assert.equal(removed, 2);
    const domain = items.find((i) => /domain/i.test(i.text))!;
    assert.equal(domain.status, "confirmed");
    assert.match(domain.answer, /GoDaddy/);
    assert.equal(domain.critical, true);
  });
  it("placeholders are not answers", () => {
    const q: RawQuestion[] = [{ question: "What is your budget?", answer: "TBD", status: "answered", origin: "document" }];
    assert.equal(itemsFromDraft({ questionnaire: q }).items[0].status, "unanswered");
  });
});

describe("re-uploading the revised document", () => {
  it("answering all 14 questions drops the unanswered count to what the document really leaves open", () => {
    const first = mergeInsights(draft({ questionnaire: asked() }));
    assert.equal(first.tracker!.filter((i) => i.status === "unanswered").length, QUESTIONS.length);
    assert.equal(first.questions.length, QUESTIONS.length);

    const second = mergeInsights(draft({ questionnaire: asked(ANSWERS) }), first);
    assert.equal(second.tracker!.length, QUESTIONS.length, "no new questions appear");
    assert.equal(second.questions.length, 0);
    assert.equal(summarize(second.tracker!, second.confirmed.length).unansweredQuestions, 0);
    assert.equal(summarize(second.tracker!, 0).answeredQuestions, QUESTIONS.length);
    // Same ids as before: the questions were matched, not recreated.
    assert.deepEqual(second.tracker!.map((i) => i.id), first.tracker!.map((i) => i.id));
  });
  it("a partly answered document leaves exactly the unanswered ones (calculated from the content)", () => {
    const partial = ANSWERS.map((a, i) => (i % 4 === 0 ? null : a));
    const open = partial.filter((a) => !a).length;
    const first = mergeInsights(draft({ questionnaire: asked() }));
    const second = mergeInsights(draft({ questionnaire: asked(partial) }), first);
    assert.equal(second.questions.length, open);
    assert.equal(summarize(second.tracker!, 0).answeredQuestions, QUESTIONS.length - open);
  });
  it("confirmed answers are never reset by a later document that does not repeat them", () => {
    const first = mergeInsights(draft({ questionnaire: asked(ANSWERS) }));
    const again = mergeInsights(draft({ questionnaire: asked() }), first);
    assert.equal(again.questions.length, 0);
    assert.ok(again.tracker!.every((i) => i.status === "confirmed" && i.answer));
  });
  it("a changed answer updates only that answer", () => {
    const first = mergeInsights(draft({ questionnaire: asked(ANSWERS) }));
    const changed = ANSWERS.slice();
    changed[8] = "Rs 95,000";
    const second = mergeInsights(draft({ questionnaire: asked(changed) }), first);
    assert.equal(second.tracker!.find((i) => /budget/i.test(i.text))!.answer, "Rs 95,000");
    assert.equal(second.tracker!.find((i) => /domain/i.test(i.text))!.answer, ANSWERS[0]);
  });
  it("questions reworded in the new upload are matched by meaning, not recreated", () => {
    const first = mergeInsights(draft({ questionnaire: asked() }));
    const reworded = asked(ANSWERS).map((q) => ({ ...q, question: `Q. ${q.question.replace("Do you", "Would you").replace("?", " (please confirm)?")}` }));
    const second = mergeInsights(draft({ questionnaire: reworded }), first);
    assert.equal(second.tracker!.length, QUESTIONS.length);
    assert.equal(second.questions.length, 0);
  });
  it("a genuinely new question is added and counted as newly discovered", () => {
    const first = mergeInsights(draft({ questionnaire: asked(ANSWERS) }));
    const q = asked(ANSWERS);
    q.push({ question: "Will the store ship outside India?", answer: "", status: "unanswered", critical: true, origin: "document" });
    const second = mergeInsights(draft({ questionnaire: q }), first);
    assert.equal(second.tracker!.length, QUESTIONS.length + 1);
    assert.equal(second.lastChange!.newlyDiscovered, 1);
    assert.equal(second.questions.length, 1);
  });
});

describe("no questions made up from guesses", () => {
  it("an AI-raised question is dropped unless it is needed for scope", () => {
    const q = asked(ANSWERS);
    q.push({ question: "Would you like dark mode?", answer: "", status: "unanswered", critical: false, origin: "discovered" });
    q.push({ question: "Will the store ship outside India?", answer: "", status: "unanswered", critical: true, origin: "discovered" });
    const { items } = itemsFromDraft({ questionnaire: q });
    assert.ok(!items.some((i) => /dark mode/.test(i.text)));
    assert.ok(items.some((i) => /ship outside/.test(i.text)));
  });
  it("an AI-raised question the document already asks, or the client already stated, is not added", () => {
    const q = asked();
    q.push({ question: "Is there a domain name the client owns?", answer: "", status: "unanswered", critical: true, origin: "discovered" });
    q.push({ question: "Should payments use Razorpay?", answer: "", status: "unanswered", critical: true, origin: "discovered" });
    const { items } = itemsFromDraft({ questionnaire: q, confirmed: ["Payments use Razorpay"] });
    assert.equal(items.filter((i) => i.kind === "question").length, QUESTIONS.length);
  });
  it("what the client excluded is Not Applicable, not an open question", () => {
    const { items } = itemsFromDraft({ questionnaire: asked(), exclusions: ["Blog or news section is out of scope"] });
    const blog = items.find((i) => /blog/i.test(i.text))!;
    assert.equal(blog.status, "not-applicable");
    assert.equal(unanswered(items), QUESTIONS.length - 1);
  });
  it("an assumption stays pending until the client approves it", () => {
    const a = "Product photos will be provided by the client.";
    const pending = itemsFromDraft({ assumptions: [a] }).items[0];
    assert.equal(pending.status, "pending-approval");
    const approved = itemsFromDraft({ assumptions: [a], approvedAssumptions: [a] }).items[0];
    assert.equal(approved.status, "confirmed");
    assert.deepEqual(legacyLists([pending]).assumptions, [a]);
    assert.deepEqual(legacyLists([approved]).assumptions, []);
  });
  it("an assumption the document already states as a requirement is not left open", () => {
    const items = applyKnowledge(itemsFromDraft({ assumptions: ["Site is available in Tamil and English languages"] }).items, [], ["Website supports Tamil and English languages"]);
    assert.equal(items[0].status, "confirmed");
  });
});

describe("estimates", () => {
  it("is preliminary while a critical question is open, validated once it is answered", () => {
    const open = itemsFromDraft({ questionnaire: asked() }).items;
    const s = estimateStatus(open);
    assert.equal(s.level, "preliminary");
    assert.equal(s.reasons.length, open.filter((i) => i.critical).length);
    assert.equal(estimateStatus(itemsFromDraft({ questionnaire: asked(ANSWERS) }).items).level, "validated");
  });
  it("open questions that are not critical do not block validation", () => {
    const q: RawQuestion[] = [{ question: "Preferred font?", answer: "", status: "unanswered", critical: false, origin: "document" }];
    assert.equal(estimateStatus(itemsFromDraft({ questionnaire: q }).items).level, "validated");
  });
  it("the summary is calculated from the items", () => {
    const tracked = itemsFromDraft({ questionnaire: asked(ANSWERS.map((a, i) => (i < 5 ? a : null))), assumptions: ["Hosting is arranged by the client."], exclusions: ["Blog or news section is not required"] }).items;
    const s = summarize(tracked, 3, { newlyDiscovered: 1, duplicatesRemoved: 2 });
    assert.equal(s.answeredQuestions, 5);
    assert.equal(s.unansweredQuestions, QUESTIONS.length - 5 - 1);
    assert.equal(s.notApplicable, 1);
    assert.equal(s.assumedRequirements, 1);
    assert.equal(s.pendingApproval, 1);
    assert.equal(s.confirmedRequirements, 3);
    assert.equal(s.duplicatesRemoved, 2);
    assert.equal(s.totalQuestions, QUESTIONS.length);
  });
});

describe("several readings of the same document", () => {
  const sectionsFor = (page: string) => defaultSections(page, DEFAULT_RATE_CARD);
  it("readings that disagree give the same questions: nothing is invented by one run", () => {
    const a = draft({ questionnaire: asked(ANSWERS), missingInfo: [] });
    const b = draft({ questionnaire: [...asked(ANSWERS), { question: "Do you want live chat?", answer: "", status: "unanswered", critical: true, origin: "discovered" }] });
    const c = draft({ questionnaire: asked(ANSWERS).slice().reverse() });
    const out = stableDraft([a, b, c], sectionsFor);
    assert.equal(out.questionnaire!.length, QUESTIONS.length);
    assert.equal(out.missingInfo.length, 0);
    // The order the runs came in cannot change the result.
    assert.deepEqual(stableDraft([c, a, b], sectionsFor).questionnaire, out.questionnaire);
  });
  it("one run that missed an answer does not reopen the question", () => {
    const answered = draft({ questionnaire: asked(ANSWERS) });
    const missed = draft({ questionnaire: asked(ANSWERS.map((a, i) => (i === 3 ? null : a))) });
    const out = stableDraft([answered, answered, missed], sectionsFor);
    assert.equal(out.missingInfo.length, 0);
  });
  it("the same document always gives the same result", () => {
    const runs = [draft({ questionnaire: asked(ANSWERS.map((a, i) => (i % 3 ? a : null))) }), draft({ questionnaire: asked(ANSWERS.map((a, i) => (i % 3 ? a : null))) })];
    assert.deepEqual(stableDraft(runs, sectionsFor), stableDraft(runs, sectionsFor));
  });
  it("consensus keeps the document's order", () => {
    const items = itemsFromDraft({ questionnaire: asked() }).items;
    assert.deepEqual(consensus([items, items], 2).map((i) => i.text), QUESTIONS);
  });
});

describe("saving", () => {
  it("the tracker survives being saved and read back", () => {
    const insights = mergeInsights(draft({ questionnaire: asked(ANSWERS.map((a, i) => (i < 6 ? a : null))), assumptions: ["Photos from client."] }));
    const saved = parseRequirement({ title: "x", pages: ["Home"], summary: "An online store for sarees with a catalogue, cart and checkout, built for the client.", insights: JSON.parse(JSON.stringify(insights)) }, DEFAULT_RATE_CARD).insights!;
    assert.deepEqual(saved.tracker, insights.tracker);
    assert.deepEqual(saved.lastChange, insights.lastChange);
  });
  it("malformed saved items are dropped, ids are kept", () => {
    const items = parseItems([{ id: "Q-abc1234", kind: "question", text: "Budget?", status: "confirmed", answer: "1", critical: true, origin: "document" }, { kind: "x" }, null, { kind: "question", text: "t", status: "bogus" }]);
    assert.equal(items.length, 1);
    assert.equal(items[0].id, "Q-abc1234");
  });
  it("reconcile keeps an item a later document does not mention", () => {
    const first = itemsFromDraft({ questionnaire: asked() }).items;
    const out = reconcile(first, itemsFromDraft({ questionnaire: asked().slice(0, 3) }).items);
    assert.equal(out.items.length, QUESTIONS.length);
  });
});
