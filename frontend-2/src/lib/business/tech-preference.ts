import { DEFAULT_TECH_CATALOG, findTech, type CatalogLayer, type TechEntry } from "./tech-catalog";
import type { ClientTech, Requirement } from "./types";

/**
 * Technology the client asked for (pure helpers).
 *
 * What the client states is kept separately from what we recommend: `ClientTech`
 * holds their words and the matching catalog ids. These helpers match names to
 * the catalog, add the technologies they depend on, and describe the result.
 * Nothing here decides whether a request can be delivered; the recommendation
 * engine does that and asks for confirmation when it cannot.
 */

/** Spelling variants, after lower-casing and dropping spaces and punctuation. */
const ALIASES: Record<string, string> = {
  html: "html", html5: "html",
  css: "css", css3: "css",
  javascript: "javascript", js: "javascript", ecmascript: "javascript", es6: "javascript",
  jquery: "jquery",
  bootstrap: "bootstrap", bootstrap5: "bootstrap",
  react: "react", reactjs: "react",
  next: "nextjs", nextjs: "nextjs",
  angular: "angular",
  php: "php",
  laravel: "laravel",
  node: "nodejs", nodejs: "nodejs", express: "nodejs", expressjs: "nodejs",
  nest: "nestjs", nestjs: "nestjs",
  mysql: "mysql",
  postgres: "postgresql", postgresql: "postgresql",
  sqlite: "sqlite", sqlite3: "sqlite",
  mongo: "mongodb", mongodb: "mongodb",
  sharedhosting: "shared-hosting", shared: "shared-hosting",
  vps: "vps", vpshosting: "vps",
  cloudhosting: "cloud-hosting", cloud: "cloud-hosting",
};

/** Catalog id for a technology name as a client might write it ("Vanilla JS", "Node.js", "Postgres"), or undefined. */
export function matchTechnology(name: string): string | undefined {
  let key = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (key.startsWith("vanilla")) key = key.slice("vanilla".length);
  return ALIASES[key];
}

const cleanName = (s: unknown) => (typeof s === "string" ? s.trim().replace(/\s+/g, " ").slice(0, 60) : "");

/** Builds the stored preference from the names found in a document (or typed by the team). Empty input gives undefined. */
export function parseClientTech(stated: unknown): ClientTech | undefined {
  if (!Array.isArray(stated)) return undefined;
  const seen = new Set<string>();
  const names = stated.map(cleanName).filter((n) => n && !seen.has(n.toLowerCase()) && !!seen.add(n.toLowerCase())).slice(0, 12);
  if (!names.length) return undefined;
  const ids = [...new Set(names.map(matchTechnology).filter((id): id is string => !!id))];
  return { stated: names, ids };
}

/** Names that could not be matched to any catalog technology. */
export const unmatchedNames = (tech: Pick<ClientTech, "stated">) => tech.stated.filter((n) => !matchTechnology(n));

/** The ids that count now: the alternative the client confirmed, otherwise what they asked for. */
export const activeClientIds = (tech: ClientTech | undefined): string[] => (tech?.confirmedIds?.length ? tech.confirmedIds : tech?.ids ?? []);

/** Adds the technologies each one needs (Laravel needs PHP, Bootstrap needs HTML and CSS). */
export function withDependencies(ids: readonly string[], catalog: readonly TechEntry[] = DEFAULT_TECH_CATALOG): string[] {
  const out = new Set<string>();
  const add = (id: string) => {
    if (out.has(id)) return;
    out.add(id);
    for (const need of findTech(catalog, id)?.requires ?? []) add(need);
  };
  ids.forEach(add);
  return [...out];
}

/** The client's active technologies for one layer of this requirement. Module and version work keeps the existing stack. */
export function clientLayerIds(req: Pick<Requirement, "clientTech" | "scope">, layer: CatalogLayer): string[] {
  if (req.scope === "module" || req.scope === "version") return [];
  const order = (id: string) => DEFAULT_TECH_CATALOG.findIndex((t) => t.id === id);
  return activeClientIds(req.clientTech)
    .filter((id) => findTech(DEFAULT_TECH_CATALOG, id)?.layer === layer)
    .sort((a, b) => order(a) - order(b));
}

const labelOf = (id: string) => findTech(DEFAULT_TECH_CATALOG, id)?.label ?? id;
const joinWords = (labels: string[]) => (labels.length > 1 ? `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}` : labels[0] ?? "");

/** Names shown in a quotation for the client's frontend choice, e.g. "HTML, CSS and vanilla JavaScript". */
export function frontendLabel(ids: readonly string[]): string {
  const plainScript = ids.includes("javascript") && !ids.some((id) => ["jquery", "react", "nextjs", "angular"].includes(id));
  return joinWords(ids.map((id) => (id === "javascript" && plainScript ? "vanilla JavaScript" : labelOf(id))));
}

export const listLabels = (ids: readonly string[], separator = " + ") => ids.map(labelOf).join(separator);
export const techLabel = labelOf;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Reads a preference submitted to the server. The catalog ids are always worked
 * out again from the client's own words, never trusted from the request; only a
 * confirmed alternative is accepted as ids, and only known catalog ids.
 */
export function parseClientTechInput(value: unknown): ClientTech | undefined {
  if (!isObj(value)) return undefined;
  const base = parseClientTech(value.stated);
  if (!base) return undefined;
  const known = new Set(DEFAULT_TECH_CATALOG.map((t) => t.id));
  const confirmed = Array.isArray(value.confirmedIds) ? [...new Set(value.confirmedIds.filter((x): x is string => typeof x === "string" && known.has(x)))].slice(0, 12) : [];
  return confirmed.length ? { ...base, confirmedIds: confirmed } : base;
}
