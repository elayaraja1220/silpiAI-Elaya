import { pagePlan, NEAR_BUDGET_SHARE } from "./budget";
import { formatMoney } from "./money";
import { buildQuote, needsBackend, quoteMoney } from "./pricing";
import {
  CATALOG_LAYERS,
  DEFAULT_TECH_CATALOG,
  LEVELS,
  SCALES,
  checkStack,
  findTech,
  type CatalogLayer,
  type Level,
  type Scale,
  type TechEntry,
} from "./tech-catalog";
import { listLabels, unmatchedNames, withDependencies } from "./tech-preference";
import type { Client, ClientTech, ModuleId, PagePlan, ProjectType, RateCard, Requirement } from "./types";

/**
 * Technology recommendation engine (step 2). Pure and reusable: it reads a
 * requirement, an optional budget, the shared technology catalog and the rate
 * card, and returns ranked, explained stack options. It changes nothing.
 *
 * Rules it follows:
 * - Only enabled catalog technologies are used, and every option passes `checkStack`.
 * - The recommendation comes from what the project needs (type, features, pages,
 *   complexity, stated users / scale / security), not from the budget. A bigger
 *   budget never makes a heavier stack more suitable.
 * - Information that is missing is listed, never invented. Where a typical
 *   default is used (for example the usual scale of a shop) it is named as an assumption.
 * - Development cost is calculated with the existing `buildQuote` (the catalog's
 *   cost impact is applied through a copy of the rate card; the real one is not touched).
 *   Prices are never reduced to fit a budget; a mismatch is reported instead.
 * - Domain, hosting and other running costs are never part of the estimate.
 * - Technology the client asked for is kept apart from our recommendations. If it
 *   is enabled and compatible it is used as asked; if not, the reason is given and
 *   the alternatives are marked as needing the client's confirmation first.
 */

// ---- Types ------------------------------------------------------------------

/** What the client or team knows beyond the requirement. Every field is optional. */
export type RecommendationNeeds = {
  /** Expected number of users. */
  expectedUsers?: Scale;
  /** Expected traffic. */
  traffic?: Scale;
  /** How far the project may need to grow. */
  scalability?: Scale;
  /** "high" for sensitive data (health, finance, identity) or a formal security requirement. */
  security?: "standard" | "high";
};

export type RecommendationOptions = {
  needs?: RecommendationNeeds;
  /** Used for GST in the estimate; defaults to the business's own state. */
  client?: Pick<Client, "state" | "currency">;
  /** How many ranked options to return (default 3). */
  maxOptions?: number;
  /** Technology the client asked for; defaults to the requirement's own clientTech. */
  clientTech?: ClientTech;
};

export type TechRef = { id: string; label: string };
export type DemandLevel = "light" | "standard" | "heavy";
export type SecurityLevel = "standard" | "elevated" | "high";

export type ResolvedNeeds = {
  needsBackend: boolean;
  demand: DemandLevel;
  scale: Scale;
  scaleSource: "stated" | "assumed";
  security: SecurityLevel;
  securitySource: "stated" | "inferred" | "assumed";
  /** Defaults that were used because the information was missing. */
  assumptions: string[];
  /** Useful information that was not provided. */
  missing: string[];
  confidence: "high" | "medium" | "low";
};

export type BudgetComparison = {
  status: "none" | "within" | "near" | "over";
  amount: number;
  /** Estimated development total incl. GST, when it could be calculated. */
  total?: number;
  /** budget - total: positive = remaining, negative = over. */
  difference?: number;
};

export type RecommendedOption = {
  rank: number;
  /** "client": built on the technology the client asked for. "recommended": our suggestion (needs the client's confirmation when a request could not be used). */
  source: "client" | "recommended";
  /** 0-100: how well the stack fits this project (higher is better). */
  score: number;
  stack: Record<CatalogLayer, TechRef[]>;
  /** Every technology id in the stack (frontend, backend, database and hosting). */
  ids: string[];
  /** Other enabled, compatible hosting for the same stack. */
  hostingAlternatives: TechRef[];
  complexity: Level;
  maintenance: Level;
  /** Combined development cost impact from the catalog (1 = our standard). */
  devFactor: number;
  /** Largest scale every part of the stack is suited for. */
  scalability: Scale;
  security: string[];
  /** False when a hard need (scale, high security) is not met. */
  meetsRequirements: boolean;
  /** Development only, incl. GST. Absent when it could not be calculated. Domain and hosting are never included. */
  estimate?: { hours: number; subtotal: number; gst: number; total: number };
  budget: BudgetComparison;
  reasons: string[];
  tradeoffs: string[];
};

