import type { Complexity, ModuleId, PageKind, ProjectType, RateCard, Requirement } from "./types";

/**
 * Complexity is worked out from the project, not chosen by hand:
 * - basic:    landing page or business website with no server features
 * - advanced: shop or web app with many server features, or multilingual with payments / booking / chat
 * - standard: everything else (CMS, shops, apps, sites with login or admin...)
 */
export function autoComplexity(req: Pick<Requirement, "projectType" | "modules">, rates: RateCard): Complexity {
  const server = req.modules.filter((m) => rates.modules[m]?.backend);
  if ((req.projectType === "landing-page" || req.projectType === "business-website") && server.length === 0) return "basic";
  const heavy = req.modules.includes("multilingual") && req.modules.some((m) => m === "payments" || m === "booking" || m === "chat");
  if (((req.projectType === "ecommerce" || req.projectType === "web-app") && server.length >= 5) || heavy) return "advanced";
  return "standard";
}

/**
 * Requirement classification: what is a billable page, what is a small
 * supporting page, and what is a shared component that is never a page.
 * Pure, so the live estimate, the server and the tests agree.
 */

/** Words that make up names of shared parts of every page (header, footer, navigation...). */
const COMPONENT_CORE = new Set(["header", "footer", "nav", "navigation", "navbar", "menu", "menubar", "sidebar", "layout", "button", "buttons", "card", "cards", "breadcrumb", "breadcrumbs", "banner", "topbar", "hamburger"]);
const COMPONENT_FILLER = new Set(["site", "main", "global", "common", "shared", "mobile", "top", "sticky", "responsive", "reusable", "primary", "and", "&", "with", "section", "component", "components", "bar", "cookie", "consent", "back", "to", "the", "page", "layouts", "ui"]);

/** True for "Header", "Footer", "Mobile navigation", "Header & footer", "Reusable cards"... */
export function isSharedComponent(name: string): boolean {
  const words = name.toLowerCase().replace(/[^a-z&]+/g, " ").trim().split(/\s+/).filter(Boolean);
  return words.length > 0 && words.some((w) => COMPONENT_CORE.has(w)) && words.every((w) => COMPONENT_CORE.has(w) || COMPONENT_FILLER.has(w));
}

/** Small utility pages that come with the set-up: 404, thank-you, coming soon, maintenance. */
const SUPPORTING_RE = /\b(404|not[ -]?found|error page|thank[ -]?you|coming soon|maintenance|under construction|offline)\b/i;

export function defaultPageKind(name: string): PageKind {
  return SUPPORTING_RE.test(name) ? "supporting" : "main";
}

/** The page's kind: set by the team, else worked out from its name. */
export function pageKind(req: Pick<Requirement, "pageDetails">, page: string): PageKind {
  return req.pageDetails?.[page]?.kind ?? defaultPageKind(page);
}

/** Pages that are priced one by one. */
export const billablePages = (req: Pick<Requirement, "pages" | "pageDetails">) => req.pages.filter((p) => pageKind(req, p) === "main");
/** Pages included in the set-up at no extra charge. */
export const supportingPages = (req: Pick<Requirement, "pages" | "pageDetails">) => req.pages.filter((p) => pageKind(req, p) === "supporting");

/** Splits a raw page list (from the AI or the team) into pages and shared components. */
export function splitPages(names: string[]): { pages: string[]; components: string[] } {
  const pages: string[] = [];
  const components: string[] = [];
  for (const raw of names) {
    const name = raw.trim();
    if (!name) continue;
    const list = isSharedComponent(name) ? components : pages;
    if (!list.some((x) => x.toLowerCase() === name.toLowerCase())) list.push(name);
  }
  return { pages, components };
}

/** Legal pages a site of this kind usually has. Suggested only; never added unless the client asks. */
export function legalPagesFor(type: ProjectType): string[] {
  const pages = ["Privacy policy", "Terms & conditions"];
  if (type === "ecommerce") pages.push("Refund & cancellation policy", "Shipping policy");
  return pages;
}
const LEGAL_MATCH: Record<string, RegExp> = {
  "Privacy policy": /privacy/i,
  "Terms & conditions": /terms/i,
  "Refund & cancellation policy": /refund|cancellation|return/i,
  "Shipping policy": /shipping|delivery polic/i,
};
export const isLegalPage = (page: string) => Object.values(LEGAL_MATCH).some((re) => re.test(page));

