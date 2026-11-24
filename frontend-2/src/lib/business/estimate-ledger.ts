import { pageKey } from "./analysis-stable";
import { confirmedTexts, dedupe, estimateStatus, summarize, type AnalysisSummary, type ClarificationItem, type EstimateStatus } from "./clarifications";
import { techFactor } from "./pricing";
import type { Quote, Quotation, RateCard, Requirement } from "./types";

/**
 * The estimate, explained (pure, browser and server safe).
 *
 * The price itself is still worked out by pricing.ts. This module only reads a finished quote and says where its hours come from
 * (module by module), how it changed since the previous version and why, how far it can be trusted, and whether the numbers shown
 * to the team agree with each other. Nothing here sets a price.
 */

// ---- module-wise effort ---------------------------------------------------------------------------------------------------------

export type EffortLine = { description: string; hours: number; amount: number };
export type EffortGroup = { group: string; hours: number; amount: number; lines: EffortLine[] };

/** Which part of the system a page belongs to, from its name. */
export type PageRole = "public" | "customer" | "agent" | "admin";
const ROLE_WORDS: [PageRole, RegExp][] = [
  ["admin", /\b(admin|administrator|staff|management|manage)\b/i],
  ["agent", /\bagents?\b/i],
  ["customer", /\b(customers?|my)\b/i],
];
export const pageRole = (name: string): PageRole => ROLE_WORDS.find(([, re]) => re.test(name))?.[0] ?? "public";

const GROUP_LABEL: Record<PageRole, string> = { public: "Public website pages", customer: "Customer portal pages", agent: "Agent portal pages", admin: "Admin portal pages" };
const GROUP_ORDER = ["Set-up, testing & deployment", GROUP_LABEL.public, GROUP_LABEL.customer, GROUP_LABEL.agent, GROUP_LABEL.admin];

const round = (n: number) => Math.round(n * 100) / 100;

/** Splits the hours of a quote into the parts of the project that use them. The parts always add up to the quote's hours. */
export function moduleEffort(quote: Pick<Quote, "items" | "totalHours">): { groups: EffortGroup[]; totalHours: number; matchesQuote: boolean } {
  const groups = new Map<string, EffortGroup>();
  for (const item of quote.items) {
    if (item.unit !== "hour") continue;
    let group: string;
    if (item.description.startsWith("Page: ")) group = GROUP_LABEL[pageRole(item.description.slice(6))];
    else if (item.category === "design") group = "Design";
    else if (/set-up, testing|existing codebase/i.test(item.description)) group = GROUP_ORDER[0];
    else if (/^premium care/i.test(item.description)) group = "Premium care";
    else group = `Feature: ${item.description}`;
    const g = groups.get(group) ?? { group, hours: 0, amount: 0, lines: [] };
    g.hours = round(g.hours + item.qty);
    g.amount = round(g.amount + item.amount);
    g.lines.push({ description: item.description, hours: item.qty, amount: item.amount });
    groups.set(group, g);
  }
  const rank = (g: string) => (GROUP_ORDER.includes(g) ? GROUP_ORDER.indexOf(g) : g.startsWith("Feature:") ? 50 : 90);
  const list = [...groups.values()].sort((a, b) => rank(a.group) - rank(b.group) || (a.group < b.group ? -1 : 1));
  const total = round(list.reduce((sum, g) => sum + g.hours, 0));
  return { groups: list, totalHours: total, matchesQuote: Math.abs(total - round(quote.totalHours)) < 0.01 };
}

// ---- pages ----------------------------------------------------------------------------------------------------------------------

export type PageViews = {
  /** Pages in the requirement, as listed. */
  listed: number;
  /** Different pages once the role is ignored: "Admin / Agent / Customer Dashboard" is one page with three views. */
  unique: number;
  /** listed - unique: extra views of a page that exists in several roles. */
  roleSpecificViews: number;
  byRole: Record<PageRole, number>;
  /** Pages that exist in more than one role. */
  shared: { page: string; roles: PageRole[] }[];
};

