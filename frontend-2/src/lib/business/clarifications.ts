import type { RequirementDraft, RequirementInsights } from "./types";

/**
 * Clarification tracking (pure, browser and server safe).
 *
 * A client document can hold a questionnaire ("Client Clarification Questions") next to its requirements. Those questions are
 * NOT requirements, and a question the client has answered is not "unanswered". This module keeps every question and every
 * assumption as one tracked item with a stable id, so that:
 *   - the same question worded twice is one item (duplicates merged, nothing counted twice);
 *   - a revised document updates the items it answers and leaves everything already confirmed alone;
 *   - questions the AI only inferred are dropped unless they are needed to validate the scope;
 *   - every count shown to the team is calculated from the items, never typed in.
 */

/** "deferred": the team and client agreed to start without it; it is NOT in the price and will be quoted separately once it is clear. */
export const CLARIFICATION_STATUSES = ["confirmed", "unanswered", "not-applicable", "pending-approval", "needs-clarification", "rejected", "deferred"] as const;
export type ClarificationStatus = (typeof CLARIFICATION_STATUSES)[number];

export type ClarificationItem = {
  /** Stable: given once, kept when the document is uploaded again. */
  id: string;
  /**
   * question: a clarification question. assumption: filled in by the AI. requirement: stated in the document (confirmed).
   * discovered: a requirement the AI inferred from a gap: only a proposal until the team accepts it.
   */
  kind: "question" | "assumption" | "requirement" | "discovered";
  text: string;
  /** The client's answer (questions) or the note that settled the item. */
  answer: string;
  status: ClarificationStatus;
  /** Needed to validate scope or price: a final quotation is not validated while one is unanswered. */
  critical: boolean;
  /** How urgent an unanswered question is. `critical` is the same as critical === true. */
  priority: Priority;
  /** "document": written in the client's document. "discovered": raised by the AI. */
  origin: "document" | "discovered";
  /** Where the document says it (section or question number), or what a discovered item follows from. */
  source?: string;
  /** Discovered items: why the project needs it. */
  reason?: string;
  /** Discovered items: effect on effort, low | medium | high. */
  impact?: string;
  /** Discovered items: the closest catalog module id (prices the item from the rate card). */
  module?: string;
  /** Requirements: the part of the system (public website, admin portal ...). */
  area?: string;
  /** Requirements: functional or non-functional. */
  type?: "functional" | "non-functional";
  /** Requirements: how much work it is to build, low | medium | high (as read from the document by the AI). */
  complexity?: string;
  /** Set when accepting this item added its module to the scope, so rejecting it later takes the module out again. */
  appliedModule?: boolean;
};

/** What the team can do with a proposed requirement or an assumption. */
export const INSIGHT_DECISIONS = ["accept", "reject", "clarify", "defer", "reset"] as const;
export type InsightDecision = (typeof INSIGHT_DECISIONS)[number];

export const PRIORITIES = ["critical", "high", "medium", "low"] as const;
export type Priority = (typeof PRIORITIES)[number];
export const priorityOf = (value: unknown, critical?: boolean): Priority => {
  const v = typeof value === "string" ? value.trim().toLowerCase() : "";
  return (PRIORITIES as readonly string[]).includes(v) ? (v as Priority) : critical ? "critical" : "medium";
};

/** What the AI reports for one question (`status` = what the document shows). */
export type RawQuestion = { question: string; answer?: string; status?: string; critical?: boolean; priority?: string; source?: string; origin?: string };
export type RawRequirement = { text: string; source?: string; type?: string; area?: string; complexity?: string };
export type RawDiscovered = { item: string; reason?: string; source?: string; impact?: string; module?: string };

// ---- meaning of a sentence ------------------------------------------------------------------------------------------------------

const STOP = new Set([
  "a", "an", "the", "and", "or", "of", "to", "for", "in", "on", "at", "by", "with", "from", "as", "is", "are", "be", "will", "would", "should", "can", "could", "do", "does", "did", "have", "has", "had",
  "you", "your", "we", "our", "us", "it", "its", "this", "that", "these", "those", "any", "there", "need", "needs", "want", "wants", "like", "please", "kindly", "required", "require", "requires",
  "what", "which", "who", "whom", "how", "when", "where", "whether", "if", "shall", "may", "might", "also", "etc", "client", "website", "site", "page", "pages", "q", "question", "answer", "confirm", "specify", "provide", "mention", "tell", "support", "supports", "already", "one", "include", "including",
]);

