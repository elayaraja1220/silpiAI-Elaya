import { agreeLines, consensus, itemsFromDraft, legacyLists } from "./clarifications";
import { isSharedComponent } from "./scope";
import { MODULES, type ModuleId, type ProjectType, type RequirementDraft } from "./types";

/**
 * Makes a document analysis repeatable (pure).
 *
 * The AI reads a document differently every time: it may list "About" or "About Us" or "Who we are", split one page into
 * two, or count more sections. The price must not depend on that. So:
 *   1. the same document is analysed several times and only what most runs agree on is kept (consensus);
 *   2. every page is reduced to the CONCEPT it stands for (wording and word order are ignored), so the same idea named
 *      differently is one page, and always gets the same name;
 *   3. section counts are not taken from the AI at all: the pricing engine's own rules decide them;
 *   4. everything is put in a fixed order, so the order the AI wrote things in cannot change anything;
 *   5. the project type follows from the pages and features that remain.
 * The same set of concepts therefore always produces the same draft, and the same estimate.
 */

/** Bump when these rules change: saved analyses made with older rules are then ignored. */
export const ANALYSIS_VERSION = "2026-11-24.2";

// ---- page concepts --------------------------------------------------------------------------------------------------------------

/** Wording that means the same page. Applied before the words are compared. */
const SYNONYMS: [RegExp, string][] = [
  [/\bhome ?page\b|\blanding( page)?\b|\bmain page\b|\bindex\b|\bwelcome\b/g, "home"],
  [/\babout( us)?\b|\bwho we are\b|\bour story\b|\bour company\b|\bcompany( profile| overview| introduction| history)?\b|\bour history\b|\bvision and mission\b/g, "about"],
  [/\bcontacts?( us)?\b|\bget in touch\b|\breach us\b|\bwrite to us\b|\benquir(y|ies)\b|\binquir(y|ies)\b/g, "contact"],
  [/\bsign ?in\b|\blog ?in\b|\bauthentication\b/g, "login"],
  [/\bsign ?up\b|\bregistration\b|\bregister\b|\bcreate account\b/g, "register"],
  [/\bwhat we do\b|\bour services?\b|\boffering(s)?\b|\bsolutions?\b/g, "service"],
  [/\bour products?\b|\bshop\b|\bstore\b|\bcatalog(ue)?\b|\bmerchandise\b/g, "product"],
  [/\bphotos?\b|\bimages?\b|\bphoto gallery\b|\bmedia gallery\b/g, "gallery"],
  [/\bnews\b|\barticles?\b|\bblogs?\b/g, "blog"],
  [/\bfaqs?\b|\bfrequently asked questions\b/g, "faq"],
  [/\bplans?\b|\bpricing\b|\brates?\b/g, "pricing"],
  [/\breviews?\b|\btestimonials?\b|\bclient (stories|feedback)\b|\bcustomer (stories|feedback|reviews)\b/g, "testimonial"],
  [/\bcareers?\b|\bjoin us\b|\bwork with us\b/g, "career"],
  [/\bour team\b|\bmeet the team\b|\bteam\b|\bleadership\b/g, "team"],
  [/\bshopping cart\b|\bbasket\b|\bcart\b/g, "cart"],
  [/\bcheck ?out\b|\bcheckout\b|\bpayment page\b/g, "checkout"],
  [/\bprivacy( policy| notice| statement)?\b/g, "privacy"],
  [/\bterms( and conditions| of (use|service))?\b|\bt&c\b/g, "terms"],
  [/\brefund(s)?( and| &)? ?(cancellation|return)s?( policy)?\b|\bcancellation( and refund)? policy\b|\brefund policy\b/g, "refund"],
  [/\bdash ?board\b|\bmy account\b/g, "dashboard"],
];

const STOP = new Set(["page", "pages", "the", "a", "an", "and", "of", "our", "us", "my", "your", "for", "with", "section", "module", "screen", "view", "form", "in", "to"]);
const KEEP_S = new Set(["news", "analytics", "status", "address", "business", "process", "access", "series", "ios"]);