/** Optional pages: suggested to the client but not in the scope (and not priced). */
export function optionalPageSuggestions(req: Pick<Requirement, "pages" | "projectType" | "scope">): string[] {
  if (req.scope === "module") return [];
  return legalPagesFor(req.projectType).filter((name) => !req.pages.some((p) => LEGAL_MATCH[name].test(p)));
}

/** Features the client marked as must-have can never be moved to Phase 2 or left out to fit a budget. */
export const isOptionalFeature = (req: Pick<Requirement, "mustHave">, m: ModuleId) => !(req.mustHave ?? []).includes(m);

/** Moves an optional feature to Phase 2 (kept on record, not priced). Must-haves stay. */
export function moveToPhase2(req: Requirement, m: ModuleId): Requirement {
  if (!req.modules.includes(m) || !isOptionalFeature(req, m)) return req;
  return { ...req, modules: req.modules.filter((x) => x !== m), deferredModules: [...new Set([...(req.deferredModules ?? []), m])] };
}

/** Brings a Phase 2 feature back into this quotation. */
export function restoreFromPhase2(req: Requirement, m: ModuleId): Requirement {
  return { ...req, modules: req.modules.includes(m) ? req.modules : [...req.modules, m], deferredModules: (req.deferredModules ?? []).filter((x) => x !== m) };
}

/** Brings a Phase 2 page back into this quotation. */
export function restorePage(req: Requirement, page: string): Requirement {
  return { ...req, pages: req.pages.includes(page) ? req.pages : [...req.pages, page], deferredPages: (req.deferredPages ?? []).filter((p) => p !== page) };
}

/** Most important pages first: Home, Contact, About, Services / Products, then the client's order. */
export function pagePriority(pages: string[]): string[] {
  const rank = (p: string) => (/^home\b/i.test(p) ? 0 : /contact/i.test(p) ? 1 : /about/i.test(p) ? 2 : /service|product|portfolio/i.test(p) ? 3 : 4);
  return pages.map((p, i) => ({ p, i })).sort((a, b) => rank(a.p) - rank(b.p) || a.i - b.i).map((x) => x.p);
}

/**
 * Applies a budget page plan the client agreed to: the planned pages stay,
 * the other requested pages move to Phase 2 (kept on record). The contact
 * form becomes a must-have when it was part of the plan, otherwise it waits in Phase 2.
 */
export function applyPagePlan(req: Requirement, plan: { pages: string[]; contactForm: boolean; sections?: Record<string, number> }): Requirement {
  const keep = new Set(plan.pages);
  const main = billablePages(req);
  // Compact plans also set the page sizes they were priced with.
  const pageDetails = { ...(req.pageDetails ?? {}) };
  for (const [page, sections] of Object.entries(plan.sections ?? {})) pageDetails[page] = { ...pageDetails[page], purpose: pageDetails[page]?.purpose ?? "", sections };
  let next: Requirement = {
    ...req,
    pageDetails,
    pages: req.pages.filter((p) => keep.has(p) || !main.includes(p)),
    deferredPages: [...new Set([...(req.deferredPages ?? []), ...main.filter((p) => !keep.has(p))])],
  };
  if (plan.contactForm) {
    next = restoreFromPhase2(next, "contact-form");
    next = { ...next, mustHave: [...new Set([...(next.mustHave ?? []), "contact-form" as ModuleId])] };
  } else if (next.modules.includes("contact-form")) {
    next = moveToPhase2({ ...next, mustHave: (next.mustHave ?? []).filter((m) => m !== "contact-form") }, "contact-form");
  }
  return next;
}

/** Everything in the scope, grouped, for the review screen and the team's quotation view. */
export function scopeSummary(req: Requirement, rates: RateCard) {
  const label = (m: ModuleId) => rates.modules[m]?.label ?? m;
  return {
    pages: billablePages(req),
    supportingPages: supportingPages(req),
    optionalPages: optionalPageSuggestions(req),
    sharedComponents: req.sharedComponents?.length ? req.sharedComponents : ["Header", "Footer", "Navigation (desktop and mobile)"],
    includedFeatures: req.modules.filter((m) => !isOptionalFeature(req, m)).map(label),
    optionalFeatures: req.modules.filter((m) => isOptionalFeature(req, m)).map(label),
    phase2: [...(req.deferredModules ?? []).map(label), ...(req.deferredPages ?? []).map((p) => `${p} page`)],
    notInPackage: (req.excludedModules ?? []).map(label),
    quality: req.qualityRequirements?.length ? req.qualityRequirements : ["Responsive on mobile, tablet and desktop", "Basic SEO (titles, descriptions, sitemap)", "Cross-browser testing"],
    externalServices: req.externalServices ?? [],
  };
}
