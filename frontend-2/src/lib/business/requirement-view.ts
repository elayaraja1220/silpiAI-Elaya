import type { ClarificationItem } from "./clarifications";

/**
 * How the requirement list is shown (pure): filter tabs, search, grouping by module and "load more" paging.
 * The screen only draws what these functions return, so what each tab holds, and how many rows are drawn, can be tested here.
 */

// ---- filters --------------------------------------------------------------------------------------------------------------------

export const VIEW_FILTERS = ["all", "confirmed", "unanswered", "assumed", "pending", "discovered", "deferred", "not-applicable"] as const;
export type ViewFilter = (typeof VIEW_FILTERS)[number];

export const FILTER_LABEL: Record<ViewFilter, string> = {
  all: "All",
  confirmed: "Confirmed",
  unanswered: "Unanswered",
  assumed: "Assumed",
  pending: "Pending Approval",
  discovered: "Newly Discovered",
  deferred: "Deferred (quoted later)",
  "not-applicable": "Not Applicable",
};

const waiting = (i: ClarificationItem) => i.status === "pending-approval" || i.status === "needs-clarification";

/**
 * Same meaning as the summary cards, so a tab always holds exactly what its number says:
 *  confirmed = what the document states + proposals the team accepted;  unanswered = open questions;  assumed = every assumption;
 *  pending = assumptions and proposals waiting for a decision;  discovered = every proposal;  not applicable = excluded items.
 */
export function matchesFilter(item: ClarificationItem, filter: ViewFilter): boolean {
  switch (filter) {
    case "all": return true;
    case "confirmed": return item.kind === "requirement" || (item.kind === "discovered" && item.status === "confirmed");
    case "unanswered": return item.kind === "question" && item.status === "unanswered";
    case "assumed": return item.kind === "assumption";
    case "pending": return (item.kind === "assumption" || item.kind === "discovered") && waiting(item);
    case "discovered": return item.kind === "discovered";
    case "deferred": return item.status === "deferred";
    case "not-applicable": return item.status === "not-applicable";
  }
}

export function filterCounts(items: ClarificationItem[]): Record<ViewFilter, number> {
  return Object.fromEntries(VIEW_FILTERS.map((f) => [f, items.filter((i) => matchesFilter(i, f)).length])) as Record<ViewFilter, number>;
}

// ---- how one item is described --------------------------------------------------------------------------------------------------

export const STATUS_LABEL: Record<ClarificationItem["status"], string> = {
  confirmed: "Confirmed",
  unanswered: "Unanswered",
  "not-applicable": "Not applicable",
  "pending-approval": "Pending approval",
  "needs-clarification": "Needs clarification",
  rejected: "Rejected",
  deferred: "Deferred: priced later",
};

/** The status as the person reading the list would say it. */
export function statusOf(item: ClarificationItem): string {
  if (item.kind === "question" && item.status === "confirmed") return "Answered";
  if (item.kind === "assumption") return item.status === "confirmed" ? "Assumed, approved" : item.status === "pending-approval" ? "Assumed, pending approval" : STATUS_LABEL[item.status];
  if (item.kind === "discovered" && item.status === "confirmed") return "Accepted";
  return STATUS_LABEL[item.status];
}

export const KIND_LABEL: Record<ClarificationItem["kind"], string> = { requirement: "Requirement", question: "Question", assumption: "Assumption", discovered: "Newly discovered" };

/** A short title: the first sentence or clause, cut at a word. The full text is the description. */
export function titleOf(item: Pick<ClarificationItem, "text">, max = 80): string {
  const text = item.text.replace(/\s+/g, " ").trim();
  const first = text.split(/(?<=[.?!])\s|;\s|:\s/)[0] ?? text;
  if (first.length <= max) return first;
  const cut = first.slice(0, max).replace(/\s+\S*$/, "");
  return `${cut || first.slice(0, max)}...`;
}

/** The description is shown only when it says more than the title does. */
export function descriptionOf(item: Pick<ClarificationItem, "text">, max = 80): string {
  const title = titleOf(item, max);
  const text = item.text.replace(/\s+/g, " ").trim();
  return title === text || title.replace(/\.\.\.$/, "") === text ? "" : text;
}

/** Priority for questions; for proposals the impact; for requirements nothing is made up. */
export function priorityOfItem(item: ClarificationItem): string {
  if (item.kind === "question") return item.status === "unanswered" ? item.priority : "";
  if (item.kind === "discovered") return item.impact ?? "";
  return "";
}

/** Complexity as the AI read it from the document: for requirements, and for proposals their impact. Empty when unknown. */
export function complexityOfItem(item: ClarificationItem): string {
  if (item.kind === "requirement") return item.complexity ?? "";
  if (item.kind === "discovered") return item.impact ?? "";
  return "";
}

// ---- modules --------------------------------------------------------------------------------------------------------------------

