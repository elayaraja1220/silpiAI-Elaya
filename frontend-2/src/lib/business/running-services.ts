import { RECURRING_CATEGORIES, type Frequency, type RecurringCost, type RecurringItemResult } from "./cost-types";
import { ValidationError } from "./validate";

/**
 * Running services (domain renewal, hosting, maintenance, other recurring services) for ONE quotation.
 * Pure, shared by the server (storage, serialization) and the admin screen.
 *
 * Two shapes, never mixed:
 *  - RunningService: the full internal record. Admin only (provider cost, suggested price, notes, status).
 *  - PublicRunningService: what the client may see. Built ONLY by publicRunningServices(), an allow-list:
 *    a field that is not copied there cannot reach the client, whatever else is added to RunningService later.
 *
 * These services are never added to the development quotation, the internal delivery cost or the profit.
 */

export const ARRANGEMENTS = ["agency-bills", "client-direct", "included", "optional-not-selected", "not-applicable"] as const;
export type Arrangement = (typeof ARRANGEMENTS)[number];

export const ARRANGEMENT_LABELS: Record<Arrangement, string> = {
  "agency-bills": "SILPI provides and bills the client",
  "client-direct": "Client buys and pays the provider directly",
  included: "Included in the package",
  "optional-not-selected": "Optional, not selected",
  "not-applicable": "Not applicable",
};

export const SERVICE_FREQUENCIES = ["one-time", "monthly", "quarterly", "annual"] as const;
export type ServiceFrequency = (typeof SERVICE_FREQUENCIES)[number];
export const FREQUENCY_TEXT: Record<ServiceFrequency, string> = { "one-time": "One-time", monthly: "Monthly", quarterly: "Quarterly", annual: "Every year" };

export const INTERNAL_STATUSES = ["to-review", "price-pending", "confirmed"] as const;
export type InternalStatus = (typeof INTERNAL_STATUSES)[number];
export const INTERNAL_STATUS_LABELS: Record<InternalStatus, string> = { "to-review": "To review", "price-pending": "Price pending", confirmed: "Confirmed" };

/** Who pays whom, in words. Derived from the arrangement, so the two can never disagree. */
export const RESPONSIBILITY: Record<Arrangement, string> = {
  "agency-bills": "SILPI bills the client",
  "client-direct": "Client pays the provider directly",
  included: "No separate charge",
  "optional-not-selected": "Not selected",
  "not-applicable": "Not applicable",
};

export type RunningService = {
  id: string;
  service: string;
  category: (typeof RECURRING_CATEGORIES)[number];
  /** Internal. */
  provider: string;
  /** Internal: what the provider charges SILPI or the client. Rupees. null = unknown. */
  providerCost: number | null;
  /** Internal: the price SILPI would like to charge. Rupees. */
  suggestedPrice: number | null;
  /** The amount the client is billed. Becomes visible to the client only for "agency-bills" and only when shown. */
  clientAmount: number | null;
  /** Whether clientAmount already includes GST. */
  gstIncluded: boolean;
  frequency: ServiceFrequency | null;
  arrangement: Arrangement;
  /** Internal. */
  internalStatus: InternalStatus;
  /** Admin's approval for this service to appear in the client quotation. */
  showToClient: boolean;
  /** Client-facing text (for example "Renews every year on the anniversary"). */
  renewalTerms: string;
  /** Internal. Never leaves the server except to the signed-in admin. */
  internalNotes: string;
};

export const MAX_SERVICES = 30;
const MAX_AMOUNT = 100_000_000;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const CATEGORIES = new Set<string>(RECURRING_CATEGORIES);

const text = (v: unknown, name: string, max: number, required = false): string => {
  if (v === undefined || v === null) {
    if (required) throw new ValidationError(`${name} is required.`);
    return "";
  }
  if (typeof v !== "string") throw new ValidationError(`${name} must be text.`);
  const t = v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim();
  if (required && !t) throw new ValidationError(`${name} is required.`);
  if (t.length > max) throw new ValidationError(`${name} must be at most ${max} characters.`);
  return t;
};
const amount = (v: unknown, name: string): number | null => {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > MAX_AMOUNT) throw new ValidationError(`${name} must be a number from 0 to ${MAX_AMOUNT.toLocaleString("en-IN")}, or empty.`);
  return Math.round(v * 100) / 100;
};
const oneOf = <T extends string>(v: unknown, list: readonly T[], name: string, fallback?: T): T => {
  if ((v === undefined || v === null) && fallback !== undefined) return fallback;
  if (typeof v !== "string" || !(list as readonly string[]).includes(v)) throw new ValidationError(`${name} must be one of: ${list.join(", ")}.`);
  return v as T;
};
const flag = (v: unknown, name: string, fallback: boolean): boolean => {
  if (v === undefined || v === null) return fallback;
  if (typeof v !== "boolean") throw new ValidationError(`${name} must be true or false.`);
  return v;
};