const stripRole = (name: string) => pageKey(name.replace(/\b(admin|administrator|agents?|customers?|staff|my|user|users)\b/gi, " ")) || pageKey(name);

export function pageViews(pages: string[]): PageViews {
  const byRole: Record<PageRole, number> = { public: 0, customer: 0, agent: 0, admin: 0 };
  const groups = new Map<string, { page: string; roles: Set<PageRole>; count: number }>();
  for (const name of pages) {
    const role = pageRole(name);
    byRole[role] += 1;
    const key = stripRole(name);
    const g = groups.get(key) ?? { page: name.replace(/\b(admin|agent|customer|my)\b\s*/gi, "").trim() || name, roles: new Set<PageRole>(), count: 0 };
    g.roles.add(role);
    g.count += 1;
    groups.set(key, g);
  }
  const unique = groups.size;
  return {
    listed: pages.length,
    unique,
    roleSpecificViews: pages.length - unique,
    byRole,
    shared: [...groups.values()].filter((g) => g.count > 1).map((g) => ({ page: g.page, roles: [...g.roles] })).sort((a, b) => (a.page < b.page ? -1 : 1)),
  };
}

// ---- versions -------------------------------------------------------------------------------------------------------------------

export type EstimateSnapshot = {
  number: string;
  createdAt: string;
  tier?: string;
  hours: number;
  weeks: number;
  subtotal: number;
  gst: number;
  grandTotal: number;
};

export type EstimateChange = { what: string; from: number; to: number };
export type EstimateVersion = EstimateSnapshot & {
  /** Differences from the version before it, empty for the first. */
  changes: EstimateChange[];
  /** Why the estimate moved, in words, from what was added, removed or resized. */
  reasons: string[];
};

export const snapshot = (q: Pick<Quotation, "number" | "createdAt" | "tier" | "totalHours" | "estimatedWeeks" | "subtotal" | "gst" | "grandTotal">): EstimateSnapshot => ({
  number: q.number,
  createdAt: q.createdAt,
  ...(q.tier ? { tier: q.tier } : {}),
  hours: q.totalHours,
  weeks: q.estimatedWeeks,
  subtotal: q.subtotal,
  gst: q.gst.total,
  grandTotal: q.grandTotal,
});

const lineMap = (q: Pick<Quote, "items">) => {
  const map = new Map<string, number>();
  for (const i of q.items) if (i.unit === "hour") map.set(i.description, round((map.get(i.description) ?? 0) + i.qty));
  return map;
};

/** What changed between two quotes (hours, duration, price, GST) and why: lines that appeared, disappeared or changed size. */
export function compareQuotes(prev: Quotation, next: Quotation): { changes: EstimateChange[]; reasons: string[] } {
  const a = snapshot(prev);
  const b = snapshot(next);
  const changes: EstimateChange[] = ([
    ["Development hours", a.hours, b.hours],
    ["Project duration (weeks)", a.weeks, b.weeks],
    ["Subtotal", a.subtotal, b.subtotal],
    ["GST", a.gst, b.gst],
    ["Grand total", a.grandTotal, b.grandTotal],
  ] as [string, number, number][])
    .filter(([, from, to]) => Math.abs(from - to) > 0.001)
    .map(([what, from, to]) => ({ what, from, to }));

  const before = lineMap(prev);
  const after = lineMap(next);
  const reasons: string[] = [];
  for (const [line, hours] of after) {
    if (!before.has(line)) reasons.push(`Added: ${line} (+${hours} h)`);
    else if (Math.abs(before.get(line)! - hours) > 0.001) reasons.push(`Changed: ${line} (${before.get(line)} h to ${hours} h)`);
  }
  for (const [line, hours] of before) if (!after.has(line)) reasons.push(`Removed: ${line} (-${hours} h)`);
  if (a.tier && b.tier && a.tier !== b.tier) reasons.push(`Package changed from ${a.tier} to ${b.tier}`);
  if (changes.length > 0 && reasons.length === 0) reasons.push("Prices were recalculated with the current rate card or discount");
  return { changes, reasons };
}

