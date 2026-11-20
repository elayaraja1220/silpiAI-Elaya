import { PROJECT_TYPES, type ProjectType } from "./types";

/**
 * Shared technology catalog (step 1: the data and its rules only).
 *
 * One list of technologies that the quotation wizard, the Create-project page,
 * the build brief and the AI agent will all read from. Each entry says whether
 * the team currently delivers it (`enabled`), what it suits, what it works with,
 * how it affects development cost, and its maintenance, security and scale
 * traits. The administrator controls availability through saved overrides; the
 * built-in defaults below are never overwritten.
 *
 * Nothing here changes pricing or the user interface yet. `devFactor` is data
 * for the later recommendation and estimate steps; `buildQuote` does not read it.
 * Pure: no I/O, so the browser, the server and the tests share it.
 */

export const CATALOG_LAYERS = ["frontend", "backend", "database", "hosting"] as const;
export type CatalogLayer = (typeof CATALOG_LAYERS)[number];

export const TECH_KINDS = ["language", "library", "css-framework", "framework", "runtime", "database", "hosting"] as const;
export type TechKind = (typeof TECH_KINDS)[number];

export const LEVELS = ["low", "medium", "high"] as const;
export type Level = (typeof LEVELS)[number];

export const SCALES = ["small", "medium", "large"] as const;
export type Scale = (typeof SCALES)[number];

export type TechEntry = {
  /** Stable id used in saved data (never rename). */
  id: string;
  label: string;
  layer: CatalogLayer;
  kind: TechKind;
  description: string;
  /** Administrator switch: only enabled technologies may be recommended or built. */
  enabled: boolean;
  /** Project types it suits. */
  projectTypes: ProjectType[];
  /** Traffic / data sizes it is suited for. */
  scalability: Scale[];
  /** Development cost impact against our standard (1 = same, 1.2 = 20% more hours). */
  devFactor: number;
  /** Effort to keep it updated and running after launch. */
  maintenance: Level;
  /** Security points to remember when building and running it. */
  security: string[];
  /** Ids that must also be in the stack (all of them). */
  requires: string[];
  /** Ids that cannot be combined with it. Symmetric: either side listing the other is enough. */
  incompatibleWith: string[];
};

/** Fields the administrator may change; everything else is fixed by the product. */
export type TechOverride = Partial<Pick<TechEntry, "enabled" | "projectTypes" | "scalability" | "devFactor" | "maintenance" | "security">>;
export type TechOverrides = Record<string, TechOverride>;

const ALL: ProjectType[] = [...PROJECT_TYPES];
const SITES: ProjectType[] = ["landing-page", "business-website", "cms-website"];
const SHOPS_APPS: ProjectType[] = ["ecommerce", "web-app"];
const SERVER_APPS: ProjectType[] = ["cms-website", "ecommerce", "web-app"];

/**
 * Built-in defaults. Enabled = what the current quotation flow already uses
 * (Next.js, Node.js, PostgreSQL, the three hosting types, plain HTML/CSS/JS);
 * everything else starts disabled until the administrator confirms delivery.
 */