/** Different wording of the same thing becomes one word before comparing. */
const SYNONYMS: Record<string, string> = {
  hosted: "host", hosting: "host", server: "host", servers: "host",
  domain: "domain", domains: "domain", url: "domain",
  mail: "email", emails: "email", "e-mail": "email",
  photo: "image", photos: "image", pictures: "image", picture: "image", images: "image", img: "image",
  payment: "payment", payments: "payment", pay: "payment", gateway: "payment", razorpay: "payment", stripe: "payment",
  login: "login", signin: "login", authentication: "login", account: "login", accounts: "login", register: "login", registration: "login", signup: "login",
  deadline: "deadline", timeline: "deadline", launch: "deadline", delivery: "deadline", date: "deadline", schedule: "deadline",
  budget: "budget", cost: "budget", price: "budget", pricing: "budget", amount: "budget",
  languages: "language", multilingual: "language", translation: "language",
  logo: "brand", branding: "brand", colours: "brand", colors: "brand", colour: "brand", color: "brand", theme: "brand",
  content: "content", text: "content", copy: "content", copywriting: "content", matter: "content",
  maintenance: "maintain", amc: "maintain", maintain: "maintain",
  contact: "contact", enquiry: "contact", inquiry: "contact", enquiries: "contact", inquiries: "contact", form: "contact",
  blog: "blog", news: "blog", articles: "blog", article: "blog",
  admin: "admin", cms: "admin", dashboard: "admin", backend: "admin",
};

const stem = (w: string): string => {
  const base = SYNONYMS[w];
  if (base) return base;
  if (w.length <= 3) return w;
  if (w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (w.endsWith("ing") && w.length > 5) return w.slice(0, -3);
  if (w.endsWith("ed") && w.length > 4) return w.slice(0, -2);
  if (w.endsWith("es") && w.length > 4) return w.slice(0, -2);
  if (w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us")) return w.slice(0, -1);
  return w;
};

/** The ideas in a sentence: wording, word order, plurals and filler are ignored. */
export function meaning(text: string): string[] {
  const words = text
    .toLowerCase()
    .replace(/^\s*(q(uestion)?\.?\s*)?\d+[.):-]\s*/, "")
    .replace(/&/g, " and ")
    .split(/[^a-z0-9-]+/)
    .filter((w) => w && !STOP.has(w));
  return [...new Set(words.map((w) => SYNONYMS[w] ?? stem(w)).filter((w) => w && !STOP.has(w)))].sort();
}

/** 0..1: how much two sentences say the same thing. */
export function similarity(a: string, b: string, containment = 0.85, minShared = 2): number {
  const x = meaning(a);
  const y = meaning(b);
  if (x.length === 0 || y.length === 0) return 0;
  const set = new Set(y);
  const common = x.filter((w) => set.has(w)).length;
  const jaccard = common / (x.length + y.length - common);
  // A short question inside a longer one ("Domain name?" in "Do you already own a domain name, and which one?") is the same question.
  const contained = common >= minShared || Math.min(x.length, y.length) === 1 ? common / Math.min(x.length, y.length) : 0;
  return Math.max(jaccard, contained * containment);
}

/** Above this two sentences are the same question / requirement. */
export const SAME = 0.6;

/** Requirements are long sentences that two readings word differently, so they match on a lower score than questions do. */
export const SAME_REQUIREMENT = 0.7;
const longText = (kind: ClarificationItem["kind"]) => kind === "requirement" || kind === "discovered";
/**
 * Long requirement sentences share many words without being the same requirement ("Administrators manage packages" is not
 * "Administrators manage bookings"), so a sentence counts as a repeat only when it is mostly the same words, or when at least four
 * words are shared and every word of the shorter one is inside the longer ("The system must: X" is X).
 */
const scoreOf = (a: string, b: string, kind: ClarificationItem["kind"]) => (longText(kind) ? similarity(a, b, 0.75, 4) : similarity(a, b, 0.85));
const similar = (a: string, b: string, kind: ClarificationItem["kind"] = "question") => scoreOf(a, b, kind) >= (longText(kind) ? SAME_REQUIREMENT : SAME);

/** FNV-1a: small, deterministic and available in the browser. */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36).padStart(7, "0").slice(0, 7);
}

