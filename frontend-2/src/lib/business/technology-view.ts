import { formatINR } from "./pricing";
import { checkStack, type TechEntry } from "./tech-catalog";
import { frontendLabel, listLabels, selectedStackIds, stylingFor } from "./tech-preference";
import type { Recommendation, RecommendedOption } from "./tech-recommend";
import type { Requirement } from "./types";

/**
 * What the technology panel shows (pure, so it can be tested).
 * The client's own technology, a client-confirmed alternative and our recommendation are always
 * labelled differently, and an alternative is never presented as the client's choice.
 */

export type StackSource = "client" | "client-confirmed" | "recommended";
export const SOURCE_LABELS: Record<StackSource, string> = {
  client: "Client's choice",
  "client-confirmed": "Client-confirmed alternative",
  recommended: "Our recommendation",
};

export type OptionAction = "use" | "confirm" | "selected";

export type TechOptionView = {
  key: string;
  rank: number;
  source: StackSource;
  sourceLabel: string;
  /** Frontend, backend, database, styling and hosting as text. */
  stack: { label: string; value: string }[];
  hostingAlternatives: string;
  /** Technology ids without hosting (what the client confirms or the team selects). */
  appIds: string[];
  reasons: string[];
  tradeoffs: string[];
  complexity: string;
  maintenance: string;
  scalability: string;
  security: string[];
  meetsRequirements: boolean;
  hours: number | null;
  cost: string | null;
  costNote: string;
  budget: string | null;
  action: OptionAction;
  actionLabel: string;
};

export type TechnologyView = {
  visible: boolean;
  state: "client-honoured" | "client-confirmed" | "needs-confirmation" | "recommendations";
  title: string;
  /** What the client asked for, kept apart from our options. */
  client: { stated: string; status: "none" | "honoured" | "needs-confirmation"; problems: string[]; confirmation?: string } | null;
  /** The stack in use now. */
  inUse: { source: StackSource; text: string } | null;
  /** The selected stack no longer works with the enabled technologies. */
  warning: string | null;
  options: TechOptionView[];
  notes: string[];
  requiresConfirmation: boolean;
};

const cap = (s: string) => `${s.charAt(0).toUpperCase()}${s.slice(1)}`;
const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x));

function optionView(option: RecommendedOption, requirement: Requirement, confirmedAlternative: boolean, requiresConfirmation: boolean, inUseIds: string[]): TechOptionView {
  const hostIds = option.stack.hosting.map((h) => h.id);
  const appIds = option.ids.filter((id) => !hostIds.includes(id));
  const front = option.stack.frontend.map((t) => t.id);
  const source: StackSource = option.source === "client" ? (confirmedAlternative ? "client-confirmed" : "client") : "recommended";
  const selected = sameSet(appIds, inUseIds);
  const action: OptionAction = selected ? "selected" : requiresConfirmation ? "confirm" : "use";
  const budget = option.budget.status === "none" || option.budget.total === undefined ? null
    : option.budget.status === "over" ? `Over the client's budget by ${formatINR(-(option.budget.difference ?? 0))}`
    : `Within the client's budget (${formatINR(option.budget.difference ?? 0)} left)`;
  return {
    key: option.ids.join(","),
    rank: option.rank,
    source,
    sourceLabel: SOURCE_LABELS[source],
    stack: [
      { label: "Frontend", value: front.length ? frontendLabel(front) : "None" },
      { label: "Backend", value: option.stack.backend.length ? listLabels(option.stack.backend.map((t) => t.id)) : "None (no server needed)" },
      { label: "Database", value: option.stack.database.length ? listLabels(option.stack.database.map((t) => t.id)) : "None" },
      { label: "Styling", value: stylingFor(front) },
      { label: "Hosting", value: option.stack.hosting.map((t) => t.label).join(", ") },
    ],
    hostingAlternatives: option.hostingAlternatives.map((h) => h.label).join(", "),
    appIds,
    reasons: option.reasons,
    tradeoffs: option.tradeoffs,
    complexity: cap(option.complexity),
    maintenance: cap(option.maintenance),
    scalability: `Suited up to ${option.scalability} scale`,
    security: option.security,
    meetsRequirements: option.meetsRequirements,
    hours: option.estimate?.hours ?? null,
    cost: option.estimate ? formatINR(option.estimate.total) : null,
    costNote: "Development only, including GST. Domain and hosting are billed separately.",
    budget,
    action,
    actionLabel: action === "selected" ? "In use" : action === "confirm" ? "Client confirmed this" : "Use this stack",
  };
}

export function buildTechnologyView(requirement: Requirement, result: Recommendation, catalog: readonly TechEntry[]): TechnologyView {
  const pref = result.clientPreference;
  const confirmed = pref.confirmedAlternative;
  const inUseIds = selectedStackIds(requirement);
  const options = result.options.map((o) => optionView(o, requirement, confirmed, result.requiresConfirmation, inUseIds));

  const asked = requirement.clientTech?.stated.join(", ") ?? "";
  const client: TechnologyView["client"] = pref.status === "none" ? null : { stated: asked, status: pref.status, problems: pref.problems, ...(pref.confirmation ? { confirmation: pref.confirmation } : {}) };

  let inUse: TechnologyView["inUse"] = null;
  if (requirement.clientTech && pref.status === "honoured") {
    inUse = { source: confirmed ? "client-confirmed" : "client", text: listLabels(inUseIds.length ? inUseIds : pref.requestedIds, ", ") };
  } else if (requirement.selectedStack?.ids.length) {
    inUse = { source: "recommended", text: listLabels(requirement.selectedStack.ids, ", ") };
  } else if (requirement.clientTech) {
    // Not usable yet: the quotation still shows what the client asked for.
    inUse = { source: "client", text: asked };
  }

  const check = requirement.selectedStack?.ids.length ? checkStack(catalog, inUseIds) : null;
  const warning = check && !check.ok ? `The selected stack no longer works: ${check.issues.map((i) => i.message).join(" ")}` : null;

  const state: TechnologyView["state"] = result.requiresConfirmation ? "needs-confirmation" : pref.status === "honoured" ? (confirmed ? "client-confirmed" : "client-honoured") : "recommendations";
  const title =
    state === "needs-confirmation" ? "The client's technology needs confirmation"
    : state === "client-honoured" ? "Technology as requested by the client"
    : state === "client-confirmed" ? "Alternative technology confirmed by the client"
    : "Recommended technology";
  return {
    visible: options.length > 0 || pref.status !== "none",
    state,
    title,
    client,
    inUse,
    warning,
    options,
    notes: result.notes.filter((n) => !n.startsWith("The client asked for")).slice(0, 6),
    requiresConfirmation: result.requiresConfirmation,
  };
}