export const DEFAULT_TECH_CATALOG: readonly TechEntry[] = [
  // ---- Frontend ------------------------------------------------------------
  { id: "html", label: "HTML", layer: "frontend", kind: "language", description: "Page structure for static and simple sites.", enabled: true, projectTypes: SITES, scalability: ["small"], devFactor: 0.85, maintenance: "low", security: ["Escape any user-supplied text before showing it."], requires: [], incompatibleWith: [] },
  { id: "css", label: "CSS", layer: "frontend", kind: "language", description: "Styling and responsive layout.", enabled: true, projectTypes: SITES, scalability: ["small"], devFactor: 0.85, maintenance: "low", security: [], requires: ["html"], incompatibleWith: [] },
  { id: "javascript", label: "JavaScript", layer: "frontend", kind: "language", description: "Browser behaviour; the base of every modern frontend.", enabled: true, projectTypes: ALL, scalability: ["small", "medium"], devFactor: 1, maintenance: "low", security: ["Never trust data in the browser; validate again on the server."], requires: [], incompatibleWith: [] },
  { id: "jquery", label: "jQuery", layer: "frontend", kind: "library", description: "Older DOM helper for small interactive sites.", enabled: false, projectTypes: SITES, scalability: ["small"], devFactor: 0.95, maintenance: "medium", security: ["Keep jQuery and its plugins updated; old versions have known script-injection issues."], requires: ["html", "javascript"], incompatibleWith: [] },
  { id: "bootstrap", label: "Bootstrap", layer: "frontend", kind: "css-framework", description: "Ready-made responsive components.", enabled: false, projectTypes: ["landing-page", "business-website", "cms-website", "ecommerce"], scalability: ["small", "medium"], devFactor: 0.9, maintenance: "low", security: ["Load it from our own build, not an unpinned CDN."], requires: ["html", "css"], incompatibleWith: [] },
  { id: "react", label: "React", layer: "frontend", kind: "framework", description: "Component UI library (client-side apps).", enabled: false, projectTypes: ALL, scalability: ["medium", "large"], devFactor: 1, maintenance: "medium", security: ["Avoid dangerouslySetInnerHTML with untrusted text."], requires: ["javascript"], incompatibleWith: [] },
  { id: "nextjs", label: "Next.js", layer: "frontend", kind: "framework", description: "React framework: fast, search-friendly sites and apps. Our standard.", enabled: true, projectTypes: ALL, scalability: ["medium", "large"], devFactor: 1, maintenance: "medium", security: ["Keep Next.js updated; validate every API route input.", "Needs a Node.js host unless exported as a static site."], requires: ["javascript"], incompatibleWith: ["shared-hosting"] },
  { id: "angular", label: "Angular", layer: "frontend", kind: "framework", description: "Structured framework for large business apps.", enabled: false, projectTypes: ["cms-website", "ecommerce", "web-app"], scalability: ["medium", "large"], devFactor: 1.2, maintenance: "high", security: ["Use Angular's built-in sanitising; keep major versions current."], requires: ["javascript"], incompatibleWith: [] },
  // ---- Backend -------------------------------------------------------------
  { id: "php", label: "PHP", layer: "backend", kind: "language", description: "Common server language that runs on almost any host.", enabled: false, projectTypes: ["business-website", "cms-website", "ecommerce"], scalability: ["small", "medium"], devFactor: 0.95, maintenance: "medium", security: ["Use prepared statements; keep the PHP version supported."], requires: [], incompatibleWith: [] },
  { id: "laravel", label: "Laravel", layer: "backend", kind: "framework", description: "PHP framework with login, queues and an admin-friendly structure.", enabled: false, projectTypes: SERVER_APPS, scalability: ["medium", "large"], devFactor: 1.1, maintenance: "medium", security: ["Keep APP_KEY and .env private; run composer audit before release."], requires: ["php"], incompatibleWith: [] },
  { id: "nodejs", label: "Node.js", layer: "backend", kind: "runtime", description: "JavaScript on the server (Express or similar). Our standard.", enabled: true, projectTypes: ALL, scalability: ["medium", "large"], devFactor: 1, maintenance: "medium", security: ["Validate all input; keep dependencies audited (npm audit)."], requires: [], incompatibleWith: ["shared-hosting"] },
  { id: "nestjs", label: "NestJS", layer: "backend", kind: "framework", description: "Structured Node.js framework for larger back ends.", enabled: false, projectTypes: SERVER_APPS, scalability: ["medium", "large"], devFactor: 1.15, maintenance: "high", security: ["Use guards and validation pipes on every route."], requires: ["nodejs"], incompatibleWith: ["shared-hosting"] },
  // ---- Database ------------------------------------------------------------
  { id: "mysql", label: "MySQL", layer: "database", kind: "database", description: "Widely supported relational database.", enabled: false, projectTypes: ["business-website", "cms-website", "ecommerce", "web-app"], scalability: ["small", "medium", "large"], devFactor: 1, maintenance: "low", security: ["Least-privilege database user; automatic backups."], requires: [], incompatibleWith: [] },
  { id: "postgresql", label: "PostgreSQL", layer: "database", kind: "database", description: "Reliable relational database for apps and stores. Our standard.", enabled: true, projectTypes: SERVER_APPS, scalability: ["medium", "large"], devFactor: 1, maintenance: "medium", security: ["Least-privilege database user; encrypted connections; automatic backups."], requires: [], incompatibleWith: ["shared-hosting"] },
  { id: "sqlite", label: "SQLite", layer: "database", kind: "database", description: "File database for small sites and prototypes.", enabled: false, projectTypes: SITES, scalability: ["small"], devFactor: 0.9, maintenance: "low", security: ["Keep the database file outside the public folder; back it up."], requires: [], incompatibleWith: [] },
  { id: "mongodb", label: "MongoDB", layer: "database", kind: "database", description: "Document database for flexible data.", enabled: false, projectTypes: SHOPS_APPS, scalability: ["medium", "large"], devFactor: 1.05, maintenance: "medium", security: ["Never expose the database port; require authentication."], requires: [], incompatibleWith: ["shared-hosting"] },
  // ---- Hosting (guidance only; always billed to the client separately) -------
  { id: "shared-hosting", label: "Shared Hosting", layer: "hosting", kind: "hosting", description: "Cheapest plan; PHP and static sites. No Node.js servers.", enabled: true, projectTypes: SITES, scalability: ["small"], devFactor: 1, maintenance: "low", security: ["Shared server: keep software updated and use strong passwords."], requires: [], incompatibleWith: [] },
  { id: "vps", label: "VPS Hosting", layer: "hosting", kind: "hosting", description: "Own virtual server; runs Node.js, PHP and databases.", enabled: true, projectTypes: ALL, scalability: ["small", "medium", "large"], devFactor: 1, maintenance: "high", security: ["Firewall, SSH keys only, regular OS updates and backups are our job to set up."], requires: [], incompatibleWith: [] },
  { id: "cloud-hosting", label: "Cloud Hosting", layer: "hosting", kind: "hosting", description: "Managed cloud with backups and easy scaling.", enabled: true, projectTypes: ALL, scalability: ["medium", "large"], devFactor: 1, maintenance: "medium", security: ["Least-privilege access keys; enable automatic backups and alerts."], requires: [], incompatibleWith: [] },
];

