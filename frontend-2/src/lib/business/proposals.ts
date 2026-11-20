import { buildQuote, effectiveStack, needsBackend, sectionsOf } from "./pricing";
import { billablePages, supportingPages } from "./scope";
import type { Client, ComparisonRow, ModuleId, ProjectType, ProposalSummary, Quote, RateCard, Requirement, StackChoice, Tier } from "./types";

/**
 * Three packages from one requirement, so the client can choose:
 *   Basic    - every requested page, the essentials and every must-have feature
 *   Standard - Basic + the recommended features the client asked for
 *   Premium  - everything the client asked for (except what they moved to Phase 2)
 *
 * Rules (never broken to fit a budget):
 * - A package only contains pages and features the client asked for; nothing is added.
 * - Must-have features are in every package.
 * - Prices are never discounted automatically. The budget is compared, not forced
 *   (see budget.ts for the comparison and the Phase 2 suggestions).
 * - Phase 2 features are in no package; they stay on record and can be added back.
 * Pure: the server recomputes the exact package the client picks.
 */

export type Proposal = ProposalSummary & { requirement: Requirement; discount: number; quote: Quote };

/** Basic includes these when the client asked for them: what this kind of project cannot work without. */
const BASIC_FEATURES: Record<ProjectType, ModuleId[]> = {
  "landing-page": ["contact-form"],
  "business-website": ["contact-form"],
  "cms-website": ["contact-form", "admin-panel"],
  ecommerce: ["payments", "auth", "admin-panel"],
  "web-app": ["auth", "admin-panel"],
};

/** Standard adds these when the client asked for them. */
const STANDARD_FEATURES: Record<ProjectType, ModuleId[]> = {
  "landing-page": ["seo-setup", "whatsapp", "google-maps", "gallery-preview"],
  "business-website": ["seo-setup", "whatsapp", "google-maps", "gallery-preview"],
  "cms-website": ["seo-setup", "blog", "whatsapp", "google-maps", "gallery-preview"],
  ecommerce: ["seo-setup", "search", "notifications", "whatsapp", "contact-form"],
  "web-app": ["notifications", "reports", "contact-form"],
};

/** Standard pages keep a middle number of sections; Premium keeps all of them. */
const standardSections = (page: string) => (/^home/i.test(page) ? 4 : 3);

/** Basic pages keep their key sections only. */
const basicSections = (page: string) => (/^home\b/i.test(page) ? 3 : 2);

function cheapestStack(req: Requirement, rates: RateCard): StackChoice {
  if (!needsBackend(req, rates) || req.scope === "module" || req.scope === "version") return "custom";
  const allowed = (Object.keys(rates.stacks) as StackChoice[]).filter((s) => rates.stacks[s].available || s === "custom");
  return allowed.reduce((best, s) => (rates.stacks[s].devFactor < rates.stacks[best].devFactor ? s : best), "custom" as StackChoice);
}

/** Keeps only the package's features; the rest are "not in this package" (never built, not priced). Phase 2 is untouched. */
function keepModules(req: Requirement, keep: (m: ModuleId) => boolean): Requirement {
  return { ...req, modules: req.modules.filter(keep), excludedModules: req.modules.filter((m) => !keep(m)) };
}