const clean = (s: string) => s.replace(/\s+/g, " ").trim();

function makeId(kind: ClarificationItem["kind"], text: string, taken: Set<string>): string {
  const base = `${{ question: "Q", assumption: "A", requirement: "R", discovered: "D" }[kind]}-${hash(meaning(text).join(" ") || text.toLowerCase())}`;
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  taken.add(id);
  return id;
}

// ---- building items -------------------------------------------------------------------------------------------------------------

const RANK: Record<ClarificationStatus, number> = { confirmed: 5, rejected: 4, "not-applicable": 3, deferred: 2.5, "needs-clarification": 2, "pending-approval": 1, unanswered: 0 };
/** A decision has been made: later documents do not undo it. */
const settled = (s: ClarificationStatus) => s === "confirmed" || s === "not-applicable" || s === "rejected" || s === "deferred";

/** Joins distinct pieces of text, so the detail of a merged duplicate is kept. */
function joinText(...parts: string[]): string {
  const out: string[] = [];
  for (const raw of parts) {
    const p = clean(raw);
    if (p && !out.some((o) => o.toLowerCase().includes(p.toLowerCase()))) {
      const at = out.findIndex((o) => p.toLowerCase().includes(o.toLowerCase()));
      if (at >= 0) out[at] = p;
      else out.push(p);
    }
  }
  return out.join("; ");
}

/** Two items that mean the same become one; the detail of both is kept. */
function mergeInto(into: ClarificationItem, other: ClarificationItem): ClarificationItem {
  const status = RANK[other.status] > RANK[into.status] ? other.status : into.status;
  return {
    ...into,
    text: into.text.length >= other.text.length ? into.text : other.text,
    answer: joinText(into.answer, other.answer),
    status,
    critical: into.critical || other.critical,
    priority: PRIORITIES[Math.min(PRIORITIES.indexOf(into.priority), PRIORITIES.indexOf(other.priority))],
    origin: into.origin === "document" || other.origin === "document" ? "document" : "discovered",
    // Every place the requirement is written is kept as a source reference.
    ...(into.source || other.source ? { source: joinText(into.source ?? "", other.source ?? "") } : {}),
  };
}

/** Merges items that say the same thing. Returns the items and how many duplicates were removed. */
export function dedupe(items: ClarificationItem[]): { items: ClarificationItem[]; removed: number } {
  const out: ClarificationItem[] = [];
  let removed = 0;
  for (const item of items) {
    const at = out.findIndex((o) => o.kind === item.kind && (o.id === item.id || similar(o.text, item.text, item.kind)));
    if (at >= 0) {
      out[at] = mergeInto(out[at], item);
      removed++;
    } else out.push(item);
  }
  return { items: out, removed };
}

const answered = (q: RawQuestion): ClarificationStatus => {
  const answer = clean(q.answer ?? "");
  if (q.status === "not-applicable") return "not-applicable";
  if (q.status === "unanswered") return "unanswered";
  // An answer that is only a placeholder is not an answer.
  if (answer && !/^(tbd|tba|n\/?a|pending|\?+|-+|_+|to be (decided|confirmed|discussed)|not (yet )?(decided|provided|sure))\.?$/i.test(answer)) return "confirmed";
  return "unanswered";
};

