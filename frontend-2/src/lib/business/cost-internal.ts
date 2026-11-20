import {
  LINE_KIND_LABELS,
  ROLES,
  ROLE_LABELS,
  type AiCost,
  type AiCostRecord,
  type AiUsageRecord,
  type CostConfig,
  type HumanCost,
  type InfraCost,
  type InfraCostItem,
  type InternalCost,
  type LineKind,
  type Role,
  type RoleCost,
  type SecurityLevel,
} from "./cost-types";
import { DEFAULT_TECH_CATALOG, findTech, type Scale } from "./tech-catalog";
import type { LineItem, Quote, RateCard } from "./types";

/**
 * Internal delivery cost: what it costs the studio to deliver the project.
 * Pure. Separate from the client price and from the client's running costs.
 *
 * - People: the quoted hours are shared between roles by the configured allocation,
 *   multiplied by the configured technology effort factors, then priced at the
 *   configured internal hourly rates (not the client billing rate).
 *   Complexity and the technology effort already in the quoted hours are not applied again.
 * - AI/API: provider-reported cost when available, otherwise tokens at the configured prices.
 * - Infrastructure: the configured studio-side resources.
 * Anything that is not configured is listed as missing; no value is invented.
 */

const round2 = (n: number) => Math.round(n * 100) / 100;

/** What a quotation line is, from the line itself, so quotations saved earlier work too. */
export function classifyLine(item: Pick<LineItem, "category" | "description">, rates: RateCard): LineKind | null {
  if (item.category === "design") return "design";
  if (item.category !== "development") return null;
  const text = item.description;
  if (text.startsWith("Page: ")) return "page";
  if (text === "Premium care") return "premium-care";
  if (text.includes(": set-up, testing & deployment") || text.startsWith("Existing codebase review")) return "setup";
  const mod = Object.values(rates.modules ?? {}).find((m) => m.label === text);
  if (mod) return mod.backend ? "feature-backend" : "feature-frontend";
  return "other";
}

// ---- People --------------------------------------------------------------------------

type Layers = { frontend: string[]; backend: string[]; hosting: string[] };

function stackLayers(stackIds: string[]): Layers {
  const layer = (id: string) => findTech(DEFAULT_TECH_CATALOG, id)?.layer;
  return {
    frontend: stackIds.filter((id) => layer(id) === "frontend"),
    backend: stackIds.filter((id) => layer(id) === "backend" || layer(id) === "database"),
    hosting: stackIds.filter((id) => layer(id) === "hosting"),
  };
}