/** Every version of the estimate, oldest first, each with what changed since the one before. */
export function estimateVersions(oldestFirst: Quotation[]): EstimateVersion[] {
  return oldestFirst.map((q, i) => ({ ...snapshot(q), ...(i === 0 ? { changes: [], reasons: [] } : compareQuotes(oldestFirst[i - 1], q)) }));
}

// ---- comparing two versions of the estimate ---------------------------------------------------------------------------------------

/** What one version of the estimate was made of: small enough to send to the browser, enough to explain a difference. */
export type VersionDigest = {
  number: string;
  createdAt: string;
  tier?: string;
  /** The reason recorded when this version was made (a decision, a re-price, a package change). */
  note: string;
  totals: { hours: number; weeks: number; subtotal: number; discount: number; taxable: number; gst: number; grandTotal: number };
  lines: { description: string; hours: number; amount: number; detail?: string }[];
  pages: string[];
  features: string[];
  requirements: string[];
  /** The assumptions the effort rests on, by name. */
  assumptions: Record<string, string>;
};

export function versionDigest(q: Quotation, note = ""): VersionDigest {
  const lines = q.items.filter((i) => i.unit === "hour").map((i) => ({ description: i.description, hours: i.qty, amount: i.amount, ...(i.detail ? { detail: i.detail } : {}) }));
  const req = q.requirement;
  const tracker = req?.insights?.tracker ?? [];
  return {
    number: q.number,
    createdAt: q.createdAt,
    ...(q.tier ? { tier: q.tier } : {}),
    note,
    totals: { hours: q.totalHours, weeks: q.estimatedWeeks, subtotal: q.subtotal, discount: q.discount, taxable: q.taxable, gst: q.gst.total, grandTotal: q.grandTotal },
    lines,
    pages: lines.filter((l) => l.description.startsWith("Page: ")).map((l) => l.description.slice(6)),
    features: lines.filter((l) => !/^Page: |set-up, testing|^Existing codebase|^Premium care/.test(l.description) && q.items.find((i) => i.description === l.description)?.category === "development").map((l) => l.description),
    requirements: tracker.length > 0 ? confirmedTexts(tracker) : (req?.insights?.confirmed ?? []),
    assumptions: {
      ...(req?.complexity ? { "Complexity": req.complexity } : {}),
      ...(req?.scope ? { "Scope": req.scope } : {}),
      ...(req?.design ? { "Design": req.design } : {}),
      ...(q.tier ? { "Package": q.tier } : {}),
      "Discount": String(q.discount),
      ...(lines[0] && q.items[0] ? { "Hourly rate": String(q.items[0].rate) } : {}),
      ...(q.stack ? { "Technology": [q.stack.frontend, q.stack.backend, q.stack.database].filter(Boolean).join(" / ") } : {}),
    },
  };
}

export type VersionDiff = {
  from: { number: string; createdAt: string };
  to: { number: string; createdAt: string };
  /** Each headline figure before and after, with the change in amount and in percent. */
  totals: { what: string; from: number; to: number; delta: number; percent: number | null; money: boolean }[];
  addedRequirements: string[];
  removedRequirements: string[];
  addedPages: string[];
  removedPages: string[];
  addedFeatures: string[];
  removedFeatures: string[];
  /** Lines whose hours changed, with the change. */
  effortChanges: { line: string; fromHours: number; toHours: number; delta: number; why: string }[];
  assumptionChanges: { what: string; from: string; to: string }[];
  /** Exact reasons, one per cause, in words. */
  reasons: string[];
  /** True when the hours that moved are fully accounted for by the added, removed and resized lines. */
  hoursExplained: boolean;
  unexplainedHours: number;
};