/** Strict parse of what the admin sends. Unknown fields are rejected; missing optional fields get the safe defaults. */
export function parseRunningServices(input: unknown): RunningService[] {
  if (!Array.isArray(input)) throw new ValidationError("services must be a list.");
  if (input.length > MAX_SERVICES) throw new ValidationError(`At most ${MAX_SERVICES} services.`);
  const known = new Set(["id", "service", "category", "provider", "providerCost", "suggestedPrice", "clientAmount", "gstIncluded", "frequency", "arrangement", "internalStatus", "showToClient", "renewalTerms", "internalNotes", "includedInPackage"]);
  const seen = new Set<string>();
  return input.map((raw, i) => {
    const n = `Service ${i + 1}`;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new ValidationError(`${n} must be an object.`);
    const r = raw as Record<string, unknown>;
    for (const k of Object.keys(r)) if (!known.has(k)) throw new ValidationError(`${n}: unknown field "${k}".`);
    const id = text(r.id, `${n} id`, 40, true).toLowerCase();
    if (!ID_RE.test(id)) throw new ValidationError(`${n}: the id may only use letters, digits and dashes.`);
    if (seen.has(id)) throw new ValidationError(`${n}: duplicate id "${id}".`);
    seen.add(id);
    const frequency = r.frequency === null || r.frequency === undefined || r.frequency === "" ? null : oneOf(r.frequency, SERVICE_FREQUENCIES, `${n} frequency`);
    const arrangement = oneOf(r.arrangement, ARRANGEMENTS, `${n} arrangement`, "client-direct");
    // "included" is both an arrangement and a flag on the admin screen: if the flag is sent it must agree.
    if (r.includedInPackage !== undefined && flag(r.includedInPackage, `${n} includedInPackage`, false) !== (arrangement === "included")) {
      throw new ValidationError(`${n}: includedInPackage must match the arrangement.`);
    }
    return {
      id,
      service: text(r.service, `${n} name`, 120, true),
      category: oneOf(r.category, RECURRING_CATEGORIES, `${n} category`, "other"),
      provider: text(r.provider, `${n} provider`, 120),
      providerCost: amount(r.providerCost, `${n} provider cost`),
      suggestedPrice: amount(r.suggestedPrice, `${n} suggested price`),
      clientAmount: amount(r.clientAmount, `${n} client amount`),
      gstIncluded: flag(r.gstIncluded, `${n} gstIncluded`, false),
      frequency,
      arrangement,
      internalStatus: oneOf(r.internalStatus, INTERNAL_STATUSES, `${n} internal status`, "to-review"),
      showToClient: flag(r.showToClient, `${n} showToClient`, false),
      renewalTerms: text(r.renewalTerms, `${n} renewal terms`, 300),
      internalNotes: text(r.internalNotes, `${n} internal notes`, 500),
    };
  });
}

/** Admin-only helper: the markup over the provider cost, when both are known. */
export function serviceMarkup(s: Pick<RunningService, "providerCost" | "clientAmount" | "arrangement">): { amount: number; percent: number | null } | null {
  if (s.arrangement !== "agency-bills" || s.providerCost === null || s.clientAmount === null) return null;
  const amountInr = Math.round((s.clientAmount - s.providerCost) * 100) / 100;
  return { amount: amountInr, percent: s.providerCost > 0 ? Math.round((amountInr / s.providerCost) * 10000) / 100 : null };
}

/**
 * The starting list for a quotation that has none saved: the running costs the existing engine already suggests,
 * with safe defaults. Nothing is shown to the client until the admin approves it.
 */