export function calcHumanCost(
  quote: Pick<Quote, "items">,
  rates: RateCard,
  config: CostConfig,
  stackIds: string[],
  scale: Scale,
  security: SecurityLevel,
  actualHours?: number,
): { human: HumanCost; missing: string[]; assumptions: string[] } {
  const missing: string[] = [];
  const assumptions = ["Internal hours come from the quoted hours; complexity and the technology effort already in them are not applied again."];

  const byKind = new Map<LineKind, number>();
  for (const item of quote.items) {
    if (item.unit !== "hour" || !(item.qty > 0)) continue;
    const kind = classifyLine(item, rates);
    if (kind) byKind.set(kind, (byKind.get(kind) ?? 0) + item.qty);
  }
  const quotedHours = round2([...byKind.values()].reduce((a, b) => a + b, 0));

  // Share the hours of each kind of line between the roles.
  const base: Record<Role, number> = { frontend: 0, backend: 0, uiux: 0, qa: 0, pm: 0, deployment: 0 };
  let unallocatedHours = 0;
  for (const [kind, hours] of byKind) {
    const allocation = config.allocation[kind];
    if (!allocation) {
      unallocatedHours += hours;
      missing.push(`No role allocation is configured for ${LINE_KIND_LABELS[kind].toLowerCase()} (${round2(hours)} h).`);
      continue;
    }
    for (const [role, percent] of Object.entries(allocation)) base[role as Role] += (hours * (percent ?? 0)) / 100;
  }

  // Technology effort factors apply to the roles that work on that layer.
  const layers = stackLayers(stackIds);
  const forRole: Partial<Record<Role, string[]>> = { frontend: layers.frontend, backend: layers.backend, deployment: layers.hosting };
  const factorOf = (role: Role): number => {
    const ids = forRole[role] ?? [];
    if (!ids.length || base[role] <= 0) return 1;
    const set = ids.filter((id) => config.techFactors[id] !== undefined);
    for (const id of ids.filter((x) => config.techFactors[x] === undefined)) {
      missing.push(`No internal effort factor is configured for ${findTech(DEFAULT_TECH_CATALOG, id)?.label ?? id}; no adjustment was applied.`);
    }
    return set.length ? round2(set.reduce((s, id) => s + config.techFactors[id]!, 0) / set.length) : 1;
  };

  const roles: RoleCost[] = ROLES.map((role) => {
    const factor = factorOf(role);
    const hours = round2(base[role] * factor);
    const rate = config.roleRates[role];
    if (hours > 0 && rate === null) missing.push(`No internal hourly cost is configured for ${ROLE_LABELS[role].toLowerCase()}.`);
    return { role, baseHours: round2(base[role]), factor, hours, rate, cost: hours > 0 && rate !== null ? round2(hours * rate) : hours > 0 ? null : 0 };
  });

  // Larger scale and higher security can add effort; small and standard need no uplift.
  const percentFor = (kind: "scale" | "security", level: string, baseline: string): number => {
    const configured = (config.uplifts[kind] as Record<string, number | undefined>)[level];
    if (configured === undefined && level !== baseline) missing.push(`No internal uplift is configured for ${kind === "scale" ? `${level} scale` : `${level} security`}.`);
    return configured ?? 0;
  };
  const scalePercent = percentFor("scale", scale, "small");
  const securityPercent = percentFor("security", security, "standard");

  const knownRoleCost = round2(roles.reduce((s, r) => s + (r.cost ?? 0), 0));
  const upliftAmount = round2((knownRoleCost * (scalePercent + securityPercent)) / 100);
  const knownCost = round2(knownRoleCost + upliftAmount);
  const humanMissing = missing.length > 0;

  let cost: number | null = humanMissing ? null : knownCost;
  let basis: HumanCost["basis"] = "estimate";
  const roleHours = roles.reduce((s, r) => s + r.hours, 0);
  if (actualHours !== undefined && actualHours > 0) {
    if (cost !== null && roleHours > 0) {
      cost = round2((cost * actualHours) / roleHours);
      basis = "actual-hours";
      assumptions.push("The hours worked are priced at the estimated mix of roles, because the work log does not record roles.");
    } else {
      assumptions.push("Hours worked were not applied because the people cost is incomplete.");
    }
  }
  return {
    human: {
      quotedHours,
      roles,
      unallocatedHours: round2(unallocatedHours),
      uplift: { scalePercent, securityPercent, amount: upliftAmount },
      basis,
      ...(actualHours !== undefined && actualHours > 0 ? { actualHours } : {}),
      cost,
      knownCost: basis === "actual-hours" && cost !== null ? cost : knownCost,
    },
    missing: [...new Set(missing)],
    assumptions,
  };
}

// ---- AI and API ----------------------------------------------------------------------

export function calcAiCost(records: AiUsageRecord[] | undefined, config: CostConfig): { ai: AiCost; missing: string[] } {
  const missing: string[] = [];
  if (records === undefined) {
    return { ai: { provided: false, records: [], totalUsd: 0, totalInr: 0, actualUsd: 0, estimatedUsd: 0 }, missing: ["AI and API usage was not provided."] };
  }
  const seen = new Set<string>();
  const out: AiCostRecord[] = [];
  for (const r of records) {
    // A record is counted once, even if it is passed twice.
    if (r.id) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
    }
    const base = { id: r.id, provider: r.provider, model: r.model, purpose: r.purpose };
    if (typeof r.actualCostUsd === "number" && Number.isFinite(r.actualCostUsd) && r.actualCostUsd >= 0) {
      out.push({ ...base, status: "actual", costUsd: round2(r.actualCostUsd), note: "Reported by the provider." });
      continue;
    }
    const price = config.aiPricing[r.model];
    const tokens = (r.inputTokens ?? 0) + (r.outputTokens ?? 0) + (r.cacheReadTokens ?? 0) + (r.cacheWriteTokens ?? 0);
    if (tokens <= 0) {
      out.push({ ...base, status: "missing", note: "No cost and no token usage were given." });
      missing.push(`${r.model}: no cost and no token usage were given.`);
    } else if (!price) {
      out.push({ ...base, status: "missing", note: "No price is configured for this model." });
      missing.push(`No price is configured for the AI model "${r.model}".`);
    } else if (((r.cacheReadTokens ?? 0) > 0 && price.cacheReadPerMTok === undefined) || ((r.cacheWriteTokens ?? 0) > 0 && price.cacheWritePerMTok === undefined)) {
      out.push({ ...base, status: "missing", note: "Cache token prices are not configured for this model." });
      missing.push(`Cache token prices are not configured for "${r.model}".`);
    } else {
      const usd =
        ((r.inputTokens ?? 0) * price.inputPerMTok +
          (r.outputTokens ?? 0) * price.outputPerMTok +
          (r.cacheReadTokens ?? 0) * (price.cacheReadPerMTok ?? 0) +
          (r.cacheWriteTokens ?? 0) * (price.cacheWritePerMTok ?? 0)) /
        1_000_000;
      out.push({ ...base, status: "estimated", costUsd: round2(usd), note: "Calculated from the token counts at the configured prices." });
    }
  }
  const rate = config.usdToInr;
  const total = (status: "actual" | "estimated") => round2(out.filter((x) => x.status === status).reduce((s, x) => s + (x.costUsd ?? 0), 0));
  const actualUsd = total("actual");
  const estimatedUsd = total("estimated");
  const totalUsd = round2(actualUsd + estimatedUsd);
  if (totalUsd > 0 && rate === null) missing.push("No USD to INR exchange rate is configured, so AI cost cannot be added in rupees.");
  for (const x of out) if (x.costUsd !== undefined && rate !== null) x.costInr = round2(x.costUsd * rate);
  return { ai: { provided: true, records: out, totalUsd, totalInr: totalUsd === 0 ? 0 : rate === null ? null : round2(totalUsd * rate), actualUsd, estimatedUsd }, missing: [...new Set(missing)] };
}