const singular = (w: string): string => {
  if (w.length <= 3 || KEEP_S.has(w)) return w;
  if (w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (w.endsWith("ss") || w.endsWith("us") || !w.endsWith("s")) return w;
  return w.slice(0, -1);
};

/** The concept of a page name: wording, plurals, order of words and filler are all ignored. */
export function pageKey(name: string): string {
  let text = ` ${name.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim()} `;
  for (const [re, to] of SYNONYMS) text = text.replace(re, ` ${to} `);
  const words = text.split(/\s+/).filter((w) => w && !STOP.has(w)).map(singular);
  return [...new Set(words)].sort().join(" ");
}

/** The name every analysis uses for a page it recognises, whatever the document called it. */
const CANONICAL: Record<string, string> = {
  home: "Home",
  about: "About Us",
  service: "Services",
  product: "Products",
  gallery: "Gallery",
  blog: "Blog",
  pricing: "Pricing",
  faq: "FAQ",
  testimonial: "Testimonials",
  career: "Careers",
  team: "Our Team",
  contact: "Contact Us",
  cart: "Cart",
  checkout: "Checkout",
  login: "Login",
  register: "Register",
  "login register": "Login & Register",
  privacy: "Privacy Policy",
  terms: "Terms & Conditions",
  refund: "Refund & Cancellation Policy",
  dashboard: "Dashboard",
};

/** Where recognised pages go: Home first, Contact last, everything else in between in alphabetical order. */
const ORDER = ["home", "about", "service", "product", "gallery", "team", "pricing", "testimonial", "blog", "faq", "career", "cart", "checkout", "login", "login register", "register", "dashboard", "privacy", "terms", "refund", "contact"];
const rank = (key: string) => (key === "contact" ? 900 : ORDER.includes(key) ? ORDER.indexOf(key) : 500);

/** Small utility pages (included in the set-up, never billed). Fixed names. */
const SUPPORTING: [RegExp, string][] = [
  [/\b404\b|not[ -]?found|error page/i, "404 Not Found"],
  [/thank[ -]?you/i, "Thank You"],
  [/coming soon/i, "Coming Soon"],
  [/maintenance|under construction|offline/i, "Maintenance"],
];
const supportingName = (name: string): string | null => SUPPORTING.find(([re]) => re.test(name))?.[1] ?? null;

const clean = (s: string) => s.replace(/\s+/g, " ").trim();
const titleCase = (s: string) => s.replace(/\b([a-z])/g, (m) => m.toUpperCase());

// ---- consensus ------------------------------------------------------------------------------------------------------------------

/** How many runs must agree: a majority (all of them when two, because one of two is not a majority). */
export const needed = (runs: number): number => Math.floor(runs / 2) + 1;

type Vote = { count: number; names: string[] };
function tally(lists: string[][], keyOf: (s: string) => string): Map<string, Vote> {
  const out = new Map<string, Vote>();
  for (const list of lists) {
    // A run counts once per concept, however many times it wrote it.
    const seen = new Set<string>();
    for (const raw of list) {
      const name = clean(raw);
      const key = keyOf(name);
      if (!name || !key || seen.has(key)) continue;
      seen.add(key);
      const v = out.get(key) ?? { count: 0, names: [] };
      v.count += 1;
      v.names.push(name);
      out.set(key, v);
    }
  }
  return out;
}

/** The most common value; ties go to the one that sorts first, so the answer never depends on the order of the runs. */
function mode<T extends string | number | boolean>(values: T[], fallback: T): T {
  if (values.length === 0) return fallback;
  const counts = new Map<T, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || (String(a[0]) < String(b[0]) ? -1 : 1))[0][0];
}

/** A value at least `min` runs gave exactly (budget, deadline); otherwise 0. */
function agreed(values: number[], min: number): number {
  const counts = new Map<number, number>();
  for (const v of values) if (v > 0) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].filter(([, c]) => c >= min).sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? 0;
}

/** Features that need a login, so they mean the project is an application. */
const APP_MODULES: ModuleId[] = ["admin-panel", "reports", "booking"];

/** The kind of project, from what is actually in it. */
export function deriveProjectType(pageKeys: string[], modules: ModuleId[], majority: ProjectType | null): ProjectType {
  const has = (k: string) => pageKeys.includes(k);
  // The runs' own majority is kept for the two kinds that carry the most price, so a clear "shop" or "app" is never downgraded.
  if (majority === "ecommerce" || majority === "web-app") return majority;
  if (modules.includes("payments") || (has("cart") && has("checkout"))) return "ecommerce";
  if (modules.includes("auth") && (modules.some((m) => APP_MODULES.includes(m)) || has("dashboard"))) return "web-app";
  if (modules.includes("admin-panel") || modules.includes("blog")) return "cms-website";
  if (pageKeys.length <= 1 && !modules.some((m) => m === "auth" || m === "payments" || m === "booking")) return "landing-page";
  return "business-website";
}

const isDraftLike = (d: unknown): d is RequirementDraft => !!d && typeof d === "object" && Array.isArray((d as RequirementDraft).pages) && Array.isArray((d as RequirementDraft).modules);

/**
 * Turns several analyses of the same document into one repeatable draft.
 * `sectionsFor` is the pricing engine's own section count for a page name (never the AI's number).
 */