export function seedRunningServices(recurring: RecurringCost): RunningService[] {
  return recurring.items.map((item: RecurringItemResult): RunningService => {
    const known = item.amount !== null && Number.isFinite(item.amount) && item.amountType !== "percent-of-transaction";
    const cost = known ? (item.amountInr ?? (item.currency === "INR" ? item.amount : null)) : null;
    const frequency: ServiceFrequency | null = item.kind === "one-time" ? "one-time" : ((item.frequency as Frequency | undefined) ?? null);
    return {
      id: item.id.toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 40) || "service",
      service: item.service,
      category: item.category,
      provider: item.provider ?? "",
      providerCost: cost ?? null,
      suggestedPrice: null,
      clientAmount: null,
      gstIncluded: false,
      frequency,
      // Today the client buys these directly; optional ones start as not selected.
      arrangement: item.payer === "studio" ? "agency-bills" : item.necessity === "optional" ? "optional-not-selected" : "client-direct",
      internalStatus: "to-review",
      showToClient: false,
      renewalTerms: "",
      internalNotes: item.note ?? "",
    };
  });
}

// ---- What the client may see ----------------------------------------------------------

export type PublicStatus = "billed-by-us" | "client-buys-directly" | "included" | "optional";
export type PublicRunningService = {
  service: string;
  status: PublicStatus;
  statusLabel: string;
  responsibility: string;
  /** Rupees. Only for a service SILPI bills, and only once the admin has entered the client amount. */
  amount: number | null;
  /** "+ GST" or "incl. GST" when there is an amount. */
  amountNote: string | null;
  frequency: string | null;
  renewalTerms: string | null;
};
export type PublicRunningServices = { services: PublicRunningService[]; note: string };

export const PUBLIC_RUNNING_NOTE = "These services are billed separately from the development quotation and are not part of its total.";

const PUBLIC_STATUS: Record<Exclude<Arrangement, "not-applicable">, { status: PublicStatus; label: string }> = {
  "agency-bills": { status: "billed-by-us", label: "Billed separately by SILPI" },
  "client-direct": { status: "client-buys-directly", label: "To be purchased separately by you from the provider" },
  included: { status: "included", label: "Included in your package" },
  "optional-not-selected": { status: "optional", label: "Optional, not selected" },
};

/**
 * THE ONLY place a RunningService becomes client-visible. It builds a new object from named fields
 * (provider cost, suggested price, markup, internal status and notes are simply never copied).
 * Returns null when nothing is approved for the client, so a quotation without arrangements is unchanged.
 */
export function publicRunningServices(items: readonly RunningService[] | null | undefined): PublicRunningServices | null {
  const visible = (items ?? []).filter((s) => s.showToClient && s.arrangement !== "not-applicable");
  if (visible.length === 0) return null;
  const services = visible.map((s): PublicRunningService => {
    const def = PUBLIC_STATUS[s.arrangement as Exclude<Arrangement, "not-applicable">];
    const billed = s.arrangement === "agency-bills";
    const showAmount = billed && s.clientAmount !== null;
    const showFrequency = (billed || s.arrangement === "client-direct") && s.frequency !== null;
    return {
      service: s.service,
      status: def.status,
      statusLabel: def.label,
      responsibility: RESPONSIBILITY[s.arrangement],
      amount: showAmount ? s.clientAmount : null,
      amountNote: showAmount ? (s.gstIncluded ? "incl. GST" : "+ GST") : null,
      frequency: showFrequency ? FREQUENCY_TEXT[s.frequency!] : null,
      renewalTerms: s.renewalTerms && s.arrangement !== "optional-not-selected" ? s.renewalTerms : null,
    };
  });
  return { services, note: PUBLIC_RUNNING_NOTE };
}

export type RunningTotal = { label: string; amount: number; amountNote: string };

const TOTAL_ORDER = ["Monthly", "Quarterly", "Every year", "One-time"];

/**
 * What SILPI will bill the client on a repeating basis, added up per billing period (monthly, yearly...).
 * Built from the client-safe object only, so it can never expose more than the client already sees.
 * Only services SILPI bills with a known amount are counted. Amounts with and without GST are kept apart,
 * never mixed. It is shown beside, never added to, the development total.
 */
export function runningTotals(running: PublicRunningServices): { totals: RunningTotal[]; unpriced: number } {
  const sums = new Map<string, RunningTotal>();
  let unpriced = 0;
  for (const s of running.services) {
    if (s.status !== "billed-by-us") continue;
    if (s.amount === null) { unpriced += 1; continue; }
    const label = s.frequency ?? "Other";
    const amountNote = s.amountNote ?? "";
    const key = `${label}|${amountNote}`;
    const prev = sums.get(key);
    sums.set(key, { label, amountNote, amount: Math.round(((prev?.amount ?? 0) + s.amount) * 100) / 100 });
  }
  const rank = (l: string) => { const i = TOTAL_ORDER.indexOf(l); return i === -1 ? TOTAL_ORDER.length : i; };
  return { totals: [...sums.values()].sort((a, b) => rank(a.label) - rank(b.label)), unpriced };
}

