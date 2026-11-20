import type { CostConfig, RecurringCost, RecurringCostItem, RecurringItemResult, RecurringTotals } from "./cost-types";
import type { Requirement } from "./types";

/**
 * Client running and third-party costs: domain, hosting, subscriptions, APIs,
 * payment charges, maintenance. Pure.
 *
 * - Never added to the development quotation, internal cost, revenue or profit.
 * - One-time, monthly, quarterly and annual charges are kept apart.
 * - An unknown amount stays unknown. No provider price is built in.
 * - A cost that is already counted elsewhere (`countedIn`) is not counted again.
 */

const round2 = (n: number) => Math.round(n * 100) / 100;
const noTotals = (): RecurringTotals => ({ oneTime: 0, monthly: 0, quarterly: 0, annual: 0, yearlyEquivalent: 0 });
const YEARLY_PAYMENTS = { monthly: 12, quarterly: 4, annual: 1 } as const;

function add(totals: RecurringTotals, item: RecurringItemResult): void {
  const amount = item.amountInr ?? 0;
  if (item.kind === "one-time") {
    totals.oneTime = round2(totals.oneTime + amount);
    return;
  }
  const frequency = item.frequency!;
  totals[frequency] = round2(totals[frequency] + amount);
  totals.yearlyEquivalent = round2(totals.yearlyEquivalent + amount * YEARLY_PAYMENTS[frequency]);
}

/** Works out one item: its rupee amount, and whether and why it is left out of the totals. */
function resolve(item: RecurringCostItem, config: CostConfig, seen: Set<string>): RecurringItemResult {
  const result: RecurringItemResult = { ...item, counted: false };
  if (seen.has(item.id)) return { ...result, reason: "Duplicate id: counted once." };
  seen.add(item.id);
  if (item.countedIn) return { ...result, reason: `Already counted in ${item.countedIn}.` };
  if (item.amountType === "percent-of-transaction") return { ...result, reason: "Charged as a percentage of each transaction: the amount depends on sales, so it is not totalled." };
  if (item.amount === null || !Number.isFinite(item.amount) || item.amount < 0) return { ...result, reason: "The amount is not known yet." };
  if (item.kind === "recurring" && !item.frequency) return { ...result, reason: "The billing frequency is missing." };
  const rate = item.currency === "INR" ? 1 : config.fxRates[item.currency];
  if (rate === undefined) return { ...result, reason: `No exchange rate is configured for ${item.currency}.` };
  const amountInr = round2(item.amount * rate);
  const yearlyInr = item.kind === "recurring" ? round2(amountInr * YEARLY_PAYMENTS[item.frequency!]) : undefined;
  if (item.payer === "studio" && item.kind === "one-time" && item.includeInDeliveryCost) {
    return { ...result, amountInr, reason: "Counted in the internal delivery cost." };
  }
  return { ...result, counted: true, amountInr, ...(yearlyInr !== undefined ? { yearlyInr } : {}) };
}

export function calcRecurring(items: RecurringCostItem[] | undefined, config: CostConfig): RecurringCost {
  const empty = (): RecurringCost["byPayer"]["client"] => ({ mandatory: noTotals(), optional: noTotals(), all: noTotals() });
  const out: RecurringCost = { provided: items !== undefined, items: [], byPayer: { client: empty(), studio: empty() }, unknown: [], variable: [], unconverted: [], notes: [] };
  if (items === undefined) {
    out.notes.push("No running costs were provided. Domain, hosting and other third-party costs are billed separately and are not part of the development quotation.");
    return out;
  }
  const seen = new Set<string>();
  for (const item of items) {
    const r = resolve(item, config, seen);
    out.items.push(r);
    if (r.reason === "The amount is not known yet.") out.unknown.push(r.id);
    else if (r.amountType === "percent-of-transaction" && !r.countedIn) out.variable.push(r.id);
    else if (r.reason?.startsWith("No exchange rate")) out.unconverted.push(r.id);
    if (!r.counted) continue;
    for (const bucket of [out.byPayer[r.payer][r.necessity], out.byPayer[r.payer].all]) add(bucket, r);
  }
  if (out.unknown.length) out.notes.push(`${out.unknown.length} running cost${out.unknown.length === 1 ? " has" : "s have"} no amount yet and ${out.unknown.length === 1 ? "is" : "are"} not in the totals.`);
  if (out.variable.length) out.notes.push("Payment gateway charges depend on sales and are not totalled.");
  if (out.unconverted.length) out.notes.push("Some costs are in a currency without a configured exchange rate and are not totalled.");
  return out;
}

/** Studio-paid one-time costs that are part of delivering the project (counted as internal cost, not as running cost). */
export function projectDeliveryCosts(recurring: RecurringCost): { id: string; service: string; amount: number }[] {
  return recurring.items
    .filter((i) => i.payer === "studio" && i.kind === "one-time" && i.includeInDeliveryCost && !i.countedIn && i.amountInr !== undefined && i.reason === "Counted in the internal delivery cost.")
    .map((i) => ({ id: i.id, service: i.service, amount: i.amountInr! }));
}

/**
 * The running costs this project is likely to have, with every amount left
 * unknown for the team to fill in. No provider prices are built in.
 */
export function suggestRecurringItems(stackIds: string[], req?: Pick<Requirement, "modules">): RecurringCostItem[] {
  const base = { currency: "INR", payer: "client" as const, status: "estimated" as const, amount: null };
  const items: RecurringCostItem[] = [
    { ...base, id: "domain", service: "Domain name renewal", category: "domain-renewal", kind: "recurring", necessity: "mandatory", note: "Price depends on the registrar and the extension." },
  ];
  const hosting: Record<string, { category: RecurringCostItem["category"]; service: string }> = {
    "shared-hosting": { category: "shared-hosting", service: "Shared hosting" },
    vps: { category: "vps", service: "VPS hosting" },
    "cloud-hosting": { category: "cloud-hosting", service: "Cloud hosting" },
  };
  const chosen = stackIds.filter((id) => hosting[id]);
  for (const id of chosen) items.push({ ...base, id: `hosting-${id}`, ...hosting[id], kind: "recurring", necessity: "mandatory", note: "Plan and billing period are chosen by the client." });
  if (!chosen.length) items.push({ ...base, id: "hosting", service: "Hosting (plan not chosen yet)", category: "other", kind: "recurring", necessity: "mandatory" });
  const modules = req?.modules ?? [];
  if (modules.includes("payments")) items.push({ ...base, id: "payment-gateway", service: "Payment gateway charges", category: "payment-gateway", kind: "recurring", amountType: "percent-of-transaction", necessity: "mandatory", note: "Charged per transaction by the gateway." });
  if (modules.includes("notifications")) items.push({ ...base, id: "email-service", service: "Email / SMS service", category: "email-service", kind: "recurring", necessity: "optional" });
  if (modules.includes("api-integration")) items.push({ ...base, id: "paid-api", service: "Third-party API", category: "paid-api", kind: "recurring", necessity: "optional" });
  items.push({ ...base, id: "maintenance", service: "Maintenance and support after launch", category: "maintenance-support", kind: "recurring", necessity: "optional", note: "Agreed separately from the development quotation." });
  return items;
}