/** The tracked items a draft holds: every questionnaire question, and every assumption (pending until the client approves it). */
export function itemsFromDraft(input: {
  questionnaire?: RawQuestion[];
  missingInfo?: string[];
  assumptions?: string[];
  approvedAssumptions?: string[];
  exclusions?: string[];
  confirmed?: string[];
  requirements?: RawRequirement[];
  discovered?: RawDiscovered[];
}): { items: ClarificationItem[]; removed: number } {
  const taken = new Set<string>();
  const items: ClarificationItem[] = [];
  // What the document states: confirmed, each with the place it is written.
  for (const r of input.requirements ?? []) {
    const text = clean(r.text ?? "");
    if (!text) continue;
    const type = /non[- ]?functional/i.test(r.type ?? "") ? "non-functional" : "functional";
    items.push({ id: makeId("requirement", text, taken), kind: "requirement", text, answer: "", status: "confirmed", critical: false, priority: "medium", origin: "document", ...(clean(r.source ?? "") ? { source: clean(r.source ?? "") } : {}), ...(clean(r.area ?? "") ? { area: clean(r.area ?? "") } : {}), ...(["low", "medium", "high"].includes((r.complexity ?? "").trim().toLowerCase()) ? { complexity: (r.complexity ?? "").trim().toLowerCase() } : {}), type });
  }
  const fromQuestionnaire = (input.questionnaire ?? []).filter((q) => clean(q.question));
  for (const q of fromQuestionnaire) {
    const text = clean(q.question);
    const status = answered(q);
    const priority = priorityOf(q.priority, q.critical);
    items.push({ id: makeId("question", text, taken), kind: "question", text, answer: clean(q.answer ?? ""), status, critical: priority === "critical", priority, origin: q.origin === "discovered" ? "discovered" : "document", ...(clean(q.source ?? "") ? { source: clean(q.source ?? "") } : {}) });
  }
  // Older agents only send a list of questions: all unanswered, kept as they are (nothing says they were inferred).
  if (fromQuestionnaire.length === 0) {
    for (const text of (input.missingInfo ?? []).map(clean).filter(Boolean)) {
      items.push({ id: makeId("question", text, taken), kind: "question", text, answer: "", status: "unanswered", critical: false, priority: "medium", origin: "document" });
    }
  }
  const approved = input.approvedAssumptions ?? [];
  for (const raw of input.assumptions ?? []) {
    const text = clean(raw);
    if (!text) continue;
    const ok = approved.some((a) => similar(a, text));
    items.push({ id: makeId("assumption", text, taken), kind: "assumption", text, answer: "", status: ok ? "confirmed" : "pending-approval", critical: false, priority: "medium", origin: "discovered" });
  }
  // Gaps the AI found: proposals only. They wait for the team's decision and never count as confirmed.
  for (const d of input.discovered ?? []) {
    const text = clean(d.item ?? "");
    if (!text) continue;
    const impact = ["low", "medium", "high"].includes((d.impact ?? "").trim().toLowerCase()) ? (d.impact ?? "").trim().toLowerCase() : "medium";
    items.push({
      id: makeId("discovered", text, taken), kind: "discovered", text, answer: "", status: "pending-approval", critical: false, priority: "medium", origin: "discovered",
      ...(clean(d.source ?? "") ? { source: clean(d.source ?? "") } : {}), ...(clean(d.reason ?? "") ? { reason: clean(d.reason ?? "") } : {}), impact, ...(clean(d.module ?? "") ? { module: clean(d.module ?? "") } : {}),
    });
  }
  const merged = dedupe(items);
  const known = applyKnowledge(merged.items, input.exclusions ?? [], input.confirmed ?? []);
  // A gap the document already covers (a requirement, a question or an exclusion) is a duplicate, not a discovery.
  const droppedDiscovered = merged.items.filter((i) => i.kind === "discovered").length - known.filter((i) => i.kind === "discovered").length;
  return { items: known, removed: merged.removed + droppedDiscovered };
}

/**
 * What the document already settles:
 *  - a requirement the client explicitly excluded is Not Applicable, so nobody asks about it again;
 *  - a question only the AI raised is dropped when it is not needed to validate the scope, or when the document already covers it
 *    (a stated requirement, an exclusion, or another question).
 */
export function applyKnowledge(items: ClarificationItem[], exclusions: string[], confirmed: string[]): ClarificationItem[] {
  const out: ClarificationItem[] = [];
  for (const item of items) {
    const excluded = exclusions.some((e) => similar(e, item.text, item.kind));
    const stated = items.some((o) => o !== item && (o.kind === "requirement" || o.kind === "question") && similar(o.text, item.text, "discovered"));
    const covered = confirmed.some((c) => similar(c, item.text, item.kind));
    if (item.kind === "discovered") {
      // Something the document states, asks about or excludes is not a discovery.
      if (stated || covered || excluded) continue;
      out.push(item);
      continue;
    }
    if (item.origin === "discovered" && item.kind === "question") {
      if (!item.critical && !settled(item.status)) continue;
      if (excluded || covered) continue;
      const documentHas = items.some((o) => o !== item && o.origin === "document" && o.kind === "question" && similar(o.text, item.text));
      if (documentHas) continue;
    }
    if (item.kind === "assumption" && item.status === "pending-approval" && (covered || excluded)) {
      // An assumption the client's own words already settle is no longer an open assumption.
      out.push({ ...item, status: excluded ? "not-applicable" : "confirmed" });
      continue;
    }
    if (item.kind === "question" && item.status === "unanswered" && excluded) {
      out.push({ ...item, status: "not-applicable", answer: item.answer || "Excluded from the scope by the client." });
      continue;
    }
    out.push(item);
  }
  return out;
}

