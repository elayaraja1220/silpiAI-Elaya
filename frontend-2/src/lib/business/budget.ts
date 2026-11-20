import { buildQuote } from "./pricing";
import type { Proposal } from "./proposals";
import { billablePages, isOptionalFeature, moveToPhase2, pagePriority, supportingPages } from "./scope";
import type { BudgetCheck, Client, DesignSource, ModuleId, PagePlan, Quote, RateCard, Requirement } from "./types";

/**
 * Compares a priced scope with the client's budget. The budget is a limit,
 * not a formula: the price is never changed here. When it is over, this
 * explains why and which optional features could move to Phase 2.
 * Pure: used by the live estimate and stored with the quotation.
 */

/** At or above this share of the budget the status is "near budget". */
export const NEAR_BUDGET_SHARE = 0.9;

export function checkBudget(
  req: Requirement,
  quote: Quote,
  client: Pick<Client, "state">,
  rates: RateCard,
  proposals?: Pick<Proposal, "tier" | "title" | "grandTotal" | "requirement">[],
): BudgetCheck {
  const budget = req.budget && req.budget > 0 ? req.budget : 0;
  const total = quote.grandTotal;

  // What the price is made of: set-up, all pages together, each feature, design.
  const pageItems = quote.items.filter((i) => i.description.startsWith("Page: "));
  const groups = [
    ...quote.items.filter((i) => !i.description.startsWith("Page: ")).map((i) => ({ label: i.description, amount: i.amount })),
    ...(pageItems.length ? [{ label: `${billablePages(req).length} pages`, amount: pageItems.reduce((s, i) => s + i.amount, 0) }] : []),
  ];
  const contributors = groups
    .filter((g) => g.amount > 0)
    .sort((a, b) => b.amount - a.amount)
    .map((g) => ({ ...g, amount: Math.round(g.amount * 100) / 100, share: quote.subtotal > 0 ? Math.round((g.amount / quote.subtotal) * 100) : 0 }));

  // Optional features, largest saving first. Must-haves are never suggested.
  const suggestions = req.modules
    .filter((m) => isOptionalFeature(req, m) && rates.modules[m])
    .map((m) => ({ module: m, label: rates.modules[m].label, saving: total - buildQuote(moveToPhase2(req, m), client, rates, quote.discount).grandTotal }))
    .filter((s) => s.saving > 0)
    .sort((a, b) => b.saving - a.saving);

  if (!budget) return { status: "none", budget: 0, total, difference: 0, contributors, suggestions: [] };

  const difference = budget - total;
  if (total <= budget) {
    return { status: total >= budget * NEAR_BUDGET_SHARE ? "near" : "within", budget, total, difference, contributors, suggestions: [] };
  }

  // Move only as many optional features as needed (largest first) to fit.
  let trial = req;
  let after = total;
  const needed: BudgetCheck["suggestions"] = [];
  for (const s of suggestions) {
    if (after <= budget) break;
    trial = moveToPhase2(trial, s.module);
    after = buildQuote(trial, client, rates, quote.discount).grandTotal;
    needed.push(s);
  }
  const fitting = proposals
    ?.filter((p) => p.grandTotal <= budget)
    .sort((a, b) => b.grandTotal - a.grandTotal)[0];

  // Pages: what the budget can build, sized like the Basic package.
  const basicReq = proposals?.find((p) => p.tier === "basic")?.requirement ?? req;
  const fullReq = proposals?.find((p) => p.tier === "premium")?.requirement ?? req;
  const plan = pagePlan(basicReq, fullReq, budget, client, rates);

  const designOptions = (Object.keys(rates.design) as DesignSource[])
    .filter((x) => x !== req.design && rates.design[x].hours < (rates.design[req.design]?.hours ?? 0))
    .map((x) => ({ design: x, label: rates.design[x].label, saving: total - buildQuote({ ...req, design: x }, client, rates, quote.discount).grandTotal }))
    .filter((o) => o.saving > 0)
    .sort((a, b) => b.saving - a.saving);
  const above = proposals?.filter((p) => p.grandTotal > budget).sort((a, b) => a.grandTotal - b.grandTotal)[0];

  return {
    designOptions: designOptions.length ? designOptions : undefined,
    askMore: above ? { title: above.title, total: above.grandTotal, extra: above.grandTotal - budget } : undefined,
    pagePlan: plan,
    status: after <= budget ? "over" : "scope-adjustment",
    budget,
    total,
    difference,
    contributors,
    suggestions: after <= budget ? needed : suggestions,
    totalAfterSuggestions: suggestions.length ? after : undefined,
    fittingTier: fitting ? { tier: fitting.tier, title: fitting.title, total: fitting.grandTotal } : undefined,
  };
}

