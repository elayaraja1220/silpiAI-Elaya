import {
  BILLING_CYCLES,
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
import { parseItems } from "./clarifications";
import { countryOf, currencyOfCountry } from "./countries";
import { CURRENCIES } from "./currency";
import { HANDOVER_LABEL, INDIAN_STATES } from "./rate-card";
import { autoComplexity, billablePages, splitPages } from "./scope";
import { parseClientTechInput, parseSelectedStack } from "./tech-preference";

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
  // The client's country. A client outside India is quoted for their country, in its currency unless another is chosen.
  const countryCode = str(c.country, 2).toUpperCase();
  if (countryCode) {
    const country = countryOf(countryCode);
    if (!country) throw new ValidationError(`${countryCode} is not a country we can quote for.`);
    if (country.code === "IN" && client.state === "Outside India") throw new ValidationError("A client in India needs an Indian state (it decides the GST).");
    if (country.code !== "IN" && client.state !== "Outside India") throw new ValidationError("A client outside India has the state \"Outside India\".");
    client.country = country.code;
  }
  // The currency a client abroad is quoted in. Meaningless for a client in India (always rupees), so it is dropped there.
  const currency = str(c.currency, 3).toUpperCase() || (client.country && client.country !== "IN" ? currencyOfCountry(client.country) ?? "" : "");
  if (currency && currency !== "INR") {
    if (!CURRENCIES.some((x) => x.code === currency)) throw new ValidationError(`${currency} is not a currency we can quote in.`);
    if (client.state === "Outside India") client.currency = currency;
  }
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
    ...(parseSelectedStack(r.selectedStack) ? { selectedStack: parseSelectedStack(r.selectedStack) } : {}),
    stack: oneOf(r.stack, STACKS, "custom"),
    tech: Object.fromEntries(
      (["frontend", "backend", "database", "styling"] as const).flatMap((layer) => {
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
      confirmed: strList(insights.confirmed, 400, 400),
      assumptions: strList(insights.assumptions, 100, 400),
      questions: strList(insights.questions, 100, 400),
      ...(Array.isArray(insights.tracker) ? { tracker: parseItems(insights.tracker) } : {}),
      ...(obj(insights.lastChange).newlyDiscovered !== undefined
        ? { lastChange: { newlyDiscovered: Math.max(0, Math.round(Number(obj(insights.lastChange).newlyDiscovered)) || 0), duplicatesRemoved: Math.max(0, Math.round(Number(obj(insights.lastChange).duplicatesRemoved)) || 0) } }
        : {}),
    },
  };

  // Hourly engagement (freelancer / consultant style): priced from rate x estimated hours, not from pages and features.
  if (r.billing === "hourly") {
    const h = obj(r.hourly);
    const rate = Math.round(Number(h.rate));
    const hours = Math.round(Number(h.estimatedHours) * 2) / 2;
    if (!Number.isFinite(rate) || rate < 1 || rate > 1_000_000) throw new ValidationError("Enter the price of one hour (more than zero).");
    if (!Number.isFinite(hours) || hours < 1 || hours > 5000) throw new ValidationError("Enter the estimated hours (1 to 5000).");
    req.billing = "hourly";
    req.hourly = { role: str(h.role, 80) || "Specialist", rate, estimatedHours: hours, rangePct: int(h.rangePct, 0, 100, 20), cycle: oneOf(h.cycle, BILLING_CYCLES, "monthly") };
    // The price in the quotation's own currency (up to two decimals), and what the market rate was looked up for. The market figure itself is never taken from the
    // browser: the server looks it up and writes it (see enrichHourly in pricing-data.ts).
    const native = Number(h.rateNative);
    if (h.rateNative !== undefined && h.rateNative !== null && h.rateNative !== "") {
      if (!Number.isFinite(native) || native <= 0 || native > 1_000_000) throw new ValidationError("The hourly price must be more than zero.");
      req.hourly.rateNative = Math.round(native * 100) / 100;
    }
    const code = str(h.country, 2).toUpperCase();
    if (code && !countryOf(code)) throw new ValidationError(`${code} is not a country we can quote for.`);
    if (code) req.hourly.country = code;
    for (const [key, pattern, label] of [["roleId", /^[a-z0-9-]{2,41}$/, "role"], ["levelId", /^[a-z0-9-]{2,20}$/, "experience level"]] as const) {
      const v = str(h[key], 41).toLowerCase();
      if (v && !pattern.test(v)) throw new ValidationError(`That ${label} is not valid.`);
      if (v) req.hourly[key] = v;
    }
    if (h.override === true) req.hourly.override = true;
    req.scope = "full";
    if (!req.title) throw new ValidationError("Project title is required.");
    if (req.summary.length < 20) throw new ValidationError("Describe the work in at least a sentence or two.");
    return req;
  }

  // What a fixed price is based on (role, level, country). The market figure is never taken from the browser: the server looks it up (see enrichFixed).
  const fb = obj(r.fixedBasis);
  const fbRole = str(fb.roleId, 41).toLowerCase();
  const fbLevel = str(fb.levelId, 20).toLowerCase();
  if (fbRole || fbLevel) {
    if (!/^[a-z0-9-]{2,41}$/.test(fbRole) || !/^[a-z0-9-]{2,20}$/.test(fbLevel)) throw new ValidationError("Choose both a role and an experience level for the price.");
    const fbCountry = str(fb.country, 2).toUpperCase();
    if (fbCountry && !countryOf(fbCountry)) throw new ValidationError(`${fbCountry} is not a country we can quote for.`);
    req.fixedBasis = { roleId: fbRole, levelId: fbLevel, ...(fbCountry ? { country: fbCountry } : {}) };
  }
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
/** Prices for clients abroad. Each entry needs an hourly price and how many rupees one unit is worth; anything else is refused rather than guessed. */
export function parseCountryPricing(input: unknown): NonNullable<RateCard["countryPricing"]> {
  const out: NonNullable<RateCard["countryPricing"]> = {};
  for (const [code, v] of Object.entries(obj(input))) {
    if (code === "INR") continue; // rupees are the main hourly rate
    if (!CURRENCIES.some((c) => c.code === code)) throw new ValidationError(`${code} is not a currency we can quote in.`);
    const p = obj(v);
    const hourly = Number(p.hourlyRate);
    const unit = Number(p.inrPerUnit);
    // 0 means "no fixed-price rate for this currency": it can still be used for an hourly engagement, which brings its own price.
    if (!Number.isFinite(hourly) || hourly < 0 || hourly > 1_000_000) throw new ValidationError(`The hourly price for ${code} must be 0 or more.`);
    if (!Number.isFinite(unit) || unit < 0.0001 || unit > 2000) throw new ValidationError(`Say how many rupees one ${code} is worth (between 0.0001 and 2,000).`);
    const asOf = typeof p.rateAsOf === "string" && !Number.isNaN(Date.parse(p.rateAsOf)) ? new Date(p.rateAsOf).toISOString() : undefined;
    out[code] = { hourlyRate: Math.round(hourly * 100) / 100, inrPerUnit: Math.round(unit * 1e6) / 1e6, auto: p.auto !== false, ...(asOf && p.auto !== false ? { rateAsOf: asOf } : {}) };
  }
  return out;
}

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
    ...(card.countryPricing === undefined ? (fallback.countryPricing ? { countryPricing: fallback.countryPricing } : {}) : { countryPricing: parseCountryPricing(card.countryPricing) }),
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
        // Wording used by older saved cards: the handover was renamed, and the rest is now its own comparison row.
        const legacy: Record<string, string | null> = { "Website handover with login details": HANDOVER_LABEL, "Training on updating content": null, "Speed and security check before launch": null, "Priority support": null };
        const extras = Array.isArray(o.extras)
          ? [...new Set(o.extras.map((e) => str(e, 160)).filter(Boolean).map((e) => (e in legacy ? legacy[e] : e)).filter((e): e is string => !!e))].slice(0, 20)
          : base.extras;
        const text = (value: unknown, fallbackText: string | undefined) => (typeof value === "string" ? str(value, 200) || undefined : fallbackText);
        const priority = o.prioritySupport;
        // A reply time is only promised when a sensible number was set; anything else means "no promise".
        const hours = obj(priority).responseHours;
        const prioritySupport =
          priority === null ? null : priority === undefined ? base.prioritySupport : { responseHours: typeof hours === "number" && Number.isFinite(hours) && hours >= 1 && hours <= 720 ? Math.round(hours) : null };
        return [
          tier,
          {
            revisions: scalar(o.revisions, base.revisions),
            supportDays: scalar(o.supportDays, base.supportDays),
            extras,
            handover: text(o.handover, base.handover),
            documentation: text(o.documentation, base.documentation),
            security: text(o.security, base.security),
            ...(prioritySupport !== undefined ? { prioritySupport } : {}),
          },
        ];
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