const pct = (from: number, to: number) => (from === 0 ? null : Math.round(((to - from) / from) * 1000) / 10);

/** The exact difference between two versions and why: every added, removed or resized line, and every changed assumption. Pure. */
export function diffDigests(a: VersionDigest, b: VersionDigest): VersionDiff {
  const totals: VersionDiff["totals"] = ([
    ["Final quotation (incl. GST)", a.totals.grandTotal, b.totals.grandTotal, true],
    ["Subtotal (before GST)", a.totals.subtotal, b.totals.subtotal, true],
    ["Discount", a.totals.discount, b.totals.discount, true],
    ["GST", a.totals.gst, b.totals.gst, true],
    ["Development hours", a.totals.hours, b.totals.hours, false],
    ["Project duration (weeks)", a.totals.weeks, b.totals.weeks, false],
  ] as [string, number, number, boolean][]).map(([what, from, to, money]) => ({ what, from, to, delta: round(to - from), percent: pct(from, to), money }));

  const before = new Map(a.lines.map((l) => [l.description, l]));
  const after = new Map(b.lines.map((l) => [l.description, l]));
  const reasons: string[] = [];
  const effortChanges: VersionDiff["effortChanges"] = [];
  let lineDelta = 0;
  const addedPages: string[] = [];
  const removedPages: string[] = [];
  const addedFeatures: string[] = [];
  const removedFeatures: string[] = [];
  const asPage = (d: string) => (d.startsWith("Page: ") ? d.slice(6) : null);

  for (const [d, l] of after) {
    const old = before.get(d);
    if (!old) {
      lineDelta += l.hours;
      const page = asPage(d);
      if (page) addedPages.push(page);
      else addedFeatures.push(d);
      reasons.push(`Added ${d}: +${l.hours} h, +${money(l.amount)}`);
    } else if (Math.abs(old.hours - l.hours) > 0.001) {
      const delta = round(l.hours - old.hours);
      lineDelta += delta;
      const why = old.detail && l.detail && old.detail !== l.detail ? `${old.detail.split(" · ")[0]} to ${l.detail.split(" · ")[0]}` : "scaled by the changed assumptions below";
      effortChanges.push({ line: d, fromHours: old.hours, toHours: l.hours, delta, why });
      reasons.push(`${d}: ${old.hours} h to ${l.hours} h (${delta > 0 ? "+" : ""}${delta} h, ${why})`);
    }
  }
  for (const [d, l] of before) {
    if (after.has(d)) continue;
    lineDelta -= l.hours;
    const page = asPage(d);
    if (page) removedPages.push(page);
    else removedFeatures.push(d);
    reasons.push(`Removed ${d}: -${l.hours} h, -${money(l.amount)}`);
  }

  const assumptionChanges: VersionDiff["assumptionChanges"] = [];
  for (const key of new Set([...Object.keys(a.assumptions), ...Object.keys(b.assumptions)])) {
    const x = a.assumptions[key] ?? "none";
    const y = b.assumptions[key] ?? "none";
    if (x !== y) assumptionChanges.push({ what: key, from: x, to: y });
  }
  for (const c of assumptionChanges) {
    if (c.what === "Complexity") reasons.push(`Complexity changed from ${c.from} to ${c.to}: every development line is scaled by the new multiplier`);
    else if (c.what === "Discount") reasons.push(`Discount changed from ${money(Number(c.from) || 0)} to ${money(Number(c.to) || 0)}`);
    else if (c.what === "Package") reasons.push(`Package changed from ${c.from} to ${c.to}`);
    else if (c.what === "Hourly rate") reasons.push(`Hourly rate changed from ${money(Number(c.from) || 0)} to ${money(Number(c.to) || 0)}`);
    else reasons.push(`${c.what} changed from ${c.from} to ${c.to}`);
  }

  const aReq = new Set(a.requirements);
  const bReq = new Set(b.requirements);
  const addedRequirements = b.requirements.filter((r) => !aReq.has(r));
  const removedRequirements = a.requirements.filter((r) => !bReq.has(r));
  for (const r of addedRequirements) reasons.push(`Requirement added to the scope: ${r}`);
  for (const r of removedRequirements) reasons.push(`Requirement taken out of the scope: ${r}`);

  const changed = totals.some((t) => Math.abs(t.delta) > 0.001);
  if (b.note) reasons.unshift(`Recorded reason: ${b.note}`);
  if (changed && reasons.filter((r) => !r.startsWith("Recorded reason")).length === 0) reasons.push("The prices were recalculated with the current rate card");
  if (!changed && reasons.length === 0) reasons.push("Nothing changed between these two versions");

  const hoursDelta = round(b.totals.hours - a.totals.hours);
  const unexplained = round(hoursDelta - lineDelta);
  return {
    from: { number: a.number, createdAt: a.createdAt },
    to: { number: b.number, createdAt: b.createdAt },
    totals, addedRequirements, removedRequirements, addedPages, removedPages, addedFeatures, removedFeatures, effortChanges, assumptionChanges, reasons,
    hoursExplained: Math.abs(unexplained) < 0.01,
    unexplainedHours: unexplained,
  };
}

