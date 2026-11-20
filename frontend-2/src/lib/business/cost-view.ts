import { LINE_KINDS, LINE_KIND_LABELS, ROLES, ROLE_LABELS, type CostConfig, type CostEstimate, type RecurringCost, type RecurringItemResult, type Viability } from "./cost-types";
import { formatINR } from "./pricing";

/**
 * What the cost screens show (pure, so it can be tested without a browser).
 *
 * Three separate sections that are never added together: the client's development cost,
 * the studio's internal cost with the profit, and the client's running costs.
 * A value that cannot be known yet is shown as unknown or incomplete, never as a misleading zero.
 */

export type RowStatus = "actual" | "estimated" | "missing" | "info";
export type CostRow = { label: string; value: string; status?: RowStatus; strong?: boolean; hint?: string };
export type InternalState = "not-configured" | "incomplete" | "complete";
export type Tone = "good" | "warn" | "bad" | "neutral";

export type RunningRowView = {
  id: string;
  service: string;
  provider: string;
  amount: string;
  unknown: boolean;
  frequency: string;
  necessity: "Mandatory" | "Optional";
  payer: "Client pays" | "Studio pays";
  status: "Actual" | "Estimated";
  /** Why the amount is not in the totals, when it is not. */
  note?: string;
};

export type CostView = {
  client: { rows: CostRow[]; note: string };
  internal: { state: InternalState; banner: string | null; groups: { title: string; rows: CostRow[] }[]; total: CostRow; split: CostRow[]; missing: string[]; assumptions: string[] };
  profit: { state: InternalState; rows: CostRow[]; viability: Viability; viabilityLabel: string; tone: Tone; reasons: string[]; warnings: string[]; note: string };
  budgets: { client: CostRow[]; internal: CostRow[] };
  running: { rows: RunningRowView[]; totals: CostRow[]; studioPays: CostRow[]; notes: string[]; note: string };
};

export const VIABILITY_LABELS: Record<Viability, string> = {
  viable: "Viable",
  "at-risk": "At risk",
  "not-viable": "Not viable",
  unknown: "Cannot be confirmed yet",
};
const TONES: Record<Viability, Tone> = { viable: "good", "at-risk": "warn", "not-viable": "bad", unknown: "neutral" };

/** True when the studio has not entered any internal cost setting yet. */
export function isCostConfigEmpty(c: CostConfig): boolean {
  return (
    Object.values(c.roleRates).every((v) => v === null) &&
    Object.values(c.allocation).every((v) => v === null) &&
    Object.keys(c.techFactors).length === 0 &&
    Object.keys(c.aiPricing).length === 0 &&
    Object.keys(c.uplifts.scale).length === 0 &&
    Object.keys(c.uplifts.security).length === 0 &&
    c.usdToInr === null &&
    c.infra === null &&
    c.minMarginPercent === null
  );
}

const money = (n: number) => formatINR(n);
const FREQUENCY_LABELS = { monthly: "Monthly", quarterly: "Quarterly", annual: "Annual" } as const;

function runningRow(item: RecurringItemResult): RunningRowView {
  const unknown = item.amount === null || !Number.isFinite(item.amount);
  const amount = unknown
    ? "Unknown"
    : item.amountType === "percent-of-transaction"
      ? `${item.amount}% of each transaction`
      : item.currency === "INR"
        ? money(item.amount!)
        : `${item.currency} ${item.amount}`;
  return {
    id: item.id,
    service: item.service,
    provider: item.provider || "Not set",
    amount,
    unknown,
    frequency: item.kind === "one-time" ? "One-time" : item.frequency ? FREQUENCY_LABELS[item.frequency] : "Not set",
    necessity: item.necessity === "mandatory" ? "Mandatory" : "Optional",
    payer: item.payer === "client" ? "Client pays" : "Studio pays",
    status: item.status === "actual" ? "Actual" : "Estimated",
    ...(item.counted ? {} : item.reason ? { note: item.reason } : {}),
  };
}

function totalsRows(t: { oneTime: number; monthly: number; quarterly: number; annual: number; yearlyEquivalent: number }): CostRow[] {
  const rows: CostRow[] = [];
  if (t.oneTime) rows.push({ label: "One-time", value: money(t.oneTime) });
  if (t.monthly) rows.push({ label: "Billed monthly", value: money(t.monthly) });
  if (t.quarterly) rows.push({ label: "Billed quarterly", value: money(t.quarterly) });
  if (t.annual) rows.push({ label: "Billed annually", value: money(t.annual) });
  if (t.yearlyEquivalent) rows.push({ label: "Recurring per year", value: money(t.yearlyEquivalent), strong: true });
  return rows;
}