// ---- keeping track across uploads -----------------------------------------------------------------------------------------------

export type ReconcileResult = {
  items: ClarificationItem[];
  /** Items this upload added. */
  added: ClarificationItem[];
  /** Items whose answer or status this upload changed. */
  updated: ClarificationItem[];
  /** Same question worded twice, merged. */
  duplicatesRemoved: number;
};

/**
 * Merges what a new document says into what is already tracked.
 * Items are matched by id, then by meaning. An answer already confirmed is never reset; a new answer replaces an open item;
 * an item the new document does not mention is kept as it was.
 */
export function reconcile(previous: ClarificationItem[], incoming: ClarificationItem[], duplicatesRemoved = 0): ReconcileResult {
  const items = previous.map((p) => ({ ...p }));
  const taken = new Set(items.map((i) => i.id));
  const added: ClarificationItem[] = [];
  const updated: ClarificationItem[] = [];
  let removed = duplicatesRemoved;

  for (const next of incoming) {
    let at = items.findIndex((p) => p.id === next.id && p.kind === next.kind);
    if (at < 0) {
      let best = -1;
      let bestScore = 0;
      const threshold = next.kind === "requirement" || next.kind === "discovered" ? SAME_REQUIREMENT : SAME;
      items.forEach((p, i) => {
        if (p.kind !== next.kind) return;
        const score = scoreOf(p.text, next.text, next.kind);
        if (score >= threshold && score > bestScore) { best = i; bestScore = score; }
      });
      at = best;
    }
    if (at < 0) {
      const id = taken.has(next.id) ? makeId(next.kind, next.text, taken) : (taken.add(next.id), next.id);
      const item = { ...next, id };
      items.push(item);
      added.push(item);
      continue;
    }
    const old = items[at];
    // The same item seen twice in one upload (or again) is not a new one.
    let status = old.status;
    let answer = old.answer;
    if (old.kind === "discovered" || old.kind === "requirement") {
      // A decision on a proposed item (accept, reject, ask the client) is the team's: a document never changes it.
      status = old.status;
    } else if (settled(old.status)) {
      // Confirmed or not applicable is never reset. A revised answer replaces the wording; "not applicable" can become answered.
      if (next.status === "confirmed" && next.answer) {
        answer = next.answer;
        status = "confirmed";
      } else if (next.status === old.status) answer = joinText(old.answer, next.answer);
    } else if (next.status !== "unanswered" && next.status !== "pending-approval") {
      status = next.status;
      answer = next.answer || old.answer;
    } else if (old.kind === "assumption") {
      status = next.status;
    }
    const priority = PRIORITIES[Math.min(PRIORITIES.indexOf(old.priority), PRIORITIES.indexOf(next.priority))];
    const merged: ClarificationItem = {
      ...old, answer, status, priority, critical: priority === "critical",
      origin: old.origin === "document" || next.origin === "document" ? "document" : "discovered",
      ...(old.source || next.source ? { source: old.source || next.source } : {}),
    };
    if (merged.status !== old.status || merged.answer !== old.answer) updated.push(merged);
    items[at] = merged;
  }
  return { items, added, updated, duplicatesRemoved: removed };
}

const KIND_ORDER: ClarificationItem["kind"][] = ["requirement", "question", "assumption", "discovered"];

// ---- several readings of one document -------------------------------------------------------------------------------------------

/**
 * The AI reads a document differently each time. An item counts only when `min` of the readings found it (by meaning); its status
 * is what most readings said, and an answer one reading found is kept when the others only missed it.
 */