const money = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;

/** The assumptions the price is built on, so the breakdown can say what the hours were multiplied by. */
export type EstimateBasis = { complexity: string; complexityLabel: string; complexityMultiplier: number; technologyFactor: number; hourlyRate: number; hoursPerWeek: number };
export function estimateBasis(requirement: Requirement, rates: RateCard): EstimateBasis {
  return {
    complexity: requirement.complexity,
    complexityLabel: rates.complexity[requirement.complexity]?.label ?? requirement.complexity,
    complexityMultiplier: rates.complexity[requirement.complexity]?.multiplier ?? 1,
    technologyFactor: techFactor(requirement, rates),
    hourlyRate: rates.hourlyRate,
    hoursPerWeek: rates.hoursPerWeek,
  };
}

/** Hours by role (testing and QA, project management...) when the studio has set up its internal cost allocation. */
export type TeamEffort = { role: string; label: string; hours: number }[];

// ---- confidence -----------------------------------------------------------------------------------------------------------------

export type Confidence = { level: "high" | "medium" | "low" | "unknown"; score: number; reasons: string[] };

/**
 * How far the estimate can be trusted, from what is still open. Starts at 100 and loses points for each open question (more for
 * urgent ones), each proposal or assumption waiting for a decision, and for scope that was never analysed.
 */
export function estimateConfidence(items: ClarificationItem[], pages?: PageViews): Confidence {
  if (items.length === 0) return { level: "unknown", score: 0, reasons: ["The scope was not analysed from a document, so nothing can be said about how complete it is."] };
  const s = summarize(items, 0);
  const cap = (n: number, max: number) => Math.min(max, n);
  const proposals = items.filter((i) => i.kind === "discovered" && (i.status === "pending-approval" || i.status === "needs-clarification")).length;
  const assumptions = items.filter((i) => i.kind === "assumption" && i.status === "pending-approval").length;
  const loss = [
    [cap(s.unansweredByPriority.critical * 8, 40), `${s.unansweredByPriority.critical} critical question${s.unansweredByPriority.critical === 1 ? "" : "s"} unanswered`],
    [cap(s.unansweredByPriority.high * 4, 16), `${s.unansweredByPriority.high} high-priority question${s.unansweredByPriority.high === 1 ? "" : "s"} unanswered`],
    [cap(s.unansweredByPriority.medium * 2 + s.unansweredByPriority.low, 10), `${s.unansweredByPriority.medium + s.unansweredByPriority.low} other question${s.unansweredByPriority.medium + s.unansweredByPriority.low === 1 ? "" : "s"} unanswered`],
    [cap(proposals * 4, 20), `${proposals} new requirement${proposals === 1 ? "" : "s"} waiting for a decision`],
    [cap(assumptions * 2, 10), `${assumptions} assumption${assumptions === 1 ? "" : "s"} waiting for approval`],
  ] as [number, string][];
  const lost = loss.reduce((sum, [n]) => sum + n, 0);
  const score = Math.max(0, 100 - lost);
  const reasons = loss.filter(([n]) => n > 0).map(([n, why]) => `-${n}: ${why}`);
  if (pages && pages.roleSpecificViews > 0) reasons.push(`${pages.listed} pages listed, ${pages.unique} unique: ${pages.roleSpecificViews} are role-specific views of the same page (priced as listed)`);
  return { level: score >= 80 ? "high" : score >= 55 ? "medium" : "low", score, reasons };
}