export function buildCostView(estimate: CostEstimate, config: CostConfig, running: RecurringCost): CostView {
  const d = estimate.clientDevelopment;
  const i = estimate.internal;
  const p = estimate.profit;
  const state: InternalState = isCostConfigEmpty(config) ? "not-configured" : i.complete ? "complete" : "incomplete";

  // ---- A. what the client pays for development
  const client: CostView["client"] = {
    rows: [
      { label: "Development hours", value: `${d.hours} h` },
      { label: "Development subtotal", value: money(d.subtotal) },
      { label: "Discount", value: d.discount > 0 ? `- ${money(d.discount)}` : money(0) },
      { label: "Taxable value", value: money(d.taxable) },
      ...(d.gstMode === "intra"
        ? [{ label: `CGST @ ${d.gstRate / 2}%`, value: money(d.cgst) }, { label: `SGST @ ${d.gstRate / 2}%`, value: money(d.sgst) }]
        : d.gstMode === "inter"
          ? [{ label: `IGST @ ${d.gstRate}%`, value: money(d.igst) }]
          : [{ label: "GST", value: "Zero-rated export" }]),
      { label: "Grand total (incl. GST)", value: money(d.total), strong: true },
    ],
    note: d.note,
  };

  // ---- B. what delivery costs the studio
  const known = (n: number) => (state === "complete" ? money(n) : n > 0 ? `At least ${money(n)}` : "Not available yet");
  const people: CostRow[] = [];
  for (const r of i.human.roles) {
    if (r.hours <= 0) continue;
    people.push(
      r.cost !== null && r.rate !== null
        ? { label: ROLE_LABELS[r.role], value: `${r.hours} h × ${money(r.rate)} = ${money(r.cost)}`, status: i.human.basis === "actual-hours" ? "actual" : "estimated" }
        : { label: ROLE_LABELS[r.role], value: `${r.hours} h, no hourly cost configured`, status: "missing" },
    );
  }
  if (i.human.unallocatedHours > 0) people.push({ label: "Hours without a role allocation", value: `${i.human.unallocatedHours} h`, status: "missing" });
  if (i.human.uplift.amount > 0) people.push({ label: "Scale and security uplift", value: money(i.human.uplift.amount), status: "estimated" });
  people.push(
    i.human.cost !== null
      ? { label: "Developer and team cost", value: money(i.human.cost), status: i.human.basis === "actual-hours" ? "actual" : "estimated", strong: true, hint: i.human.basis === "actual-hours" ? `Based on ${i.human.actualHours} h worked, at the estimated mix of roles` : "Estimated from the quoted hours" }
      : { label: "Developer and team cost", value: i.human.knownCost > 0 ? `Incomplete: at least ${money(i.human.knownCost)}` : "Not available yet", status: "missing", strong: true },
  );

  const ai: CostRow[] = [];
  if (!i.ai.provided) ai.push({ label: "AI and API usage", value: "Not provided", status: "missing" });
  else {
    for (const r of i.ai.records) {
      ai.push({
        label: `${r.provider} ${r.model}${r.purpose ? ` · ${r.purpose}` : ""}`,
        value: r.costUsd !== undefined ? `$${r.costUsd.toFixed(2)}${r.costInr !== undefined ? ` (${money(r.costInr)})` : ""}` : "No cost known",
        status: r.status,
        hint: r.note,
      });
    }
    if (!i.ai.records.length) ai.push({ label: "AI and API usage", value: "None used", status: "info" });
    else ai.push(i.ai.totalInr === null ? { label: "AI and API cost", value: `$${i.ai.totalUsd.toFixed(2)}, no USD to INR rate configured`, status: "missing", strong: true } : { label: "AI and API cost", value: money(i.ai.totalInr), strong: true, status: i.ai.estimatedUsd > 0 ? "estimated" : "actual" });
  }

  const infra: CostRow[] = [];
  if (!i.infrastructure.configured) infra.push({ label: "Internal infrastructure", value: "Not configured", status: "missing" });
  else {
    for (const item of i.infrastructure.items) {
      infra.push(item.amount !== undefined ? { label: item.name, value: money(item.amount), status: "estimated" } : { label: item.name, value: "No amount configured", status: "missing" });
    }
    if (!i.infrastructure.items.length) infra.push({ label: "Internal infrastructure", value: "None", status: "info" });
    else infra.push({ label: "Infrastructure cost", value: money(i.infrastructure.total), strong: true });
  }

  const studio: CostRow[] = i.studioProjectCosts.items.length
    ? [...i.studioProjectCosts.items.map((x) => ({ label: x.service, value: money(x.amount), status: "actual" as const })), { label: "Studio-paid project costs", value: money(i.studioProjectCosts.total), strong: true }]
    : [{ label: "Studio-paid project costs", value: "None recorded", status: "info" }];

  const internalState: CostView["internal"] = {
    state,
    banner:
      state === "not-configured"
        ? "Internal costs are not configured yet, so no cost or profit is shown. Enter your internal rates in Business & pricing."
        : state === "incomplete"
          ? `Internal cost is incomplete: ${i.missing.length} setting${i.missing.length === 1 ? " is" : "s are"} missing. The figures below are what could be worked out so far.`
          : null,
    groups: [
      { title: "Developer and team", rows: people },
      { title: "AI and API", rows: ai },
      { title: "Infrastructure", rows: infra },
      { title: "Studio-paid project costs", rows: studio },
    ],
    total: { label: "Internal delivery cost", value: known(i.total), strong: true, status: state === "complete" ? "estimated" : "missing" },
    split: state === "not-configured" ? [] : [
      i.byStatus.actual > 0
        ? { label: i.complete ? "Actual" : "Actual so far", value: money(i.byStatus.actual), status: "actual" as const }
        : { label: i.complete ? "Actual" : "Actual so far", value: "None recorded yet", status: "info" as const },
      { label: i.complete ? "Estimated" : "Estimated so far", value: money(i.byStatus.estimated), status: "estimated" },
    ],
    missing: i.missing,
    assumptions: i.assumptions,
  };

  // ---- C. profitability: revenue excluding GST against the internal cost only
  const provisional = state !== "complete";
  const profitRows: CostRow[] = [
    { label: "Development revenue excluding GST", value: money(p.revenue) },
    { label: "Internal delivery cost", value: known(i.total), status: provisional ? "missing" : "estimated" },
  ];
  if (state === "not-configured") {
    profitRows.push({ label: "Gross profit", value: "Not available yet", status: "missing", strong: true }, { label: "Gross margin", value: "Not available yet", status: "missing", strong: true });
  } else {
    const upTo = (v: string) => (provisional ? `Up to ${v}` : v);
    profitRows.push(
      { label: "Gross profit", value: upTo(money(p.grossProfit)), status: provisional ? "missing" : "estimated", strong: true, hint: provisional ? "Higher than it will be: some costs are missing" : undefined },
      { label: "Gross margin", value: p.grossMarginPercent === null ? "No revenue" : upTo(`${p.grossMarginPercent}%`), status: provisional ? "missing" : "estimated", strong: true, hint: p.minMarginPercent !== null ? `Target ${p.minMarginPercent}%` : "No margin target configured" },
    );
  }
  const viability = state === "not-configured" ? "unknown" : estimate.budget.viability;
  const profit: CostView["profit"] = {
    state,
    rows: profitRows,
    viability,
    viabilityLabel: VIABILITY_LABELS[viability],
    tone: TONES[viability],
    reasons: state === "not-configured" ? ["Configure your internal costs to see whether the project is viable."] : estimate.budget.reasons,
    warnings: state === "not-configured" ? [] : estimate.warnings,
    note: "GST and the client's running costs are not part of revenue, cost or profit.",
  };

  // ---- budgets
  const b = estimate.budget;
  const budgets: CostView["budgets"] = {
    client:
      b.client.status === "none"
        ? [{ label: "Client budget", value: "Not stated" }]
        : [
            { label: "Client budget (incl. GST)", value: money(b.client.budget) },
            { label: "Quotation total (incl. GST)", value: money(b.client.quote) },
            b.client.status === "over" ? { label: "Over the client's budget by", value: money(b.client.shortfall), status: "missing" } : { label: "Remaining budget", value: money(b.client.difference) },
          ],
    internal:
      b.internal.status === "none"
        ? [{ label: "Internal budget", value: "Not set" }]
        : [
            { label: "Internal budget", value: money(b.internal.budget) },
            { label: "Estimated internal cost", value: known(b.internal.estimatedCost) },
            b.internal.status === "over" ? { label: "Over the internal budget by", value: money(b.internal.shortfall), status: "missing" } : { label: "Remaining internal budget", value: money(b.internal.difference) },
          ],
  };

  // ---- D. what the client pays separately
  const studioTotals = totalsRows(running.byPayer.studio.all);
  const runningView: CostView["running"] = {
    rows: running.items.map(runningRow),
    totals: totalsRows(running.byPayer.client.all).length ? totalsRows(running.byPayer.client.all) : [{ label: "Total", value: "No amounts known yet", status: "info" }],
    studioPays: studioTotals,
    notes: running.notes,
    note: "Billed separately by the providers. Never part of the development quotation, the studio's cost or its profit.",
  };
  return { client, internal: internalState, profit, budgets, running: runningView };
}