export function consensus(readings: ClarificationItem[][], minOrFor: number | ((kind: ClarificationItem["kind"]) => number)): ClarificationItem[] {
  const minOf = (kind: ClarificationItem["kind"]) => (typeof minOrFor === "number" ? minOrFor : minOrFor(kind));
  type Cluster = { first: ClarificationItem; members: ClarificationItem[]; runs: Set<number>; pos: number };
  const clusters: Cluster[] = [];
  readings.forEach((reading, run) => {
    dedupe(reading).items.forEach((item, index) => {
      const c = clusters.find((x) => x.first.kind === item.kind && similar(x.first.text, item.text, item.kind));
      if (c) { c.members.push(item); c.runs.add(run); c.pos = Math.min(c.pos, index); }
      else clusters.push({ first: item, members: [item], runs: new Set([run]), pos: index });
    });
  });
  const taken = new Set<string>();
  return clusters
    .filter((c) => c.runs.size >= minOf(c.first.kind))
    .map((c) => {
      // Shortest wording that sorts first: the same cluster gives the same text whatever order the readings came in.
      const text = [...c.members].map((m) => m.text).sort((a, b) => a.length - b.length || (a < b ? -1 : 1))[0];
      const count = new Map<ClarificationStatus, number>();
      for (const m of c.members) count.set(m.status, (count.get(m.status) ?? 0) + 1);
      const status = [...count.entries()].sort((a, b) => b[1] - a[1] || RANK[b[0]] - RANK[a[0]])[0][0];
      const answer = [...c.members].filter((m) => m.status === status).map((m) => m.answer).sort((a, b) => b.length - a.length || (a < b ? -1 : 1))[0] ?? "";
      const min = minOf(c.first.kind);
      const counts = new Map<Priority, number>();
      for (const m of c.members) counts.set(m.priority, (counts.get(m.priority) ?? 0) + 1);
      // The priority most readings gave; a tie goes to the more urgent one.
      const priority = [...counts.entries()].sort((a, b) => b[1] - a[1] || PRIORITIES.indexOf(a[0]) - PRIORITIES.indexOf(b[0]))[0][0];
      const critical = priority === "critical" && counts.get("critical")! >= Math.min(min, c.runs.size);
      const origin = c.members.some((m) => m.origin === "document") ? "document" : "discovered";
      // Details that only some readings found (where it is written, why it is needed) are kept, the longest first.
      const longest = (pick: (m: ClarificationItem) => string | undefined) => [...c.members].map((m) => pick(m) ?? "").filter(Boolean).sort((a, b) => b.length - a.length || (a < b ? -1 : 1))[0];
      const source = longest((m) => m.source);
      const reason = longest((m) => m.reason);
      const impact = longest((m) => m.impact);
      const module = longest((m) => m.module);
      const first = c.members[0];
      return {
        pos: c.pos,
        item: {
          id: makeId(c.first.kind, text, taken), kind: c.first.kind, text, answer, status, critical, priority: critical ? "critical" : priority === "critical" ? "high" : priority, origin,
          ...(source ? { source } : {}), ...(reason ? { reason } : {}), ...(impact ? { impact } : {}), ...(module ? { module } : {}),
          ...(first.area ? { area: first.area } : {}), ...(first.type ? { type: first.type } : {}),
          ...(longest((m) => m.complexity) ? { complexity: longest((m) => m.complexity) } : {}),
        } satisfies ClarificationItem,
      };
    })
    // The document's own order; the wording breaks a tie so the result never depends on which reading came first.
    .sort((a, b) => KIND_ORDER.indexOf(a.item.kind) - KIND_ORDER.indexOf(b.item.kind) || a.pos - b.pos || (a.item.text < b.item.text ? -1 : 1))
    .map((x) => x.item);
}

/** Keeps the lines most readings agree on (confirmed requirements, exclusions), merging lines that say the same. Document order. */
export function agreeLines(readings: string[][], min: number): string[] {
  const asItems = readings.map((r) => r.map((text) => ({ id: "", kind: "question", text: clean(text), answer: "", status: "confirmed", critical: false, priority: "medium", origin: "document" }) as ClarificationItem).filter((i) => i.text));
  return consensus(asItems, min).map((i) => i.text);
}

// ---- what the team sees ---------------------------------------------------------------------------------------------------------