export function stableDraft(input: unknown[], sectionsFor: (page: string) => number): RequirementDraft {
  const runs = input.filter(isDraftLike);
  if (runs.length === 0) throw new Error("There is no analysis to combine.");
  const min = needed(runs.length);
  // The first run supplies the wording that has no price (title, summary, notes). The rest is decided by all runs together.
  const [first] = runs;

  // Pages: by concept.
  // Header, footer, navigation and the like are parts of every page, and 404 / thank-you pages are included in the set-up: neither is a page.
  const mainLists = runs.map((r) => r.pages.map((p) => p.name).filter((n) => !supportingName(n) && !isSharedComponent(n)));
  const pageVotes = tally(mainLists, pageKey);
  // If the runs share no page at all, keep every page seen rather than none.
  const agreedPages = [...pageVotes.entries()].filter(([, v]) => v.count >= min);
  const kept = agreedPages.length > 0 ? agreedPages : [...pageVotes.entries()];
  const pages = kept
    .map(([key, v]) => {
      const names = [...new Set(v.names)].sort((a, b) => a.length - b.length || (a < b ? -1 : 1));
      return { key, name: CANONICAL[key] ?? titleCase(names[0]) };
    })
    .sort((a, b) => rank(a.key) - rank(b.key) || (a.name < b.name ? -1 : 1));
  const purposeOf = (key: string) => first.pages.find((p) => pageKey(p.name) === key)?.purpose?.trim() ?? "";

  // Utility pages and shared parts.
  const supportLists = runs.map((r) => [...r.supportingPages ?? [], ...r.pages.map((p) => p.name)].map(supportingName).filter((n): n is string => !!n));
  const supporting = [...tally(supportLists, (s) => s).entries()].filter(([, v]) => v.count >= min).map(([k]) => k).sort();
  const sharedVotes = tally(runs.map((r) => [...(r.sharedComponents ?? []), ...r.pages.map((p) => p.name).filter(isSharedComponent)]), pageKey);
  const shared = [...sharedVotes.entries()].filter(([, v]) => v.count >= min).map(([, v]) => titleCase([...new Set(v.names)].sort((a, b) => a.length - b.length || (a < b ? -1 : 1))[0])).sort();

  // Features.
  const moduleVotes = tally(runs.map((r) => r.modules as string[]), (s) => s);
  const modules = MODULES.filter((m) => (moduleVotes.get(m)?.count ?? 0) >= min);
  const mustVotes = tally(runs.map((r) => r.mustHave as string[]), (s) => s);
  const mustHave = modules.filter((m) => (mustVotes.get(m)?.count ?? 0) >= min);

  const typeVotes = tally(runs.map((r) => [r.projectType]), (s) => s);
  const majority = ([...typeVotes.entries()].find(([, v]) => v.count >= min)?.[0] as ProjectType | undefined) ?? null;
  const projectType = deriveProjectType(pages.map((p) => p.key), modules, majority);

  // Questions, answers and assumptions: kept as tracked items, so a question the client answered is never counted as open,
  // the same question worded twice is one question, and only what most readings agree on is kept.
  const exclusions = agreeLines(runs.map((r) => r.exclusions ?? []), min);
  // Requirements the document states are grounded in its own text, so a reading that found one is enough (the readings word them
  // differently, and a majority vote on wording threw them all away). Questions, assumptions and proposals need a majority.
  const tracked = consensus(runs.map((r) => itemsFromDraft(r).items), (kind) => (kind === "requirement" ? 1 : min));
  const requirementItems = tracked.filter((i) => i.kind === "requirement");
  const confirmed = requirementItems.length > 0 ? requirementItems.map((i) => i.text) : agreeLines(runs.map((r) => r.confirmed ?? []), min);
  const discoveredItems = tracked.filter((i) => i.kind === "discovered");
  const questions = tracked.filter((i) => i.kind === "question");
  const assumptionItems = tracked.filter((i) => i.kind === "assumption");

  const techVotes = tally(runs.map((r) => r.technologyPreference ?? []), (s) => s.toLowerCase());

  return {
    ...first,
    client: first.client,
    projectType,
    scope: mode(runs.map((r) => r.scope), "full"),
    complexity: mode(runs.map((r) => r.complexity), "standard"),
    design: mode(runs.map((r) => r.design), "ai"),
    pages: pages.map((p) => ({ name: p.name, sections: sectionsFor(p.name), purpose: purposeOf(p.key) })),
    supportingPages: supporting,
    sharedComponents: shared,
    modules,
    mustHave,
    needsDomain: mode(runs.map((r) => r.needsDomain), false),
    needsHosting: mode(runs.map((r) => r.needsHosting), false),
    confirmed,
    exclusions,
    requirements: requirementItems.map((r) => ({ text: r.text, source: r.source ?? "", type: r.type ?? "functional", area: r.area ?? "", complexity: r.complexity ?? "" })),
    discovered: discoveredItems.map((d) => ({ item: d.text, reason: d.reason ?? "", source: d.source ?? "", impact: d.impact ?? "medium", module: d.module ?? "" })),
    questionnaire: questions.map((q) => ({ question: q.text, answer: q.answer, status: q.status === "confirmed" ? "answered" : q.status === "not-applicable" ? "not-applicable" : "unanswered", critical: q.critical, priority: q.priority, source: q.source ?? "", origin: q.origin })),
    missingInfo: legacyLists(questions).questions,
    assumptions: assumptionItems.map((a) => a.text),
    approvedAssumptions: assumptionItems.filter((a) => a.status === "confirmed").map((a) => a.text),
    approvalInfo: agreeLines(runs.map((r) => r.approvalInfo ?? []), min),
    deadlineWeeks: agreed(runs.map((r) => r.deadlineWeeks || 0), min),
    clientBudget: agreed(runs.map((r) => r.clientBudget || 0), min),
    technologyPreference: [...techVotes.entries()].filter(([, v]) => v.count >= min).map(([, v]) => [...new Set(v.names)].sort()[0]).sort(),
  };
}