export const BUDGET_STATUS_LABELS: Record<BudgetCheck["status"], string> = {
  none: "No budget stated",
  within: "Within budget",
  near: "Near budget",
  over: "Over budget",
  "scope-adjustment": "Scope adjustment required",
};

/** Largest number of pages (most important first) whose total stays within the budget. */
function fitPages(base: Requirement, order: string[], withForm: boolean, budget: number, client: Pick<Client, "state">, rates: RateCard) {
  const modules: ModuleId[] = withForm
    ? [...new Set([...base.modules, "contact-form" as ModuleId])]
    : base.modules.filter((m) => m !== "contact-form");
  const supporting = supportingPages(base);
  let best = { count: 0, total: 0 };
  for (let n = 1; n <= order.length; n++) {
    const total = buildQuote({ ...base, modules, pages: [...order.slice(0, n), ...supporting] }, client, rates).grandTotal;
    if (total > budget) break;
    best = { count: n, total };
  }
  return best;
}

/**
 * "With your budget we can build N pages and the contact form": used when the
 * requested pages do not fit. Pages are sized as in the Basic package; the
 * range runs from the requested page size (fewest) to compact pages (most).
 * Returns nothing when every requested page already fits.
 */
export function pagePlan(basic: Requirement, full: Requirement, budget: number, client: Pick<Client, "state">, rates: RateCard): PagePlan | undefined {
  if (!budget || basic.scope === "module") return undefined;
  const order = pagePriority(billablePages(basic));
  if (order.length === 0) return undefined;
  const wantsForm = basic.modules.includes("contact-form") || full.modules.includes("contact-form") || (full.deferredModules ?? []).includes("contact-form");

  // Best fit for one page size: the contact form only when it still leaves at least one page.
  const best = (sized: Requirement) => {
    const withForm = fitPages(sized, order, true, budget, client, rates);
    const without = fitPages(sized, order, false, budget, client, rates);
    const useForm = withForm.count > 0 && (wantsForm || withForm.count === without.count);
    return { useForm, ...(useForm ? withForm : without) };
  };

  const compactSections = (p: string) => (/^home\b/i.test(p) ? 2 : 1);
  const compact: Requirement = {
    ...basic,
    pageDetails: Object.fromEntries(order.map((p) => [p, { ...basic.pageDetails?.[p], purpose: basic.pageDetails?.[p]?.purpose ?? "", sections: compactSections(p) }])),
  };

  // Basic-size pages first; when not even one fits, compact pages (Home 2 sections, others 1).
  let chosen = best(basic);
  let useCompact = false;
  if (chosen.count === 0) {
    const small = best(compact);
    if (small.count > 0) {
      chosen = small;
      useCompact = true;
    }
  }
  if (chosen.count >= order.length && (!wantsForm || chosen.useForm)) return undefined;

  const asRequested: Requirement = { ...basic, pageDetails: full.pageDetails };
  const most = fitPages(compact, order, chosen.useForm, budget, client, rates).count;
  const fewest = fitPages(asRequested, order, chosen.useForm, budget, client, rates).count;
  const pages = order.slice(0, chosen.count);

  return {
    minPages: Math.min(fewest, chosen.count),
    maxPages: Math.max(most, chosen.count),
    pages,
    sections: useCompact ? Object.fromEntries(pages.map((p) => [p, compactSections(p)])) : undefined,
    contactForm: chosen.useForm,
    total: chosen.total,
    phase2Pages: order.slice(chosen.count),
    minimumTotal: buildQuote({ ...compact, modules: compact.modules.filter((m) => m !== "contact-form"), pages: [order[0]] }, client, rates).grandTotal,
  };
}