export type PreferenceStatus = "none" | "honoured" | "needs-confirmation";

/** What the client asked for, kept apart from our recommendations. */
export type ClientPreferenceResult = {
  status: PreferenceStatus;
  /** As written by the client. */
  stated: string[];
  /** The matching catalog technologies plus what they depend on (Laravel needs PHP). */
  requestedIds: string[];
  /** Why the request cannot be used as it is (disabled, unknown or incompatible). */
  problems: string[];
  /** True when the technology in use is an alternative the client already confirmed. */
  confirmedAlternative: boolean;
  /** Set when the client must confirm an alternative before it is used. */
  confirmation?: string;
};

export type Recommendation = {
  options: RecommendedOption[];
  clientPreference: ClientPreferenceResult;
  /** True when a requested technology cannot be used: nothing may replace it until the client confirms. */
  requiresConfirmation: boolean;
  needs: ResolvedNeeds;
  notes: string[];
  /** Combinations that were considered and refused as incompatible (a sample). */
  rejected: { ids: string[]; issues: string[] }[];
  rejectedCount: number;
  /** Set when the best option is over budget: what the budget can build instead. */
  budgetPlan?: PagePlan;
  /** Problems found in the catalog that was passed in. */
  catalogProblems: string[];
  separateCosts: string;
};

export const SEPARATE_COSTS_NOTICE =
  "Domain, hosting, VPS or cloud plans, database subscriptions, third-party APIs, payment gateway charges and maintenance are paid separately by the client. None of them is part of the development estimate.";

// ---- Small helpers ------------------------------------------------------------