// ---- Infrastructure --------------------------------------------------------------------

export function calcInfraCost(config: CostConfig, internalHours: number, weeks: number): { infra: InfraCost; missing: string[] } {
  if (config.infra === null) {
    return { infra: { configured: false, items: [], total: 0 }, missing: ["Internal infrastructure costs are not configured."] };
  }
  const missing: string[] = [];
  const items: InfraCostItem[] = config.infra.map((rate) => {
    if (rate.amount === null) {
      missing.push(`No amount is configured for the infrastructure item "${rate.name}".`);
      return { key: rate.key, name: rate.name, basis: rate.basis, status: "missing" };
    }
    const quantity = rate.basis === "per-project" ? 1 : rate.basis === "per-dev-hour" ? internalHours : Math.max(1, Math.ceil(weeks));
    return { key: rate.key, name: rate.name, basis: rate.basis, amount: round2(rate.amount * quantity), status: "estimated" };
  });
  return { infra: { configured: true, items, total: round2(items.reduce((s, i) => s + (i.amount ?? 0), 0)) }, missing };
}

// ---- Putting it together ---------------------------------------------------------------

export type InternalCostInput = {
  quote: Pick<Quote, "items" | "estimatedWeeks">;
  rates: RateCard;
  config: CostConfig;
  stackIds: string[];
  scale: Scale;
  security: SecurityLevel;
  aiUsage?: AiUsageRecord[];
  /** Hours actually worked (for example from the work log). */
  actualHours?: number;
  /** Studio-paid one-time costs that belong to delivering this project. */
  studioProjectCosts?: { id: string; service: string; amount: number }[];
};

export function calcInternalCost(input: InternalCostInput): InternalCost {
  const { config } = input;
  const human = calcHumanCost(input.quote, input.rates, config, input.stackIds, input.scale, input.security, input.actualHours);
  const hoursForInfra = human.human.actualHours ?? human.human.roles.reduce((s, r) => s + r.hours, 0);
  const ai = calcAiCost(input.aiUsage, config);
  const infra = calcInfraCost(config, hoursForInfra, input.quote.estimatedWeeks);
  const studioItems = input.studioProjectCosts ?? [];
  const studio = { items: studioItems, total: round2(studioItems.reduce((s, i) => s + i.amount, 0)) };

  const missing = [...human.missing, ...ai.missing, ...infra.missing];
  const peopleCost = human.human.cost ?? human.human.knownCost;
  const aiInr = ai.ai.totalInr ?? 0;
  const actualAi = ai.ai.totalInr === null || config.usdToInr === null ? 0 : round2(ai.ai.actualUsd * config.usdToInr);
  const actual = round2(actualAi + (human.human.basis === "actual-hours" ? peopleCost : 0));
  const total = round2(peopleCost + aiInr + infra.infra.total + studio.total);
  return {
    human: human.human,
    ai: ai.ai,
    infrastructure: infra.infra,
    studioProjectCosts: studio,
    total,
    complete: missing.length === 0,
    byStatus: { actual, estimated: round2(total - actual) },
    missing,
    assumptions: human.assumptions,
  };
}