// ---- Is the configuration ready? ------------------------------------------------------

export type ReadinessItem = { key: string; label: string; state: "done" | "missing" | "optional"; detail: string };

/** A checklist of what is still needed for a meaningful internal cost. Nothing is assumed. */
export function costConfigReadiness(c: CostConfig): ReadinessItem[] {
  const rates = ROLES.filter((r) => c.roleRates[r] !== null);
  const allocated = LINE_KINDS.filter((k) => c.allocation[k] !== null);
  const factors = Object.keys(c.techFactors).length;
  const models = Object.keys(c.aiPricing).length;
  const upliftCount = Object.keys(c.uplifts.scale).length + Object.keys(c.uplifts.security).length;
  return [
    { key: "roleRates", label: "Internal hourly rates", state: rates.length === ROLES.length ? "done" : "missing", detail: `${rates.length} of ${ROLES.length} roles set` },
    { key: "allocation", label: "Role allocation", state: c.allocation.setup && c.allocation.page ? "done" : "missing", detail: `${allocated.length} of ${LINE_KINDS.length} kinds of work set (set-up and pages are always needed)` },
    { key: "techFactors", label: "Technology effort factors", state: factors > 0 ? "done" : "missing", detail: factors ? `${factors} technologies set` : "Needed for each technology used in a stack" },
    { key: "uplifts", label: "Scale and security uplifts", state: upliftCount > 0 ? "done" : "optional", detail: upliftCount ? `${upliftCount} set` : "Only for medium or large scale, elevated or high security" },
    { key: "aiPricing", label: "AI model pricing", state: models > 0 ? "done" : "optional", detail: models ? `${models} model${models === 1 ? "" : "s"} priced` : "Needed to price token usage" },
    { key: "usdToInr", label: "USD to INR rate", state: c.usdToInr !== null ? "done" : "missing", detail: c.usdToInr !== null ? `1 USD = ${c.usdToInr} INR` : "Needed for any AI cost in dollars" },
    { key: "infra", label: "Infrastructure rates", state: c.infra !== null ? "done" : "missing", detail: c.infra === null ? "Not configured" : c.infra.length ? `${c.infra.length} item${c.infra.length === 1 ? "" : "s"}` : "Set to none" },
    { key: "minMargin", label: "Minimum gross margin target", state: c.minMarginPercent !== null ? "done" : "missing", detail: c.minMarginPercent !== null ? `${c.minMarginPercent}%` : "Needed for margin warnings" },
    { key: "runningCosts", label: "Running cost suggestions", state: Object.keys(c.runningCosts).length ? "done" : "optional", detail: Object.keys(c.runningCosts).length ? `${Object.keys(c.runningCosts).length} kinds set` : "Optional: amounts stay unknown without them" },
  ];
}