const SCALE_RANK: Record<Scale, number> = { small: 1, medium: 2, large: 3 };
const LEVEL_RANK: Record<Level, number> = { low: 0, medium: 1, high: 2 };
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
const maxScale = (e: TechEntry): number => Math.max(0, ...e.scalability.map((s) => SCALE_RANK[s] ?? 0));
const maxLevel = (levels: Level[]): Level => levels.reduce<Level>((a, b) => (LEVEL_RANK[b] > LEVEL_RANK[a] ? b : a), "low");
const scaleOf = (rank: number): Scale => (rank >= 3 ? "large" : rank === 2 ? "medium" : "small");
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Keeps only well-formed catalog entries; reports the rest instead of failing. */
export function usableCatalog(catalog: unknown): { entries: TechEntry[]; problems: string[] } {
  if (!Array.isArray(catalog)) return { entries: [], problems: ["The technology catalog is missing or is not a list."] };
  const entries: TechEntry[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  catalog.forEach((raw, i) => {
    const e = raw as Partial<TechEntry> | null;
    const ok =
      isObj(e) &&
      typeof e.id === "string" && e.id.length > 0 &&
      typeof e.label === "string" &&
      (CATALOG_LAYERS as readonly string[]).includes(e.layer as string) &&
      typeof e.kind === "string" &&
      typeof e.enabled === "boolean" &&
      strings(e.projectTypes) && strings(e.scalability) && strings(e.security) && strings(e.requires) && strings(e.incompatibleWith) &&
      typeof e.devFactor === "number" && Number.isFinite(e.devFactor) && e.devFactor > 0 &&
      (LEVELS as readonly string[]).includes(e.maintenance as string);
    if (!ok) {
      problems.push(`Catalog entry #${i + 1}${isObj(raw) && typeof raw.id === "string" ? ` ("${raw.id}")` : ""} is invalid and was ignored.`);
    } else if (seen.has(String(e?.id))) {
      problems.push(`Catalog entry "${String(e?.id)}" appears twice; the first one is used.`);
    } else {
      seen.add(String(e?.id));
      entries.push(e as TechEntry);
    }
  });
  return { entries, problems };
}

// ---- What the project needs ---------------------------------------------------

/** Typical size when nobody stated one; always reported as an assumption. */
const TYPICAL_SCALE: Record<ProjectType, Scale> = { "landing-page": "small", "business-website": "small", "cms-website": "small", ecommerce: "medium", "web-app": "medium" };

const FEATURE_WEIGHT: Partial<Record<ModuleId, number>> = {
  payments: 2, chat: 2, auth: 1, "admin-panel": 1, reports: 1, booking: 1, search: 1, "api-integration": 1, notifications: 1,
};
const TYPE_WEIGHT: Record<ProjectType, number> = { "landing-page": 0, "business-website": 0, "cms-website": 1, ecommerce: 2, "web-app": 3 };

export function resolveNeeds(req: Requirement, rates: RateCard, needs: RecommendationNeeds = {}): ResolvedNeeds {
  const modules = Array.isArray(req.modules) ? req.modules : [];
  const pages = Array.isArray(req.pages) ? req.pages : [];
  const assumptions: string[] = [];
  const missing: string[] = [];
  const backend = needsBackend(req, rates);

  // Scale: the largest of what was stated; otherwise the usual size for this kind of project.
  const stated = [needs.expectedUsers, needs.traffic, needs.scalability].filter((s): s is Scale => !!s && s in SCALE_RANK);
  let scale: Scale;
  let scaleSource: ResolvedNeeds["scaleSource"];
  if (stated.length) {
    scale = scaleOf(Math.max(...stated.map((s) => SCALE_RANK[s])));
    scaleSource = "stated";
  } else {
    scale = TYPICAL_SCALE[req.projectType] ?? "small";
    scaleSource = "assumed";
    missing.push("Expected users, traffic and growth were not provided.");
    assumptions.push(`Assumed ${scale} scale, which is typical for this project type (${rates.projectTypes[req.projectType]?.label ?? "website"}).`);
  }

  // Security: stated, otherwise inferred from features that handle accounts or money.
  let security: SecurityLevel = "standard";
  let securitySource: ResolvedNeeds["securitySource"] = "assumed";
  if (needs.security === "high") {
    security = "high";
    securitySource = "stated";
  } else {
    const sensitive = modules.filter((m) => m === "payments" || m === "auth" || m === "admin-panel");
    if (sensitive.length) {
      security = "elevated";
      securitySource = "inferred";
      assumptions.push(`Security treated as elevated because the project includes ${sensitive.join(", ")}.`);
    } else if (needs.security === "standard") {
      securitySource = "stated";
    } else {
      missing.push("No security requirement was provided.");
    }
  }

  // Demand: how demanding the project is, from facts only.
  let points = TYPE_WEIGHT[req.projectType] ?? 0;
  points += modules.reduce((sum, m) => sum + (FEATURE_WEIGHT[m] ?? 0), 0);
  if (req.complexity === "advanced") points += 2;
  if (pages.length >= 15) points += 1;
  if (pages.length >= 30) points += 1;
  if (scaleSource === "stated") points += SCALE_RANK[scale] - 1;
  if (security === "high") points += 2;
  const demand: DemandLevel = points <= 1 ? "light" : points <= 4 ? "standard" : "heavy";

  if (!pages.length && !modules.length) missing.push("No pages or features were listed.");
  const confidence: ResolvedNeeds["confidence"] = !pages.length && !modules.length ? "low" : scaleSource === "stated" && securitySource === "stated" ? "high" : "medium";
  return { needsBackend: backend, demand, scale, scaleSource, security, securitySource, assumptions, missing, confidence };
}

// ---- Candidate stacks ---------------------------------------------------------

const FRONTENDS: string[][] = [
  ["html", "css", "javascript"],
  ["html", "css", "javascript", "bootstrap"],
  ["html", "css", "javascript", "jquery"],
  ["html", "css", "javascript", "jquery", "bootstrap"],
  ["javascript", "react"],
  ["javascript", "nextjs"],
  ["javascript", "angular"],
];
const BACKENDS: string[][] = [[], ["php"], ["php", "laravel"], ["nodejs"], ["nodejs", "nestjs"]];
const DATABASES: string[][] = [[], ["mysql"], ["postgresql"], ["sqlite"], ["mongodb"]];

const JS_FRAMEWORKS = ["nextjs", "react", "angular"];
const SERVER_TYPES: ProjectType[] = ["cms-website", "ecommerce", "web-app"];

type Candidate = {
  frontend: string[];
  backend: string[];
  database: string[];
  hosting: string;
  entries: TechEntry[];
  tier: Level;
  complexity: Level;
  maintenance: Level;
  devFactor: number;
  supported: number;
  score: number;
  reasons: string[];
  tradeoffs: string[];
  blocked: string[];
};

const layerFactor = (entries: TechEntry[]) => (entries.length ? entries.reduce((s, e) => s + e.devFactor, 0) / entries.length : 1);

function describe(entries: TechEntry[], layer: CatalogLayer): TechRef[] {
  return entries.filter((e) => e.layer === layer).map((e) => ({ id: e.id, label: e.label }));
}

/** Scores one stack against the project's needs. Budget is added later, once the cost is known. */
function evaluate(req: Requirement, needs: ResolvedNeeds, f: string[], b: string[], d: string[], hosting: string, catalog: TechEntry[]): Candidate {
  const byId = new Map(catalog.map((e) => [e.id, e]));
  const ids = [...f, ...b, ...d, hosting];
  const entries = ids.map((id) => byId.get(id)!);
  const reasons: string[] = [];
  const tradeoffs: string[] = [];
  const blocked: string[] = [];
  let score = 50;
  const add = (points: number, reason?: string, tradeoff?: string) => {
    score += points;
    if (reason) reasons.push(reason);
    if (tradeoff) tradeoffs.push(tradeoff);
  };

  const frontendEntries = entries.filter((e) => e.layer === "frontend");
  const backendEntries = entries.filter((e) => e.layer === "backend");
  const databaseEntries = entries.filter((e) => e.layer === "database");
  const hostEntry = byId.get(hosting)!;

  // Complexity of the stack itself.
  const parts = (frontendEntries.some((e) => e.kind === "framework") ? 1 : 0) + (backendEntries.length ? 1 : 0) + (databaseEntries.length ? 1 : 0);
  const devFactor = round2(layerFactor(frontendEntries) * (backendEntries.length ? layerFactor(backendEntries) : 1) * (databaseEntries.length ? layerFactor(databaseEntries) : 1));
  const tier: Level = parts === 0 ? "low" : parts <= 3 && devFactor < 1.1 ? "medium" : "high";
  const complexity: Level = req.complexity === "advanced" ? (tier === "low" ? "medium" : "high") : tier;
  const maintenance = maxLevel(entries.map((e) => e.maintenance));

  // Scale: the weakest part decides (plain HTML, CSS and JavaScript do not limit it).
  const limiting = entries.filter((e) => !(e.layer === "frontend" && e.kind === "language"));
  const supported = limiting.length ? Math.min(...limiting.map(maxScale)) : 3;
  const required = SCALE_RANK[needs.scale];
  if (supported >= required) add(6, `Suited for ${needs.scale} scale${needs.scaleSource === "assumed" ? " (assumed)" : ""}.`);
  else {
    add(-35, undefined, `Only suited for ${scaleOf(supported)} scale; the project needs ${needs.scale}.`);
    blocked.push("scale");
  }

  // Right-sizing: a heavier stack is only better when the project needs it.
  if (needs.demand === "light") {
    if (tier === "low") add(20, "Right-sized: a simple project does not need a framework or server.");
    else if (tier === "medium") add(-15, undefined, "More technology than a simple project needs.");
    else add(-30, undefined, "Much more technology than a simple project needs.");
  } else if (needs.demand === "standard") {
    if (tier === "high") add(-10, undefined, "More complex than this project needs, so it costs more to build and maintain.");
    else add(10, "Appropriate size for the features requested.");
  } else {
    if (tier === "low") add(-25, undefined, "Too light for the features requested.");
    else add(8, tier === "medium" ? "Handles the requested features." : "Built for a demanding project.");
  }

  // A simple project is better without extra libraries.
  if (needs.demand === "light") score -= 2 * frontendEntries.filter((e) => e.kind === "library" || e.kind === "css-framework").length;

  // Maintenance.
  add({ low: 8, medium: 3, high: -8 }[maintenance], `${maintenance[0].toUpperCase()}${maintenance.slice(1)} maintenance effort after launch.`, maintenance === "high" ? "High maintenance effort: updates and server care are needed regularly." : undefined);

  // Security.
  if (needs.security !== "standard") {
    const high = needs.security === "high";
    if (hosting === "shared-hosting") {
      add(high ? -40 : -25, undefined, "Shared hosting is not recommended for accounts or payments.");
      if (high) blocked.push("security");
    } else add(4, `${hostEntry.label} gives more control over security for accounts and payments.`);
    if (ids.includes("sqlite")) {
      add(high ? -30 : -15, undefined, "SQLite is a single file and not suited to sensitive or multi-user data.");
      if (high) blocked.push("security");
    }
    if (ids.includes("jquery")) add(-10, undefined, "jQuery needs extra care to avoid script-injection issues.");
  }

  // Natural pairings.
  if (b.length) {
    const jsFront = f.some((id) => JS_FRAMEWORKS.includes(id));
    const jsBack = b.includes("nodejs");
    if ((jsFront && jsBack) || (!jsFront && !jsBack)) add(6, jsBack ? "One language (JavaScript) across frontend and backend." : "A classic, widely supported PHP setup.");
    else add(-8, undefined, "A less common frontend and backend pairing.");
    if (b.includes("php") && d.includes("mysql")) add(3);
    if (b.includes("nodejs") && d.includes("postgresql")) add(3);
    if (SERVER_TYPES.includes(req.projectType) && needs.demand !== "light" && !backendEntries.some((e) => e.kind === "framework")) {
      add(-8, undefined, "No backend framework: more code to write and test for a larger application.");
    }
  }

  // Hosting fit.
  if (!b.length) {
    if (hosting === "shared-hosting") add(needs.demand === "light" ? 8 : 4, "Shared hosting is enough for a site with no server.");
    else if (needs.demand === "light") add(-3);
  } else if (hosting !== "shared-hosting") add(needs.demand === "heavy" ? 6 : 2);

  if (needs.demand === "light" && !f.some((id) => JS_FRAMEWORKS.includes(id)) && !b.length) {
    reasons.push("Static site: fast, secure and cheap to host; the contact form can use a form service, so no server is needed.");
  }

  return { frontend: f, backend: b, database: d, hosting, entries, tier, complexity, maintenance, devFactor, supported, score, reasons, tradeoffs, blocked };
}

// ---- Cost -----------------------------------------------------------------------

/**
 * Development cost with the existing pricing: the stack's combined cost impact is
 * given to `buildQuote` through a copy of the rate card (the real card is untouched).
 */
function estimateFor(req: Requirement, client: Pick<Client, "state" | "currency">, rates: RateCard, devFactor: number): RecommendedOption["estimate"] | undefined {
  try {
    const trial: RateCard = { ...rates, stacks: { ...rates.stacks, custom: { ...rates.stacks.custom, devFactor } } };
    const quote = buildQuote({ ...req, stack: "custom", tech: undefined }, client, trial);
    return { hours: quote.totalHours, subtotal: quote.subtotal, gst: quote.gst.total, total: quote.grandTotal };
  } catch {
    return undefined;
  }
}

function compareBudget(budget: number, total: number | undefined): BudgetComparison {
  if (!(budget > 0)) return { status: "none", amount: 0, total };
  if (total === undefined) return { status: "none", amount: budget };
  const status = total > budget ? "over" : total >= budget * NEAR_BUDGET_SHARE ? "near" : "within";
  return { status, amount: budget, total, difference: budget - total };
}

// ---- What the client asked for -------------------------------------------------------

const NO_PREFERENCE: ClientPreferenceResult = { status: "none", stated: [], requestedIds: [], problems: [], confirmedAlternative: false };

/** Checks the client's requested technology against the catalog: enabled, known and compatible with itself. */
export function resolvePreference(tech: ClientTech | undefined, catalog: readonly TechEntry[]): ClientPreferenceResult {
  if (!tech || !Array.isArray(tech.stated) || tech.stated.length === 0) return NO_PREFERENCE;
  const confirmed = Array.isArray(tech.confirmedIds) && tech.confirmedIds.length > 0;
  const wanted = confirmed ? tech.confirmedIds! : (tech.ids ?? []);
  const requestedIds = withDependencies(wanted, catalog.length ? catalog : DEFAULT_TECH_CATALOG);
  const problems: string[] = [];
  if (!confirmed) for (const name of unmatchedNames(tech)) problems.push(`"${name}" is not in the technology catalog.`);
  for (const id of requestedIds) {
    const entry = findTech(catalog, id);
    if (!entry) problems.push(`"${id}" is not in the technology catalog.`);
    else if (!entry.enabled) problems.push(`${entry.label} is not currently offered.`);
  }
  for (const issue of checkStack(catalog, requestedIds).issues) if (issue.kind === "incompatible" || issue.kind === "missing-requirement") problems.push(issue.message);
  return { status: problems.length ? "needs-confirmation" : "honoured", stated: tech.stated, requestedIds, problems: [...new Set(problems)], confirmedAlternative: confirmed };
}

/** A stack uses the requested technology when it contains all of it and adds no extra frameworks or libraries. */
function usesRequested(c: { frontend: string[]; backend: string[]; database: string[]; hosting: string }, requested: string[], byId: Map<string, TechEntry>): boolean {
  const layers: Record<CatalogLayer, string[]> = { frontend: c.frontend, backend: c.backend, database: c.database, hosting: [c.hosting] };
  for (const layer of CATALOG_LAYERS) {
    const want = requested.filter((id) => byId.get(id)?.layer === layer);
    if (!want.length) continue;
    const have = layers[layer];
    if (!want.every((id) => have.includes(id))) return false;
    const allowed = layer === "frontend" ? ["html", "css", "javascript"] : [];
    if (have.some((id) => !want.includes(id) && !allowed.includes(id))) return false;
  }
  return true;
}

// ---- The engine -------------------------------------------------------------------

/**
 * Recommends technology stacks for a requirement. `budget` is the client's
 * development budget in ₹ incl. GST (0 or missing = not stated; the requirement's
 * own budget is used when this is undefined).
 */
export function recommendTechnology(
  requirement: Requirement,
  budget: number | undefined,
  catalog: readonly TechEntry[] | unknown,
  rates: RateCard,
  options: RecommendationOptions = {},
): Recommendation {
  const empty = (needs: ResolvedNeeds, notes: string[], problems: string[] = [], preference: ClientPreferenceResult = NO_PREFERENCE): Recommendation => ({
    options: [], clientPreference: preference, requiresConfirmation: preference.status === "needs-confirmation", needs, notes, rejected: [], rejectedCount: 0, catalogProblems: problems, separateCosts: SEPARATE_COSTS_NOTICE,
  });
  const blankNeeds: ResolvedNeeds = { needsBackend: false, demand: "light", scale: "small", scaleSource: "assumed", security: "standard", securitySource: "assumed", assumptions: [], missing: [], confidence: "low" };

  if (!isObj(requirement) || !rates?.projectTypes?.[requirement.projectType]) {
    return empty({ ...blankNeeds, missing: ["A valid requirement with a project type is needed."] }, ["No recommendation: the requirement is missing or has an unknown project type."]);
  }
  const { entries, problems } = usableCatalog(catalog);
  const needs = resolveNeeds(requirement, rates, options.needs);
  let preference = resolvePreference(options.clientTech ?? requirement.clientTech, entries);
  const askConfirmation = (p: ClientPreferenceResult): ClientPreferenceResult => ({
    ...p,
    status: "needs-confirmation",
    confirmation: `The client asked for ${p.stated.join(", ")}. ${p.problems.join(" ")} Please confirm an alternative with the client before it is used.`,
  });
  if (preference.status === "needs-confirmation") preference = askConfirmation(preference);
  const enabled = new Set(entries.filter((e) => e.enabled).map((e) => e.id));
  if (!enabled.size) {
    const stuck = preference.status === "none" ? preference : askConfirmation({ ...preference, problems: ["No technology is enabled in the catalog."] });
    return empty(needs, ["No technology is enabled in the catalog. Enable the technologies you deliver, then try again."], problems, stuck);
  }
  const type = requirement.projectType;
  const wanted = budget === undefined ? requirement.budget ?? 0 : budget;
  const client = options.client ?? { state: rates.business.state };
  // Amounts are held in rupees; the reasons are written in the quotation's currency.
  const formatINR = (n: number) => formatMoney(n, quoteMoney(client, rates));
  const byId = new Map(entries.map((e) => [e.id, e]));
  const hostings = entries.filter((e) => e.enabled && e.layer === "hosting").map((e) => e.id);

  // Enumerate stacks from enabled technologies only; refuse anything incompatible.
  const candidates: Candidate[] = [];
  const rejected: Recommendation["rejected"] = [];
  let rejectedCount = 0;
  for (const f of FRONTENDS) {
    if (!f.every((id) => enabled.has(id))) continue;
    for (const b of BACKENDS) {
      if (!b.every((id) => enabled.has(id)) || (needs.needsBackend ? !b.length : b.length)) continue;
      for (const d of DATABASES) {
        if (!d.every((id) => enabled.has(id)) || (needs.needsBackend ? !d.length : d.length)) continue;
        const app = [...f, ...b, ...d];
        // Suitability: every technology (except the plain frontend languages) must suit the project type.
        const unsuitable = app.some((id) => {
          const e = byId.get(id)!;
          return !(e.layer === "frontend" && e.kind === "language") && !e.projectTypes.includes(type);
        });
        if (unsuitable) continue;
        for (const h of hostings) {
          if (!byId.get(h)!.projectTypes.includes(type)) continue;
          const ids = [...app, h];
          const check = checkStack(entries, ids);
          if (!check.ok) {
            rejectedCount++;
            if (rejected.length < 8) rejected.push({ ids, issues: check.issues.map((i) => i.message) });
            continue;
          }
          candidates.push(evaluate(requirement, needs, f, b, d, h, entries));
        }
      }
    }
  }

  const notes: string[] = [...needs.missing];
  if (!candidates.length) {
    notes.push(`No enabled technologies can be combined for a ${type.replace("-", " ")}${needs.needsBackend ? " that needs a backend and database" : ""}. Enable more technologies in the catalog.`);
    const stuck = preference.status === "honoured" ? askConfirmation({ ...preference, problems: ["No enabled combination can be built for this project."] }) : preference;
    if (stuck.confirmation) notes.unshift(stuck.confirmation);
    return { ...empty(needs, notes, problems, stuck), rejected, rejectedCount };
  }

  // The client's own technology comes first. It is used only when it is enabled, compatible and can form a full stack.
  let pool = candidates;
  let source: RecommendedOption["source"] = "recommended";
  if (preference.status === "honoured") {
    const preferred = candidates.filter((c) => usesRequested(c, preference.requestedIds, byId));
    if (preferred.length) {
      pool = preferred;
      source = "client";
    } else {
      preference = askConfirmation({
        ...preference,
        problems: [`No enabled combination uses ${listLabels(preference.requestedIds, ", ")} and also fits this project${needs.needsBackend ? " (it needs a backend and a database)" : ""}.`],
      });
    }
  }
  if (preference.confirmation) notes.unshift(preference.confirmation);

  // One option per application stack: keep its best hosting, list the others as alternatives.
  const groups = new Map<string, Candidate[]>();
  for (const c of pool) {
    const key = [...c.frontend, "|", ...c.backend, "|", ...c.database].join(",");
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  const best = [...groups.values()]
    .map((list) => {
      const sorted = [...list].sort((a, b) => b.score - a.score || a.hosting.localeCompare(b.hosting));
      return { top: sorted[0], alternatives: sorted.slice(1).map((c) => c.hosting) };
    })
    .sort((a, b) => b.top.score - a.top.score || a.top.devFactor - b.top.devFactor);

  // Cost and budget for the strongest stacks, then the final ranking.
  const finalists = best.slice(0, 10).map(({ top, alternatives }) => ({ top, alternatives, estimate: estimateFor(requirement, client, rates, top.devFactor) }));
  const totals = finalists.map((x) => x.estimate?.total).filter((t): t is number => t !== undefined);
  const lo = Math.min(...totals);
  const hi = Math.max(...totals);
  const scored = finalists.map((x) => {
    const c = x.top;
    let score = c.score;
    const reasons = [...c.reasons];
    const tradeoffs = [...c.tradeoffs];
    const comparison = compareBudget(wanted, x.estimate?.total);
    if (x.estimate && hi > lo) score += Math.round(((hi - x.estimate.total) / (hi - lo)) * 10);
    if (comparison.status === "within") {
      score += 10;
      reasons.push(`Estimated ${formatINR(comparison.total!)} (incl. GST) is within the ${formatINR(wanted)} budget.`);
    } else if (comparison.status === "near") {
      score += 6;
      reasons.push(`Estimated ${formatINR(comparison.total!)} (incl. GST) is close to the ${formatINR(wanted)} budget.`);
    } else if (comparison.status === "over") {
      score -= 10 + Math.min(20, Math.round(((comparison.total! - wanted) / wanted) * 20));
      tradeoffs.push(`Estimated ${formatINR(comparison.total!)} (incl. GST) is ${formatINR(-comparison.difference!)} over the ${formatINR(wanted)} budget. The price is not reduced automatically.`);
    }
    const supportedScale = scaleOf(c.supported);
    const security = [...new Set(c.entries.flatMap((e) => e.security))];
    const option: RecommendedOption = {
      rank: 0,
      source,
      score: clamp(Math.round(score), 0, 100),
      stack: { frontend: describe(c.entries, "frontend"), backend: describe(c.entries, "backend"), database: describe(c.entries, "database"), hosting: describe(c.entries, "hosting") },
      ids: c.entries.map((e) => e.id),
      hostingAlternatives: x.alternatives.map((id) => ({ id, label: byId.get(id)!.label })),
      complexity: c.complexity,
      maintenance: c.maintenance,
      devFactor: c.devFactor,
      scalability: supportedScale,
      security,
      meetsRequirements: c.blocked.length === 0,
      estimate: x.estimate,
      budget: comparison,
      reasons,
      tradeoffs,
    };
    return option;
  });

  scored.sort((a, b) => Number(b.meetsRequirements) - Number(a.meetsRequirements) || b.score - a.score || (a.estimate?.total ?? Infinity) - (b.estimate?.total ?? Infinity) || a.ids.length - b.ids.length || a.ids.join().localeCompare(b.ids.join()));
  const limit = clamp(Math.round(options.maxOptions ?? 3), 1, 10);
  const top = scored[0];
  const kept = scored.filter((o) => o === top || (o.score >= Math.max(30, top.score - 30) && o.meetsRequirements === top.meetsRequirements)).slice(0, limit);
  kept.forEach((o, i) => (o.rank = i + 1));

  if (!top.meetsRequirements) {
    notes.push(
      source === "client"
        ? "The technology the client asked for does not fully meet the project's scale or security needs. Discuss this with the client."
        : "No enabled technology fully meets the project's scale or security needs. These are the closest options; enable more technologies for a better fit.",
    );
  }
  if (source === "client") notes.push(`Using the technology the client asked for: ${preference.stated.join(", ")}.`);
  let budgetPlan: PagePlan | undefined;
  if (wanted > 0 && top.estimate) {
    if (top.budget.status === "over") {
      notes.push(`The budget (${formatINR(wanted)}) is below the estimated development cost (${formatINR(top.estimate.total)}) for the requested scope. Prices are not reduced automatically: reduce the scope (pages or Phase 2 features) or agree a larger budget.`);
      try {
        budgetPlan = pagePlan(requirement, requirement, wanted, client, rates);
      } catch {
        budgetPlan = undefined;
      }
    } else if (top.estimate.total <= wanted * 0.4 && needs.demand !== "heavy") {
      notes.push("The budget is well above the estimated cost. A heavier stack would not make this project better; use the extra budget for scope such as more pages, content or SEO.");
    }
  }
  if (needs.assumptions.length) notes.push(...needs.assumptions);
  return { options: kept, clientPreference: preference, requiresConfirmation: preference.status === "needs-confirmation", needs, notes, rejected, rejectedCount, budgetPlan, catalogProblems: problems, separateCosts: SEPARATE_COSTS_NOTICE };
}
