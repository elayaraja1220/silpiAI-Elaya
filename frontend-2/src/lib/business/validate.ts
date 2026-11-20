import {
  COMPLEXITIES,
  DESIGN_SOURCES,
  HOSTING_PLANS,
  MODULES,
  PAGE_KINDS,
  PROJECT_TYPES,
  SCOPES,
  SERVICE_CHOICES,
  STACKS,
  type Client,
  type ModuleId,
  type PageDetail,
  type PageKind,
  type RateCard,
  type Requirement,
} from "./types";
import { INDIAN_STATES } from "./rate-card";
import { autoComplexity, billablePages, splitPages } from "./scope";
import { parseClientTechInput } from "./tech-preference";

/** Thrown for bad input; API routes turn it into a 400. */
export class ValidationError extends Error {}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown, max = 200) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const int = (v: unknown, min: number, max: number, fallback: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
const oneOf = <T extends string>(v: unknown, list: readonly T[], fallback: T): T =>
  list.includes(v as T) ? (v as T) : fallback;
const strList = (v: unknown, maxItems: number, maxLen: number) =>
  Array.isArray(v) ? [...new Set(v.map((x) => str(x, maxLen)).filter(Boolean))].slice(0, maxItems) : [];
const moduleList = (v: unknown): ModuleId[] =>
  Array.isArray(v) ? [...new Set(v.filter((m): m is ModuleId => MODULES.includes(m as never)))] : [];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const DOMAIN_LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export function parseClient(input: unknown): Client {
  const c = obj(input);
  const client: Client = {
    name: str(c.name, 120),
    email: str(c.email, 160).toLowerCase(),
    phone: str(c.phone, 20),
    company: str(c.company, 160),
    gstin: str(c.gstin, 15).toUpperCase(),
    state: str(c.state, 60),
    address: str(c.address, 400),
  };
  if (!client.name) throw new ValidationError("Client name is required.");
  if (!EMAIL_RE.test(client.email)) throw new ValidationError("A valid client email is required.");
  if (!/^[+0-9 ()-]{7,20}$/.test(client.phone)) throw new ValidationError("A valid client phone number is required.");
  if (!INDIAN_STATES.includes(client.state)) throw new ValidationError("Choose the client's state (needed for GST).");
  if (client.gstin && !GSTIN_RE.test(client.gstin)) throw new ValidationError("GSTIN format is not valid (15 characters, e.g. 33ABCDE1234F1Z5).");
  return client;
}

export function parseRequirement(input: unknown, rates: RateCard): Requirement {
  const r = obj(input);
  const domain = obj(r.domain);
  const hosting = obj(r.hosting);
  const insights = obj(r.insights);
  const scope = oneOf(r.scope, SCOPES, "full");

  // Header, footer, navigation and similar are shared components, never pages.
  const split = splitPages(strList(r.pages, 60, 80));
  const pages = split.pages;
  const modules = moduleList(r.modules);
  const rawDetails = obj(r.pageDetails);
  const pageDetails: Record<string, PageDetail> = {};
  for (const page of pages) {
    const d = obj(rawDetails[page]);
    if (Object.keys(d).length) {
      const kind = PAGE_KINDS.includes(d.kind as PageKind) ? (d.kind as PageKind) : undefined;
      pageDetails[page] = { sections: int(d.sections, 1, 30, rates.page.defaultSections), purpose: str(d.purpose, 200), ...(kind ? { kind } : {}) };
    }
  }
  const sharedComponents = [...new Set([...strList(r.sharedComponents, 20, 80), ...split.components])];

  const tlds = Object.keys(rates.domains);
  const req: Requirement = {
    title: str(r.title, 120),
    summary: str(r.summary, 4000),
    scope,
    existingProject: str(r.existingProject, 120),
    version: str(r.version, 20),
    projectType: oneOf(r.projectType, PROJECT_TYPES, "business-website"),
    complexity: oneOf(r.complexity, COMPLEXITIES, "standard"),
    pages,
    pageDetails,
    modules,
    mustHave: moduleList(r.mustHave).filter((m) => modules.includes(m)),
    design: oneOf(r.design, DESIGN_SOURCES, "ai"),
    references: str(r.references, 2000),
    domain: {
      // "arrange" = SILPI arranges it as a separate service; older records only sent `needed`.
      choice: oneOf(domain.choice, SERVICE_CHOICES, domain.needed === true ? "arrange" : "self"),
      needed: false,
      name: str(domain.name, 63).toLowerCase(),
      tld: oneOf(domain.tld, tlds, tlds[0] ?? ".com"),
      years: int(domain.years, 1, 10, 1),
    },
    hosting: {
      choice: oneOf(hosting.choice, SERVICE_CHOICES, hosting.needed === true ? "arrange" : "self"),
      needed: false,
      plan: oneOf(hosting.plan, HOSTING_PLANS, "shared"),
      years: int(hosting.years, 1, 5, 1),
    },
    deadlineWeeks: int(r.deadlineWeeks, 0, 104, 0),
    budget: int(r.budget, 0, 1_000_000_000, 0),
    budgetStrict: r.budgetStrict === true,
    premiumCare: r.premiumCare === true,
    ...(parseClientTechInput(r.clientTech) ? { clientTech: parseClientTechInput(r.clientTech) } : {}),
    stack: oneOf(r.stack, STACKS, "custom"),
    tech: Object.fromEntries(
      (["frontend", "backend", "database"] as const).flatMap((layer) => {
        const v = obj(r.tech)[layer];
        return typeof v === "string" && rates.technology?.[layer]?.[v] ? [[layer, v]] : [];
      }),
    ),
    deferredModules: moduleList(r.deferredModules).filter((m) => !modules.includes(m)),
    excludedModules: moduleList(r.excludedModules).filter((m) => !modules.includes(m)),
    deferredPages: strList(r.deferredPages, 60, 80).filter((p) => !pages.includes(p)),
    sharedComponents,
    qualityRequirements: strList(r.qualityRequirements, 20, 160),
    externalServices: strList(r.externalServices, 20, 120),
    seoKeywords: strList(r.seoKeywords, 12, 80),
    insights: {
      confirmed: strList(insights.confirmed, 40, 300),
      assumptions: strList(insights.assumptions, 40, 300),
      questions: strList(insights.questions, 40, 300),
    },
  };

  // Complexity follows the project type and features (never typed in by hand).
  req.complexity = autoComplexity(req, rates);
  // `needed` mirrors the choice: SILPI arranges the separate service.
  req.domain.needed = req.domain.choice === "arrange";
  req.hosting.needed = req.hosting.choice === "arrange";
  if (!req.title) throw new ValidationError("Project title is required.");
  if (req.summary.length < 20) throw new ValidationError("Describe the requirement in at least a sentence or two.");
  if ((scope === "module" || scope === "version") && !req.existingProject) {
    throw new ValidationError("Name the existing project for module or version work.");
  }
  if (scope === "module" && req.modules.length === 0 && req.pages.length === 0) {
    throw new ValidationError("Pick at least one module or page for module work.");
  }
  if (scope !== "module" && billablePages(req).length === 0) throw new ValidationError("Add at least one page (supporting pages such as 404 are not enough).");
  // Must-have features cannot be in Phase 2.
  req.deferredModules = (req.deferredModules ?? []).filter((m) => !req.mustHave?.includes(m));
  if (req.domain.needed && req.domain.name && !DOMAIN_LABEL_RE.test(req.domain.name)) {
    throw new ValidationError("Domain name may only use letters, numbers and hyphens (no dots or spaces).");
  }
  return req;
}

/** Checks an edited rate card: numbers must be non-negative; business details must be valid. */
export function parseRateCard(input: unknown, fallback: RateCard): RateCard {
  const card = obj(input);
  const bad = (n: unknown) => typeof n !== "number" || !Number.isFinite(n) || n < 0;
  // Every known entry is kept; only its fields can be overridden.
  const mergeRecord = <T extends object>(base: Record<string, T>, over: unknown): Record<string, T> => {
    const o = obj(over);
    return Object.fromEntries(Object.entries(base).map(([k, v]) => [k, { ...v, ...obj(o[k]) } as T]));
  };
  const scalar = <T>(v: unknown, fallbackValue: T): T => (v === undefined ? fallbackValue : (v as T));
  const domains = obj(card.domains);
  const b = { ...fallback.business, ...obj(card.business) };
  const merged: RateCard = {
    business: {
      name: str(b.name, 160),
      gstin: str(b.gstin, 15).toUpperCase(),
      state: str(b.state, 60),
      address: str(b.address, 400),
      email: str(b.email, 160).toLowerCase(),
      phone: str(b.phone, 20),
      upiId: str(b.upiId, 60).toLowerCase(),
      bankDetails: str(b.bankDetails, 400),
    },
    gstRate: scalar(card.gstRate, fallback.gstRate),
    advancePercent: scalar(card.advancePercent, fallback.advancePercent),
    quoteValidityDays: scalar(card.quoteValidityDays, fallback.quoteValidityDays),
    maxDiscountPercent: scalar(card.maxDiscountPercent, fallback.maxDiscountPercent),
    hourlyRate: scalar(card.hourlyRate, fallback.hourlyRate),
    hoursPerWeek: scalar(card.hoursPerWeek, fallback.hoursPerWeek),
    projectTypes: mergeRecord(fallback.projectTypes, card.projectTypes) as RateCard["projectTypes"],
    page: { ...fallback.page, ...(obj(card.page) as Partial<RateCard["page"]>) },
    scopeBaseFactor: { ...fallback.scopeBaseFactor, ...(obj(card.scopeBaseFactor) as Partial<RateCard["scopeBaseFactor"]>) },
    existingProjectHours: scalar(card.existingProjectHours, fallback.existingProjectHours),
    premiumCareHours: scalar(card.premiumCareHours, fallback.premiumCareHours),
    complexity: mergeRecord(fallback.complexity, card.complexity) as RateCard["complexity"],
    modules: mergeRecord(fallback.modules, card.modules) as RateCard["modules"],
    design: mergeRecord(fallback.design, card.design) as RateCard["design"],
    stacks: mergeRecord(fallback.stacks, card.stacks) as RateCard["stacks"],
    technology: Object.fromEntries(
      (Object.keys(fallback.technology) as (keyof RateCard["technology"])[]).map((layer) => [layer, mergeRecord(fallback.technology[layer], obj(card.technology)[layer])]),
    ) as RateCard["technology"],
    // TLDs may be added or removed freely.
    // Extensions may be added or removed. Older cards stored one number (used for both prices).
    domains: Object.keys(domains).length
      ? Object.fromEntries(
          Object.entries(domains)
            .filter(([k]) => /^\.[a-z.]{2,20}$/.test(k))
            .map(([k, v]) => {
              const o = obj(v);
              return [k, typeof v === "number" ? { register: v, renew: v } : { register: o.register as number, renew: (o.renew ?? o.register) as number }];
            }),
        )
      : fallback.domains,
    hosting: Object.fromEntries(
      Object.entries(mergeRecord(fallback.hosting, card.hosting)).map(([k, h]) => [
        k,
        { ...h, label: str(h.label, 80), provider: str(h.provider, 80), serverType: str(h.serverType, 80), storage: str(h.storage, 60), bandwidth: str(h.bandwidth, 60), renew: h.renew ?? h.price, setup: h.setup ?? 0 },
      ]),
    ) as RateCard["hosting"],
    packages: Object.fromEntries(
      Object.entries(fallback.packages).map(([tier, base]) => {
        const o = obj(obj(card.packages)[tier]);
        const extras = Array.isArray(o.extras) ? o.extras.map((e) => str(e, 160)).filter(Boolean).slice(0, 20) : base.extras;
        return [tier, { revisions: scalar(o.revisions, base.revisions), supportDays: scalar(o.supportDays, base.supportDays), extras }];
      }),
    ) as RateCard["packages"],
  };
  const numbers: unknown[] = [
    merged.gstRate,
    merged.advancePercent,
    merged.quoteValidityDays,
    merged.maxDiscountPercent,
    merged.hourlyRate,
    merged.hoursPerWeek,
    merged.existingProjectHours,
    merged.page.baseHours,
    merged.page.sectionHours,
    merged.page.defaultSections,
    ...Object.values(merged.projectTypes).map((t) => t.setupHours),
    ...Object.values(merged.modules).map((m) => m.hours),
    ...Object.values(merged.design).map((d) => d.hours),
    ...Object.values(merged.stacks).map((t) => t.devFactor),
    ...Object.values(merged.domains).flatMap((d) => [d.register, d.renew]),
    ...Object.values(merged.hosting).flatMap((h) => [h.price, h.renew, h.setup]),
    ...Object.values(merged.complexity).map((c) => c.multiplier),
    ...Object.values(merged.scopeBaseFactor),
    ...Object.values(merged.packages).flatMap((p) => [p.revisions, p.supportDays]),
  ];
  if (numbers.some(bad)) throw new ValidationError("Every price, rate and hour value must be a number of 0 or more.");
  const biz = merged.business;
  if (!biz.name) throw new ValidationError("Business name is required.");
  if (!INDIAN_STATES.includes(biz.state) || biz.state === "Outside India") throw new ValidationError("Choose your business state (decides CGST+SGST or IGST).");
  if (biz.gstin && !GSTIN_RE.test(biz.gstin)) throw new ValidationError("Your GSTIN format is not valid (15 characters, e.g. 33ABCDE1234F1Z5).");
  if (biz.email && !EMAIL_RE.test(biz.email)) throw new ValidationError("Business email is not valid.");
  if (biz.upiId && !/^[a-z0-9._-]{2,256}@[a-z]{2,64}$/.test(biz.upiId)) throw new ValidationError("UPI ID looks wrong (for example yourname@okaxis).");
  if (merged.gstRate > 28) throw new ValidationError("GST rate cannot exceed 28%.");
  if (merged.hourlyRate <= 0) throw new ValidationError("Hourly rate must be more than 0.");
  if (merged.hoursPerWeek < 1 || merged.hoursPerWeek > 80) throw new ValidationError("Hours per week must be between 1 and 80.");
  if (Object.values(merged.stacks).some((t) => t.devFactor > 2)) throw new ValidationError("Technology cost must be 200% or less of custom code.");
  if (merged.advancePercent > 100) throw new ValidationError("Advance percent cannot exceed 100.");
  if (merged.maxDiscountPercent > 50) throw new ValidationError("Maximum discount cannot exceed 50%.");
  merged.stacks.custom.available = true;
  for (const s of Object.values(merged.stacks)) s.available = s.available === true;
  return merged;
}