// ---- Reading the catalog --------------------------------------------------

const clone = (e: TechEntry): TechEntry => ({ ...e, projectTypes: [...e.projectTypes], scalability: [...e.scalability], security: [...e.security], requires: [...e.requires], incompatibleWith: [...e.incompatibleWith] });

/** Defaults plus the administrator's saved overrides. Unknown ids in the overrides are ignored. */
export function buildCatalog(overrides: TechOverrides = {}): TechEntry[] {
  return DEFAULT_TECH_CATALOG.map((base) => ({ ...clone(base), ...cleanOverride(overrides[base.id]) }));
}

export const findTech = (catalog: readonly TechEntry[], id: string) => catalog.find((t) => t.id === id);

/** Technologies the team currently delivers. */
export const enabledTech = (catalog: readonly TechEntry[], layer?: CatalogLayer) => catalog.filter((t) => t.enabled && (!layer || t.layer === layer));

/** Enabled technologies that suit a project type. */
export const techForProject = (catalog: readonly TechEntry[], type: ProjectType, layer?: CatalogLayer) => enabledTech(catalog, layer).filter((t) => t.projectTypes.includes(type));

// ---- Compatibility ----------------------------------------------------------

export type StackIssue = { id: string; kind: "unknown" | "disabled" | "missing-requirement" | "incompatible"; message: string; with?: string };