// ---- Recurring income across all clients (ADMIN ONLY: uses provider cost) -----------------

const MONTHS_PER_PERIOD = { monthly: 1, quarterly: 3, annual: 12 } as const;
const round2 = (n: number) => Math.round(n * 100) / 100;

export type RecurringIncomeRow = { leadId: string; service: string; frequency: string; monthlyRevenue: number; monthlyCost: number | null; monthlyMarkup: number | null };
export type RecurringIncome = {
  /** Every figure is a monthly equivalent, before GST. */
  monthlyRevenue: number;
  /** Provider cost of the rows where it is known. */
  monthlyCost: number;
  /** Revenue minus cost, over only the rows where both are known. */
  monthlyMarkup: number;
  yearlyRevenue: number;
  clients: number;
  rows: RecurringIncomeRow[];
  /** Billed repeating services with no client amount yet: not counted. */
  unpriced: number;
  /** Counted rows with no provider cost entered, so their markup is unknown. */
  costUnknown: number;
};

/**
 * What SILPI earns each month from repeating services (hosting, maintenance...) it bills, across the given leads.
 * The caller passes only projects that are approved and not lost. Counted: arrangement "agency-bills", approved for
 * the client, with a client amount and a monthly / quarterly / yearly period. One-time charges are not recurring.
 * GST is taken out of amounts that include it, so every figure is before GST. Never mixed into any quotation total.
 */
export function recurringIncome(entries: readonly { leadId: string; services: readonly RunningService[] }[], gstRate: number): RecurringIncome {
  const out: RecurringIncome = { monthlyRevenue: 0, monthlyCost: 0, monthlyMarkup: 0, yearlyRevenue: 0, clients: 0, rows: [], unpriced: 0, costUnknown: 0 };
  const clients = new Set<string>();
  const divisor = 1 + Math.max(0, gstRate) / 100;
  for (const { leadId, services } of entries) {
    for (const s of services) {
      if (s.arrangement !== "agency-bills" || !s.showToClient) continue;
      if (s.frequency === null || s.frequency === "one-time") continue;
      if (s.clientAmount === null) { out.unpriced += 1; continue; }
      const months = MONTHS_PER_PERIOD[s.frequency];
      const revenue = round2((s.gstIncluded ? s.clientAmount / divisor : s.clientAmount) / months);
      const cost = s.providerCost === null ? null : round2(s.providerCost / months);
      out.monthlyRevenue = round2(out.monthlyRevenue + revenue);
      if (cost === null) out.costUnknown += 1;
      else { out.monthlyCost = round2(out.monthlyCost + cost); out.monthlyMarkup = round2(out.monthlyMarkup + revenue - cost); }
      clients.add(leadId);
      out.rows.push({ leadId, service: s.service, frequency: FREQUENCY_TEXT[s.frequency], monthlyRevenue: revenue, monthlyCost: cost, monthlyMarkup: cost === null ? null : round2(revenue - cost) });
    }
  }
  out.yearlyRevenue = round2(out.monthlyRevenue * 12);
  out.clients = clients.size;
  return out;
}

/** One line of text for a document: the same wording as the screen. */
export function publicServiceLine(s: PublicRunningService, money: (n: number) => string): string {
  const parts = [s.statusLabel];
  if (s.amount !== null) parts.push(`${money(s.amount)} ${s.amountNote ?? ""}`.trim());
  if (s.frequency) parts.push(s.frequency);
  if (s.renewalTerms) parts.push(s.renewalTerms);
  return `${s.service}: ${parts.join(" · ")}`;
}

/** Admin screen: how the services stand at a glance. */
export function adminRunningSummary(items: readonly RunningService[]): { total: number; visibleToClient: number; priceMissing: number; byArrangement: Record<Arrangement, number> } {
  const byArrangement = Object.fromEntries(ARRANGEMENTS.map((a) => [a, 0])) as Record<Arrangement, number>;
  for (const s of items) byArrangement[s.arrangement] += 1;
  return {
    total: items.length,
    visibleToClient: items.filter((s) => s.showToClient && s.arrangement !== "not-applicable").length,
    priceMissing: items.filter((s) => s.arrangement === "agency-bills" && s.clientAmount === null).length,
    byArrangement,
  };
}