export const MODULE_LABEL: Record<string, string> = {
  overview: "Project overview",
  "public-website": "Public website",
  authentication: "Authentication",
  "customer-portal": "Customer portal",
  "agent-portal": "Agent portal",
  "admin-portal": "Admin portal",
  booking: "Booking workflows",
  payments: "Payments and refunds",
  documents: "Document management",
  notifications: "Notifications",
  reports: "Reports",
  security: "Security",
  acceptance: "Performance and acceptance",
  integrations: "Integrations",
  commission: "Agent commission",
  general: "General",
};
const MODULE_ORDER = Object.keys(MODULE_LABEL);

/** The catalog feature ids, mapped to the part of the system they belong to. */
const FEATURE_AREA: Record<string, string> = {
  auth: "authentication", "admin-panel": "admin-portal", payments: "payments", booking: "booking", notifications: "notifications", reports: "reports",
  "api-integration": "integrations", search: "public-website", blog: "public-website", "contact-form": "public-website", "seo-setup": "public-website",
  "gallery-preview": "public-website", "image-slider": "public-website", "google-maps": "public-website", whatsapp: "notifications", chat: "notifications", multilingual: "public-website",
};

/** For items the AI did not file under a part of the system (questions, assumptions): the part their words are about. */
const AREA_WORDS: [string, RegExp][] = [
  ["commission", /\bcommission|payout/i],
  ["payments", /\b(payments?|refunds?|invoices?|receipts?|gateway|upi|cards?)\b/i],
  ["notifications", /\b(notifications?|sms|whatsapp|e-?mail notif|templates?)\b/i],
  ["documents", /\b(documents?|uploads?|files?|retention|formats?)\b/i],
  ["authentication", /\b(sign[- ]?in|log[- ]?in|register|registration|password|verify|verification|otp|accounts?)\b/i],
  ["integrations", /\b(integrat\w*|external|reservation|airlines?|suppliers?|api)\b/i],
  ["reports", /\breports?|export\b/i],
  ["security", /\b(security|encrypt\w*|hash\w*|audit|lock\w*|permissions?|roles?)\b/i],
  ["admin-portal", /\b(admin\w*|staff|back[- ]?office)\b/i],
  ["agent-portal", /\bagents?\b/i],
  ["customer-portal", /\bcustomers?\b/i],
  ["booking", /\b(bookings?|reservations?|itinerar\w+)\b/i],
  ["public-website", /\b(website|enquir\w+|destinations?|packages?|policy|privacy|terms)\b/i],
];

export function moduleOfItem(item: ClarificationItem): { key: string; label: string } {
  const key = (item.area && MODULE_LABEL[item.area] ? item.area : "") || (item.module && FEATURE_AREA[item.module]) || AREA_WORDS.find(([, re]) => re.test(item.text))?.[0] || "general";
  return { key, label: MODULE_LABEL[key] ?? key };
}

// ---- search ---------------------------------------------------------------------------------------------------------------------

/** Every word typed must be found somewhere in the item (id, text, source, answer, reason, module): so "agent refund" narrows. */
export function searchItems(items: ClarificationItem[], query: string): ClarificationItem[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return items;
  return items.filter((i) => {
    const hay = `${i.id} ${i.text} ${i.source ?? ""} ${i.answer} ${i.reason ?? ""} ${moduleOfItem(i).label} ${statusOf(i)} ${KIND_LABEL[i.kind]}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

// ---- grouping and paging --------------------------------------------------------------------------------------------------------

export type ItemGroup = { key: string; label: string; items: ClarificationItem[] };

/** Groups by module, in a fixed order, keeping each group's items in the document's order. */
export function groupItems(items: ClarificationItem[]): ItemGroup[] {
  const groups = new Map<string, ItemGroup>();
  for (const item of items) {
    const m = moduleOfItem(item);
    const g = groups.get(m.key) ?? { key: m.key, label: m.label, items: [] };
    g.items.push(item);
    groups.set(m.key, g);
  }
  const rank = (k: string) => (MODULE_ORDER.includes(k) ? MODULE_ORDER.indexOf(k) : MODULE_ORDER.length);
  return [...groups.values()].sort((a, b) => rank(a.key) - rank(b.key) || (a.label < b.label ? -1 : 1));
}

export const FIRST_PAGE = 5;
export const PAGE_STEP = 10;

/** How many rows of a group are drawn: a few at first, `PAGE_STEP` more each time "Load more" is used. Never more than exist. */
export function visibleCount(total: number, loaded: number | undefined): number {
  return Math.min(total, loaded ?? FIRST_PAGE);
}
export const nextCount = (total: number, loaded: number | undefined): number => Math.min(total, visibleCount(total, loaded) + PAGE_STEP);

/** The documents the analysis was read from, as kept in the requirement's reference notes. */
export function documentsOf(references: string | undefined): string[] {
  const line = (references ?? "").split("\n").find((l) => l.startsWith("From client documents:"));
  return line ? line.replace("From client documents:", "").split(",").map((s) => s.trim()).filter(Boolean) : [];
}