// ---- consistency ----------------------------------------------------------------------------------------------------------------

export type Check = { id: string; label: string; ok: boolean; detail: string };

/** Automatic checks that the numbers shown to the team agree with each other and with the data under them. */
export function consistencyChecks(input: { items: ClarificationItem[]; confirmedLines: number; confirmedTexts?: string[]; quote?: Quote; pages: string[]; stage?: string }): Check[] {
  const { items } = input;
  const s: AnalysisSummary = summarize(items, input.confirmedLines);
  const status: EstimateStatus = estimateStatus(items);
  const checks: Check[] = [];

  const requirementItems = items.filter((i) => i.kind === "requirement" && i.status === "confirmed").length;
  const accepted = items.filter((i) => i.kind === "discovered" && i.status === "confirmed").length;
  const expectedConfirmed = (requirementItems > 0 ? requirementItems : input.confirmedLines) + accepted;
  checks.push({
    id: "confirmed-count",
    label: "Confirmed count matches the extracted confirmed requirements",
    ok: s.confirmedRequirements === expectedConfirmed && (requirementItems === 0 || input.confirmedLines === requirementItems + accepted),
    detail: `${s.confirmedRequirements} shown, ${requirementItems} extracted${accepted ? ` + ${accepted} accepted proposal${accepted === 1 ? "" : "s"}` : ""}, ${input.confirmedLines} in the saved list`,
  });

  const unanswered = items.filter((i) => i.kind === "question" && i.status === "unanswered").length;
  checks.push({
    id: "unanswered-total",
    label: "Total unanswered equals critical plus non-critical",
    ok: s.unansweredQuestions === unanswered && s.criticalUnanswered + s.nonCriticalUnanswered === unanswered,
    detail: `${unanswered} unanswered = ${s.criticalUnanswered} critical + ${s.nonCriticalUnanswered} non-critical`,
  });

  // Anything still waiting for a decision (or turned down) must not appear among the confirmed requirements.
  const norm = (t: string) => t.toLowerCase().replace(/s+/g, " ").trim();
  const confirmedSet = new Set((input.confirmedTexts ?? []).map(norm));
  const leaked = items.filter((i) => (i.kind === "discovered" || i.kind === "assumption") && i.status !== "confirmed" && confirmedSet.has(norm(i.text)));
  checks.push({ id: "pending-not-confirmed", label: "Pending approvals are not treated as confirmed", ok: leaked.length === 0, detail: leaked.length ? `${leaked.length} pending item(s) are listed as confirmed` : `${s.pendingApproval} pending approval(s) kept out of the confirmed list` });

  const dup = dedupe(items).removed;
  checks.push({ id: "no-duplicates", label: "No duplicate requirements inflate the counts", ok: dup === 0, detail: dup ? `${dup} duplicate item(s) still in the list` : "Every item is distinct" });

  const views = pageViews(input.pages);
  checks.push({
    id: "pages",
    label: "Page counts separate unique pages from role-specific views",
    ok: views.unique + views.roleSpecificViews === views.listed,
    detail: `${views.listed} listed = ${views.unique} unique + ${views.roleSpecificViews} role-specific view${views.roleSpecificViews === 1 ? "" : "s"}`,
  });

  if (input.quote && input.quote.items.length > 0 && !input.quote.hourly) {
    const effort = moduleEffort(input.quote);
    checks.push({ id: "hours-supported", label: "Development hours are supported by the module-wise effort", ok: effort.matchesQuote, detail: `${effort.totalHours} h in the breakdown, ${round(input.quote.totalHours)} h in the quote` });
    const billedPages = input.quote.items.filter((i) => i.description.startsWith("Page: ")).length;
    const claimed = input.quote.pageCount?.billable;
    if (claimed !== undefined) checks.push({ id: "billed-pages", label: "Billed pages match the page lines in the quote", ok: billedPages === claimed, detail: `${billedPages} page lines, ${claimed} billable pages` });
  }

  const approved = ["approved", "advance_paid", "in_development", "testing", "demo_ready", "delivered"].includes(input.stage ?? "");
  checks.push({
    id: "final-blocked",
    label: "A final quotation waits for the required approvals",
    ok: !(approved && status.level === "preliminary"),
    detail: status.level === "validated" ? "Nothing is waiting, so the quotation can be final" : `${status.reasons.length} item(s) must be settled first${approved ? ": this project was approved before they were" : ""}`,
  });
  return checks;
}