export { LINE_KIND_LABELS };

// ---- Presentation helpers for the collapsible internal sections -------------------------

export type ConfigStatus = {
  state: InternalState;
  /** Short chip text: "Not configured", "Setup incomplete" or "Ready". */
  label: string;
  /** One line explaining the state. */
  detail: string;
  /** Required settings still to be entered (optional ones are not listed). */
  needed: ReadinessItem[];
  doneCount: number;
  requiredCount: number;
};

/** One clear status instead of many "Missing" rows. Built from the existing readiness checklist. */
export function configStatus(state: InternalState, readiness: ReadinessItem[], projectMissing: number): ConfigStatus {
  const required = readiness.filter((r) => r.state !== "optional");
  const done = required.filter((r) => r.state === "done").length;
  const needed = required.filter((r) => r.state === "missing");
  if (state === "complete") return { state, label: "Ready", detail: "All the internal settings this quotation needs are configured.", needed: [], doneCount: done, requiredCount: required.length };
  if (state === "not-configured") return { state, label: "Not configured", detail: "No internal cost settings have been entered yet, so no cost, profit or margin is shown.", needed, doneCount: done, requiredCount: required.length };
  return {
    state,
    label: "Setup incomplete",
    detail: `${projectMissing} setting${projectMissing === 1 ? " is" : "s are"} still needed for this quotation. Cost, profit and margin appear once they are entered.`,
    needed,
    doneCount: done,
    requiredCount: required.length,
  };
}

export type InternalSummary = { cost: string; grossProfit: string; grossMargin: string; viabilityLabel: string };

/** The headline figures, only when the configuration is complete (never provisional numbers). */
export function internalSummary(view: CostView): InternalSummary | null {
  if (view.internal.state !== "complete") return null;
  const find = (label: string) => view.profit.rows.find((r) => r.label === label)?.value ?? "";
  return { cost: view.internal.total.value, grossProfit: find("Gross profit"), grossMargin: find("Gross margin"), viabilityLabel: view.profit.viabilityLabel };
}