/** True when either entry lists the other as incompatible. */
export function conflicts(catalog: readonly TechEntry[], a: string, b: string): boolean {
  const x = findTech(catalog, a);
  const y = findTech(catalog, b);
  return !!(x?.incompatibleWith.includes(b) || y?.incompatibleWith.includes(a));
}

/**
 * Checks a chosen set of technology ids: all known and enabled, every
 * requirement present, and no incompatible pair. Returns the problems found.
 */
export function checkStack(catalog: readonly TechEntry[], ids: readonly string[]): { ok: boolean; issues: StackIssue[] } {
  const issues: StackIssue[] = [];
  const unique = [...new Set(ids)];
  for (const id of unique) {
    const tech = findTech(catalog, id);
    if (!tech) {
      issues.push({ id, kind: "unknown", message: `"${id}" is not in the technology catalog.` });
      continue;
    }
    if (!tech.enabled) issues.push({ id, kind: "disabled", message: `${tech.label} is not currently offered.` });
    for (const need of tech.requires) {
      if (!unique.includes(need)) issues.push({ id, kind: "missing-requirement", with: need, message: `${tech.label} needs ${findTech(catalog, need)?.label ?? need}.` });
    }
  }
  for (let i = 0; i < unique.length; i++) {
    for (let j = i + 1; j < unique.length; j++) {
      if (conflicts(catalog, unique[i], unique[j])) {
        issues.push({ id: unique[i], kind: "incompatible", with: unique[j], message: `${findTech(catalog, unique[i])?.label ?? unique[i]} cannot be combined with ${findTech(catalog, unique[j])?.label ?? unique[j]}.` });
      }
    }
  }
  return { ok: issues.length === 0, issues };
}

// ---- Administrator overrides (validated) ------------------------------------

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const listOf = <T extends string>(v: unknown, allowed: readonly T[]): T[] | undefined =>
  Array.isArray(v) ? [...new Set(v.filter((x): x is T => typeof x === "string" && (allowed as readonly string[]).includes(x)))] : undefined;

/** Keeps only editable fields with valid values; anything else is dropped. */
function cleanOverride(input: unknown): TechOverride {
  if (!isObj(input)) return {};
  const out: TechOverride = {};
  if (typeof input.enabled === "boolean") out.enabled = input.enabled;
  const types = listOf(input.projectTypes, PROJECT_TYPES);
  if (types) out.projectTypes = types;
  const scales = listOf(input.scalability, SCALES);
  if (scales) out.scalability = scales;
  if (typeof input.devFactor === "number" && Number.isFinite(input.devFactor) && input.devFactor >= 0.1 && input.devFactor <= 5) out.devFactor = Math.round(input.devFactor * 100) / 100;
  if (typeof input.maintenance === "string" && (LEVELS as readonly string[]).includes(input.maintenance)) out.maintenance = input.maintenance as Level;
  if (Array.isArray(input.security)) out.security = input.security.filter((s): s is string => typeof s === "string").map((s) => s.trim().slice(0, 200)).filter(Boolean).slice(0, 10);
  return out;
}

/** Validates saved or submitted overrides: unknown ids and fields are dropped, values are range-checked. */
export function parseTechOverrides(input: unknown): TechOverrides {
  if (!isObj(input)) return {};
  const known = new Set(DEFAULT_TECH_CATALOG.map((t) => t.id));
  const out: TechOverrides = {};
  for (const [id, value] of Object.entries(input)) {
    if (!known.has(id)) continue;
    const clean = cleanOverride(value);
    if (Object.keys(clean).length) out[id] = clean;
  }
  return out;
}

/** Applies a change on top of existing overrides without losing the other saved entries. */
export function mergeTechOverrides(current: TechOverrides, patch: TechOverrides): TechOverrides {
  const out: TechOverrides = { ...current };
  for (const [id, value] of Object.entries(patch)) out[id] = { ...(out[id] ?? {}), ...value };
  return out;
}