// ---- everything for one project -------------------------------------------------------------------------------------------------

export type LeadAnalysis = {
  summary: AnalysisSummary;
  status: EstimateStatus;
  confidence: Confidence;
  items: ClarificationItem[];
  effort: ReturnType<typeof moduleEffort> | null;
  pages: PageViews;
  versions: EstimateVersion[];
  checks: Check[];
  /** Whether every check passed. */
  consistent: boolean;
  /** Every version in full detail, oldest first, so any two can be compared. */
  digests: VersionDigest[];
  /** What the hours were multiplied by. Absent without rates. */
  basis: EstimateBasis | null;
  /** The internal split of the hours by role, or null when the cost allocation is not set up. */
  team: TeamEffort | null;
};

export function buildLeadAnalysis(input: {
  requirement: Requirement;
  quotation?: Quotation;
  versionsOldestFirst: Quotation[];
  stage?: string;
  /** The project's history: the reason a version was made is the note that starts with its quotation number. */
  history?: { note: string }[];
  rates?: RateCard;
  team?: TeamEffort | null;
}): LeadAnalysis {
  const noteOf = (q: Quotation) => {
    const entry = (input.history ?? []).find((h) => h.note.startsWith(q.number));
    // The history reads "Q-0002 · Standard (the reason)": only the reason, in brackets, is the note. A first quotation has none.
    const rest = entry ? entry.note.slice(q.number.length).replace(/^\s*·\s*/, "").trim() : "";
    const open = rest.indexOf(" (");
    return open >= 0 && rest.endsWith(")") ? rest.slice(open + 2, -1).trim() : "";
  };
  const insights = input.requirement.insights;
  const items = insights?.tracker ?? [];
  const pages = pageViews(input.requirement.pages ?? []);
  const confirmedLines = insights?.confirmed.length ?? 0;
  const checks = consistencyChecks({ items, confirmedLines, confirmedTexts: insights?.confirmed, quote: input.quotation, pages: input.requirement.pages ?? [], stage: input.stage });
  return {
    summary: summarize(items, confirmedLines, insights?.lastChange),
    status: estimateStatus(items),
    confidence: estimateConfidence(items, pages),
    items,
    effort: input.quotation && !input.quotation.hourly ? moduleEffort(input.quotation) : null,
    pages,
    versions: estimateVersions(input.versionsOldestFirst),
    checks,
    consistent: checks.every((c) => c.ok),
    digests: input.versionsOldestFirst.map((q) => versionDigest(q, noteOf(q))),
    basis: input.rates ? estimateBasis(input.quotation?.requirement ?? input.requirement, input.rates) : null,
    team: input.team ?? null,
  };
}
