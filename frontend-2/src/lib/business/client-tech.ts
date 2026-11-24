import { needsBackend } from "./pricing";
import { buildProposals } from "./proposals";
import { TECH_LAYERS, TIERS, type Client, type RateCard, type Requirement, type TechLayer, type Tier } from "./types";
import { ValidationError } from "./validate";

/**
 * The client's own technology choice on their quotation page (frontend, backend, database).
 *
 * Every option shows what it does to the price: more or less than the quotation they are looking at. The prices come from the
 * same engine as the quotation, so the number the client sees is the number they are billed. Pure, so the server, the page
 * and the tests agree. Nothing internal (hour factors, margins) leaves here: only labels, descriptions and totals incl. GST.
 */

export type TechSelection = Partial<Record<TechLayer, string>>;

export type TechChoiceOption = {
  /** "" = "SILPI chooses", our standard for this layer. */
  id: string;
  label: string;
  detail: string;
  /** Quotation total incl. GST if this option is picked and the other layers stay as they are. */
  total: number;
  /** total minus the current total: positive = costs more, negative = costs less. */
  delta: number;
};

export type TechChoiceLayer = {
  layer: TechLayer;
  label: string;
  /** False when this layer does not exist in the project (a static site has no backend or database). */
  applies: boolean;
  current: string;
  options: TechChoiceOption[];
};

export type TechPreview = {
  tier: Tier;
  /** The quotation total incl. GST with the chosen technology, and the total without any change. */
  total: number;
  baseTotal: number;
  delta: number;
  advance: number;
  hours: number;
  weeks: number;
  tiers: Record<Tier, number>;
  stack: { frontend: string; backend: string; database: string; styling: string };
};

const LAYER_LABEL: Record<TechLayer, string> = { frontend: "Frontend", backend: "Backend", database: "Database" };

/** Layers that exist in this project. Module / version work keeps the existing project's stack. */
export function layerApplies(layer: TechLayer, req: Requirement, rates: RateCard): boolean {
  if (req.scope === "module" || req.scope === "version") return false;
  return layer === "frontend" ? true : needsBackend(req, rates);
}

/** The selection with only real, applicable layers (a blank value means "SILPI chooses"). */
const clean = (tech: TechSelection | undefined, req: Requirement, rates: RateCard): TechSelection =>
  Object.fromEntries(TECH_LAYERS.flatMap((l) => (tech?.[l] && layerApplies(l, req, rates) ? [[l, tech[l]]] : [])));

function priced(req: Requirement, client: Pick<Client, "state">, rates: RateCard, tier: Tier) {
  const proposals = buildProposals(req, client, rates);
  const pick = proposals.find((p) => p.tier === tier) ?? proposals.find((p) => p.tier === "standard")!;
  return {
    pick,
    tiers: Object.fromEntries(proposals.map((p) => [p.tier, p.grandTotal])) as Record<Tier, number>,
  };
}

/** What the client can choose for each layer, with the price effect of every option. */
export function techChoices(base: Requirement, client: Pick<Client, "state">, rates: RateCard, tier: Tier): { tier: Tier; total: number; layers: TechChoiceLayer[] } {
  const current = clean(base.tech, base, rates);
  const now = priced({ ...base, tech: current }, client, rates, tier).pick.grandTotal;
  const layers = TECH_LAYERS.map((layer): TechChoiceLayer => {
    const applies = layerApplies(layer, base, rates);
    const entries = Object.entries(rates.technology?.[layer] ?? {}).filter(([id, o]) => o.available || current[layer] === id);
    const total = (id: string) => {
      const next: TechSelection = { ...current };
      if (id) next[layer] = id;
      else delete next[layer];
      return priced({ ...base, tech: next }, client, rates, tier).pick.grandTotal;
    };
    const options: TechChoiceOption[] = applies
      ? [
          { id: "", label: "SILPI chooses (our standard)", detail: "The option we recommend for this project.", total: total(""), delta: total("") - now },
          ...entries.map(([id, o]) => ({ id, label: o.label, detail: o.detail, total: total(id), delta: total(id) - now })),
        ]
      : [];
    return { layer, label: LAYER_LABEL[layer], applies, current: current[layer] ?? "", options };
  });
  return { tier, total: now, layers };
}

/** Reads a selection sent by the client: known, available options only. A blank value means "SILPI chooses". */
export function parseTechSelection(input: unknown, base: Requirement, rates: RateCard): TechSelection {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ValidationError("Choose your technology from the list.");
  const raw = input as Record<string, unknown>;
  const out: TechSelection = {};
  for (const layer of TECH_LAYERS) {
    const v = raw[layer];
    if (v === undefined || v === null || v === "") continue;
    if (typeof v !== "string" || !rates.technology?.[layer]?.[v]?.available) throw new ValidationError(`That ${LAYER_LABEL[layer].toLowerCase()} option is not available.`);
    if (layerApplies(layer, base, rates)) out[layer] = v;
  }
  return out;
}

/** The new total for a selection, against the quotation total without it. */
export function previewTech(base: Requirement, client: Pick<Client, "state">, rates: RateCard, tier: Tier, tech: TechSelection): TechPreview {
  const chosen = clean(tech, base, rates);
  const before = priced({ ...base, tech: clean(base.tech, base, rates) }, client, rates, tier).pick.grandTotal;
  const { pick, tiers } = priced({ ...base, tech: chosen }, client, rates, tier);
  const s = pick.quote.stack;
  return {
    tier: pick.tier,
    total: pick.grandTotal,
    baseTotal: before,
    delta: pick.grandTotal - before,
    advance: Math.round((pick.grandTotal * rates.advancePercent) / 100),
    hours: pick.quote.totalHours,
    weeks: pick.estimatedWeeks,
    tiers,
    stack: { frontend: s.frontend, backend: s.backend, database: s.database, styling: s.styling },
  };
}

/**
 * The requirement with the client's choice applied. The client picked these explicitly, so they replace an earlier stack
 * selection or technology note (the history keeps the record of the change).
 */
export function applyClientTech(req: Requirement, tech: TechSelection, rates: RateCard): Requirement {
  const chosen = clean(tech, req, rates);
  if (Object.keys(chosen).length === 0) return { ...req, tech: {} };
  const { clientTech: _c, selectedStack: _s, ...rest } = req;
  return { ...rest, tech: chosen };
}

/** "Frontend Vue (Nuxt), Backend Supabase..., Database SILPI chooses": for the project history. */
export function describeTech(tech: TechSelection, rates: RateCard): string {
  return TECH_LAYERS.map((l) => `${LAYER_LABEL[l]} ${tech[l] ? rates.technology?.[l]?.[tech[l]!]?.label ?? tech[l] : "SILPI chooses"}`).join(", ");
}

export const isTier = (v: unknown): v is Tier => TIERS.includes(v as Tier);