export function buildProposals(request: Requirement, client: Pick<Client, "state">, rates: RateCard): Proposal[] {
  const label = (m: ModuleId) => rates.modules[m]?.label ?? m;
  const mustHave = new Set((request.mustHave ?? []).filter((m) => request.modules.includes(m)));
  // Premium is the request as the client approved it; Phase 2 features are not priced.
  const full: Requirement = { ...request, excludedModules: [], premiumCare: false };
  const budget = request.budget && request.budget > 0 ? request.budget : 0;

  const summarise = (tier: Tier, title: string, tagline: string, req: Requirement, leftOut: string[]): Proposal => {
    const quote = buildQuote(req, client, rates);
    // Domain and hosting are separate services, the same for every package.
    const features = [...req.modules.map(label), rates.design[req.design].label, ...(req.premiumCare ? ["Premium care: speed & security check, priority support"] : [])];
    const fitsBudget = budget ? quote.grandTotal <= budget : undefined;
    return {
      tier,
      title,
      tagline,
      grandTotal: quote.grandTotal,
      estimatedWeeks: quote.estimatedWeeks,
      pages: billablePages(req),
      supportingPages: supportingPages(req),
      features,
      leftOut,
      fitsBudget,
      terms: rates.packages?.[tier],
      requirement: req,
      discount: 0,
      quote,
    };
  };
  const notIncluded = (req: Requirement) => (req.excludedModules ?? []).map((m) => `${label(m)} (available in a higher package)`);

  // ---- Premium: the complete request ---------------------------------------
  // Premium also pays for its extras (speed & security check, priority support) as a separate line.
  const premium = summarise("premium", "Premium", "Everything you asked for, plus premium care.", { ...full, premiumCare: true }, []);

  // ---- Standard: essentials + recommended + must-haves ------------------------
  const standardSet = new Set<ModuleId>([...BASIC_FEATURES[full.projectType], ...STANDARD_FEATURES[full.projectType], ...mustHave]);
  let std = keepModules(full, (m) => standardSet.has(m));
  const stdOut = notIncluded(std);
  if (std.design === "custom") {
    std = { ...std, design: "template" };
    stdOut.push("Custom design replaced by a customised template");
  }
  if (std.scope !== "module") {
    const details = { ...(std.pageDetails ?? {}) };
    let trimmed = false;
    for (const p of billablePages(std)) {
      const cap = standardSections(p);
      if (sectionsOf(std, p, rates) > cap) {
        details[p] = { ...details[p], sections: cap, purpose: details[p]?.purpose ?? "" };
        trimmed = true;
      }
    }
    if (trimmed) {
      std = { ...std, pageDetails: details };
      stdOut.push("Long pages keep their main sections (Premium has every section)");
    }
  }
  const standard = summarise("standard", "Standard", "Recommended features; the best value.", std, stdOut);

  // ---- Basic: every requested page, essentials and must-haves -----------------
  const basicSet = new Set<ModuleId>([...BASIC_FEATURES[full.projectType], ...mustHave]);
  let basic = keepModules(full, (m) => basicSet.has(m));
  const basicOut = notIncluded(basic);
  if (basic.design !== "ai") {
    basicOut.push(`${rates.design[basic.design].label} replaced by an AI-generated design`);
    basic = { ...basic, design: "ai" };
  }
  if (basic.complexity === "advanced") {
    basic = { ...basic, complexity: "standard" };
    basicOut.push("Workflows kept simple in the first version");
  }
  const stack = cheapestStack(basic, rates);
  if (!basic.tech?.backend && stack !== effectiveStack(basic, rates)) {
    basic = { ...basic, stack };
    basicOut.push(`Built with ${rates.stacks[stack].label} (${rates.stacks[stack].tradeoff || "less custom code"})`);
  }
  // The same pages as requested, each with its key sections only.
  if (basic.scope !== "module") {
    const details = { ...(basic.pageDetails ?? {}) };
    let trimmed = false;
    for (const p of billablePages(basic)) {
      const cap = basicSections(p);
      if (sectionsOf(basic, p, rates) > cap) {
        details[p] = { ...details[p], sections: cap, purpose: details[p]?.purpose ?? "" };
        trimmed = true;
      }
    }
    if (trimmed) {
      basic = { ...basic, pageDetails: details };
      basicOut.push("Each page keeps its key sections only");
    }
  }
  const basicProposal = summarise("basic", "Basic", "Every page you asked for, with the essentials.", basic, basicOut);

  return [basicProposal, standard, premium];
}

/**
 * Feature-by-feature comparison of the three packages (✓ / ✗ or a value),
 * shown to the team, on the client page and in the PDF / Word quotation.
 */
export function compareProposals(proposals: Proposal[], rates: RateCard): ComparisonRow[] {
  const by = (fn: (p: Proposal) => string | boolean) =>
    Object.fromEntries(proposals.map((p) => [p.tier, fn(p)])) as Record<Tier, string | boolean>;
  const premium = proposals.find((p) => p.tier === "premium") ?? proposals[proposals.length - 1];
  const sections = (p: Proposal) => billablePages(p.requirement).reduce((sum, page) => sum + sectionsOf(p.requirement, page, rates), 0);
  const supporting = supportingPages(premium.requirement);
  const rows: ComparisonRow[] = [
    { label: "Pages", values: by((p) => `${billablePages(p.requirement).length} pages`) },
    { label: "Content sections", values: by((p) => `${sections(p)} sections`) },
    ...(supporting.length ? [{ label: `Supporting pages (${supporting.join(", ")})`, values: by(() => true) }] : []),
    { label: "Shared header, footer and navigation", values: by(() => true) },
    { label: "Responsive on mobile, tablet and desktop", values: by(() => true) },
    ...premium.requirement.modules.map((m) => ({ label: rates.modules[m]?.label ?? m, values: by((p) => p.requirement.modules.includes(m)) })),
    { label: "Basic SEO (titles, sitemap, mobile, speed)", values: by(() => true) },
    { label: "Design", values: by((p) => rates.design[p.requirement.design].label) },
    { label: "Development hours", values: by((p) => `${p.quote.totalHours} h`) },
    { label: "Delivery", values: by((p) => `about ${p.estimatedWeeks} week${p.estimatedWeeks === 1 ? "" : "s"}`) },
  ];
  if (proposals.every((p) => p.terms)) {
    rows.push(
      { label: "Revision rounds", values: by((p) => String(p.terms!.revisions)) },
      { label: "Free support after launch", values: by((p) => `${p.terms!.supportDays} days`) },
    );
    const extras = [...new Set(proposals.flatMap((p) => p.terms!.extras))];
    for (const e of extras) rows.push({ label: e, values: by((p) => p.terms!.extras.includes(e)) });
  }
  return rows;
}

/**
 * The package suggested for the client's budget: the most complete one that
 * fits (Premium, then Standard, else Basic). Without a budget: Standard.
 */
export function defaultTier(proposals: Pick<ProposalSummary, "tier" | "grandTotal">[], budget?: number): Tier {
  if (!budget || budget <= 0) return "standard";
  const fits = (t: Tier) => (proposals.find((p) => p.tier === t)?.grandTotal ?? Infinity) <= budget;
  return fits("premium") ? "premium" : fits("standard") ? "standard" : "basic";
}

export const toSummary = ({ requirement: _r, quote: _q, discount: _d, ...summary }: Proposal): ProposalSummary => summary;
