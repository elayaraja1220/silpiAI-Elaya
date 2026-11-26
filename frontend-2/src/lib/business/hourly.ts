import { isForeign } from "./money";
import { gstFor, quoteMoney } from "./pricing";
import type { Client, HourlyEngagement, HourlyTerms, LineItem, Quote, RateCard, Requirement } from "./types";

/**
 * Hourly engagement (freelancer / consultant style), priced from the team's own estimate. Pure, so the form's live preview and the
 * saved quotation always agree.
 *
 *   rate x estimated hours = the estimate; the estimate can be `rangePct` lower or higher, and the higher end is the CAP:
 *   the client is billed for the hours actually worked, never above the cap without approving more.
 *
 * The people on the team do the work and log their hours; SILPI keeps the quote, the hours and the bills in one place.
 */

const round2 = (n: number) => Math.round(n * 100) / 100;
const halfUp = (n: number) => Math.ceil(n * 2 - 1e-9) / 2;
const halfNear = (n: number) => Math.round(n * 2) / 2;

export const isHourly = (req: Pick<Requirement, "billing"> | undefined): boolean => req?.billing === "hourly";

/** Lowest, expected and cap hours of an engagement. */
export function hourlyBounds(h: Pick<HourlyEngagement, "estimatedHours" | "rangePct">): { min: number; expected: number; cap: number } {
  const expected = halfNear(Math.max(0.5, h.estimatedHours));
  const pct = Math.max(0, h.rangePct) / 100;
  return { min: Math.max(0.5, halfNear(expected * (1 - pct))), expected, cap: halfUp(expected * (1 + pct)) };
}

/** Total incl. GST for a number of hours (the same GST rules as the fixed price). */
export function hourlyTotal(hours: number, rate: number, client: Pick<Client, "state" | "currency">, rates: RateCard): number {
  const { snap, whole } = hourlyRounding(client, rates);
  const taxable = snap(hours * rate);
  return whole(taxable + gstFor(client, rates, taxable).total);
}

/** Amounts are held in rupees; for a client abroad each is snapped to a whole cent of THEIR currency, and a total to a whole unit, so what they see adds up. */
function hourlyRounding(client: Pick<Client, "state" | "currency">, rates: RateCard) {
  const money = quoteMoney(client, rates, "hourly");
  const foreign = isForeign(money);
  return {
    money,
    foreign,
    snap: (inr: number) => (foreign ? (Math.round((inr / money.unit) * 100) / 100) * money.unit : round2(inr)),
    whole: (inr: number) => (foreign ? Math.round(inr / money.unit) * money.unit : Math.round(inr)),
  };
}

/** The price of an hour as held in rupees: the quotation-currency price times the rupee value of one unit, or the rupee rate itself. */
export function hourlyRateInr(h: Pick<HourlyEngagement, "rate" | "rateNative">, client: Pick<Client, "state" | "currency">, rates: RateCard): number {
  const { money, foreign } = hourlyRounding(client, rates);
  return foreign && h.rateNative && h.rateNative > 0 ? h.rateNative * money.unit : h.rate;
}

/** Where the price came from, in words, when it was taken from a market rate. */
export function marketNote(h: HourlyEngagement): string | undefined {
  const m = h.market;
  if (!m) return undefined;
  const kind = { employee: "employee wage", freelancer: "freelancer billing rate", agency: "agency billing rate" }[m.kind];
  const where = [h.country, h.roleId, h.levelId].filter(Boolean).join(" / ");
  return `Market benchmark: ${kind} for ${where}, from ${m.effectiveDate} (${m.source})${m.illustrative ? ". An illustrative assumption, not a measured market rate" : ""}${h.override ? ". The price was set by hand and differs from the benchmark" : ""}.`;
}

export function hourlyTerms(h: HourlyEngagement, client: Pick<Client, "state" | "currency">, rates: RateCard): HourlyTerms {
  const b = hourlyBounds(h);
  const rate = hourlyRateInr(h, client, rates);
  const note = marketNote(h);
  return {
    ...(note ? { marketNote: note } : {}),
    role: h.role,
    rate,
    cycle: h.cycle,
    rangePct: h.rangePct,
    minHours: b.min,
    expectedHours: b.expected,
    capHours: b.cap,
    minTotal: hourlyTotal(b.min, rate, client, rates),
    expectedTotal: hourlyTotal(b.expected, rate, client, rates),
    capTotal: hourlyTotal(b.cap, rate, client, rates),
  };
}

/** The quotation for an hourly engagement. The grand total is the ESTIMATE; the bill is the hours actually worked, up to the cap. */
export function buildHourlyQuote(req: Requirement, client: Pick<Client, "state" | "currency">, rates: RateCard): Quote {
  const h = req.hourly;
  if (!h || h.rate <= 0 || h.estimatedHours <= 0) throw new Error("An hourly engagement needs a rate and an estimate of the hours.");
  const terms = hourlyTerms(h, client, rates);
  const { snap, whole, money, foreign } = hourlyRounding(client, rates);
  const hours = terms.expectedHours;
  const amount = snap(hours * terms.rate);
  const items: LineItem[] = [
    { category: "development", description: `${h.role || "Specialist"}: hourly engagement (estimate)`, detail: `Billed for the hours actually worked, not more than ${terms.capHours} hours without your approval.`, qty: hours, unit: "hour", rate: terms.rate, amount },
  ];
  const gst = gstFor(client, rates, amount);
  const exact = snap(amount + gst.total);
  const grandTotal = whole(exact);
  const advance = whole((grandTotal * rates.advancePercent) / 100);
  return {
    ...(foreign ? { currency: money.code, inrPerUnit: money.unit } : {}),
    hourly: terms,
    items,
    totalHours: hours,
    subtotal: amount,
    discount: 0,
    taxable: amount,
    gst,
    roundOff: snap(grandTotal - exact),
    grandTotal,
    schedule: [
      { label: "Advance - before work starts, adjusted in the final bill", percent: rates.advancePercent, amount: advance },
      { label: "Balance - billed on the hours actually worked, up to the cap", percent: 100 - rates.advancePercent, amount: grandTotal - advance },
    ],
    stack: { frontend: "As agreed during the engagement", backend: "", database: "", styling: "", hosting: "static", notes: [] },
    estimatedWeeks: Math.max(1, Math.ceil(hours / Math.max(1, rates.hoursPerWeek))),
    seo: { included: [], recommended: [], keywords: [] },
    pageCount: { billable: 0, supporting: 0 },
  };
}

/** How far the hours actually worked have used the estimate and the cap. Pure; the hours screen and the bill use it. */
export function hourlyProgress(terms: HourlyTerms, workedHours: number) {
  const worked = Math.round(workedHours * 10) / 10;
  const usedOfCap = terms.capHours > 0 ? worked / terms.capHours : 0;
  return {
    worked,
    amountWorked: round2(worked * terms.rate),
    remainingToCap: Math.max(0, Math.round((terms.capHours - worked) * 10) / 10),
    usedOfCap,
    status: worked > terms.capHours ? ("over" as const) : usedOfCap >= 0.8 ? ("near" as const) : worked > terms.expectedHours ? ("above-estimate" as const) : ("on-track" as const),
  };
}