export type AnalysisSummary = {
  /** Requirements the document states (all kinds), plus proposals the team accepted. */
  confirmedRequirements: number;
  functionalRequirements: number;
  nonFunctionalRequirements: number;
  answeredQuestions: number;
  /** Always the sum of the four priorities below. */
  unansweredQuestions: number;
  unansweredByPriority: Record<Priority, number>;
  criticalUnanswered: number;
  nonCriticalUnanswered: number;
  assumedRequirements: number;
  notApplicable: number;
  /** Assumptions and proposals still waiting for a decision. */
  pendingApproval: number;
  newlyDiscovered: number;
  discoveredAccepted: number;
  discoveredRejected: number;
  discoveredNeedClarification: number;
  duplicatesRemoved: number;
  totalQuestions: number;
};

export function summarize(items: ClarificationItem[], legacyConfirmed: number, extra: { newlyDiscovered?: number; duplicatesRemoved?: number } = {}): AnalysisSummary {
  const questions = items.filter((i) => i.kind === "question");
  const assumptions = items.filter((i) => i.kind === "assumption");
  const requirements = items.filter((i) => i.kind === "requirement");
  const discovered = items.filter((i) => i.kind === "discovered");
  const unanswered = questions.filter((i) => i.status === "unanswered");
  const byPriority = Object.fromEntries(PRIORITIES.map((p) => [p, unanswered.filter((i) => i.priority === p).length])) as Record<Priority, number>;
  const accepted = discovered.filter((i) => i.status === "confirmed").length;
  return {
    // Older records only have the plain list of confirmed lines.
    confirmedRequirements: (requirements.length > 0 ? requirements.length : legacyConfirmed) + accepted,
    functionalRequirements: requirements.filter((i) => i.type !== "non-functional").length,
    nonFunctionalRequirements: requirements.filter((i) => i.type === "non-functional").length,
    answeredQuestions: questions.filter((i) => i.status === "confirmed").length,
    unansweredQuestions: PRIORITIES.reduce((sum, p) => sum + byPriority[p], 0),
    unansweredByPriority: byPriority,
    criticalUnanswered: byPriority.critical,
    nonCriticalUnanswered: byPriority.high + byPriority.medium + byPriority.low,
    assumedRequirements: assumptions.length,
    notApplicable: items.filter((i) => i.status === "not-applicable").length,
    pendingApproval: assumptions.filter((i) => i.status === "pending-approval").length + discovered.filter((i) => i.status === "pending-approval" || i.status === "needs-clarification").length,
    newlyDiscovered: discovered.length > 0 ? discovered.length : (extra.newlyDiscovered ?? 0),
    discoveredAccepted: accepted,
    discoveredRejected: discovered.filter((i) => i.status === "rejected").length,
    discoveredNeedClarification: discovered.filter((i) => i.status === "needs-clarification").length,
    duplicatesRemoved: extra.duplicatesRemoved ?? 0,
    totalQuestions: questions.length,
  };
}

/** A price may be given as soon as there is something to price; it is only final once nothing that needs a decision is open. */
export type EstimateStatus = {
  level: "preliminary" | "validated";
  label: string;
  /** Every open item that blocks a final quotation, in words. */
  reasons: string[];
  blockers: { criticalQuestions: number; proposals: number; assumptions: number };
  /** Items left out of the price on purpose, to be quoted separately once they are clear. They never block approval. */
  deferred: string[];
};

/** What the client must be told is NOT in the price: every item the team deferred. */
export const deferredTexts = (items: ClarificationItem[]): string[] => items.filter((i) => i.status === "deferred" && i.kind !== "requirement").map((i) => i.text);

export function estimateStatus(items: ClarificationItem[]): EstimateStatus {
  const critical = items.filter((i) => i.kind === "question" && i.status === "unanswered" && i.priority === "critical");
  const proposals = items.filter((i) => i.kind === "discovered" && (i.status === "pending-approval" || i.status === "needs-clarification"));
  const assumptions = items.filter((i) => i.kind === "assumption" && i.status === "pending-approval");
  const reasons = [...critical.map((i) => i.text), ...proposals.map((i) => `New requirement waiting for a decision: ${i.text}`), ...assumptions.map((i) => `Assumption waiting for approval: ${i.text}`)];
  const blockers = { criticalQuestions: critical.length, proposals: proposals.length, assumptions: assumptions.length };
  const deferred = deferredTexts(items);
  if (reasons.length === 0) return { level: "validated", label: deferred.length ? "Final for the confirmed scope" : "Validated", reasons, blockers, deferred };
  return { level: "preliminary", label: "Preliminary estimate: not a validated final quotation", reasons, blockers, deferred };
}

/** The confirmed lines of a tracker: what the document states, plus the proposals the team accepted. */
export function confirmedTexts(items: ClarificationItem[]): string[] {
  return [...items.filter((i) => i.kind === "requirement"), ...items.filter((i) => i.kind === "discovered" && i.status === "confirmed")].map((i) => i.text);
}

/** The lists the older screens and the saved record use. */
export function legacyLists(items: ClarificationItem[]): { questions: string[]; assumptions: string[] } {
  return {
    questions: items.filter((i) => i.kind === "question" && i.status === "unanswered").map((i) => i.text),
    assumptions: items.filter((i) => i.kind === "assumption" && i.status === "pending-approval").map((i) => i.text),
  };
}

const isStatus = (v: unknown): v is ClarificationStatus => typeof v === "string" && (CLARIFICATION_STATUSES as readonly string[]).includes(v);

/** Reads saved items back, dropping anything malformed. */
export function parseItems(value: unknown): ClarificationItem[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: ClarificationItem[] = [];
  for (const raw of value.slice(0, 600)) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const text = typeof r.text === "string" ? clean(r.text).slice(0, 400) : "";
    const kind = (["question", "assumption", "requirement", "discovered"] as const).find((k) => k === r.kind) ?? null;
    if (!text || !kind || !isStatus(r.status)) continue;
    const id = typeof r.id === "string" && /^[A-Za-z0-9-]{3,24}$/.test(r.id) && !seen.has(r.id) ? r.id : makeId(kind, text, seen);
    seen.add(id);
    const priority = priorityOf(r.priority, r.critical === true);
    const str = (v: unknown, max: number) => (typeof v === "string" ? clean(v).slice(0, max) : "");
    const source = str(r.source, 200);
    const reason = str(r.reason, 400);
    const impact = ["low", "medium", "high"].includes(str(r.impact, 10)) ? str(r.impact, 10) : "";
    const mod = /^[a-z0-9-]{1,40}$/.test(str(r.module, 40)) ? str(r.module, 40) : "";
    out.push({
      id, kind, text, answer: str(r.answer, 600), status: r.status, critical: priority === "critical", priority, origin: r.origin === "discovered" ? "discovered" : "document",
      ...(source ? { source } : {}), ...(reason ? { reason } : {}), ...(impact ? { impact } : {}), ...(mod ? { module: mod } : {}),
      ...(str(r.area, 40) ? { area: str(r.area, 40) } : {}), ...(["low", "medium", "high"].includes(str(r.complexity, 10)) ? { complexity: str(r.complexity, 10) } : {}), ...(r.type === "non-functional" ? { type: "non-functional" as const } : r.type === "functional" ? { type: "functional" as const } : {}),
      ...(r.appliedModule === true ? { appliedModule: true } : {}),
    });
  }
  return out;
}

/**
 * What the document says about questions and assumptions, merged into what is already tracked. A revised document updates the
 * questions it answers; answers already confirmed are never reset, and the same question worded twice stays one.
 */
export function mergeInsights(d: RequirementDraft, previous?: RequirementInsights): RequirementInsights {
  const incoming = itemsFromDraft({ ...d, confirmed: d.confirmed });
  const first = !previous?.tracker?.length;
  const result = reconcile(previous?.tracker ?? [], incoming.items, incoming.removed);
  const stated = result.items.filter((i) => i.kind === "requirement");
  // Older records and agents only have the plain list of confirmed lines.
  const confirmed = stated.length > 0 ? confirmedTexts(result.items) : agreeLines([[...(previous?.confirmed ?? []), ...(d.confirmed ?? [])]], 1);
  const lists = legacyLists(result.items);
  return {
    confirmed,
    assumptions: lists.assumptions,
    questions: lists.questions,
    tracker: result.items,
    lastChange: { newlyDiscovered: (first ? result.added.filter((i) => i.kind === "discovered" || (i.kind === "question" && i.origin === "discovered")) : result.added.filter((i) => i.kind !== "assumption")).length, duplicatesRemoved: result.duplicatesRemoved },
  };
}

