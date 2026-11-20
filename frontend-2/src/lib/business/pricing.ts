import { billablePages, supportingPages } from "./scope";
import { seoAdvice } from "./seo";
import { clientLayerIds, frontendLabel, listLabels, unmatchedNames } from "./tech-preference";
import { separateServices } from "./services";
import type { Client, LineItem, Quote, RateCard, Requirement, StackChoice, StackSuggestion } from "./types";

/**
 * Pure pricing engine: requirement + rate card -> line items, GST and payment
 * schedule. No I/O, so the browser uses it for the live estimate and the
 * server uses it for the saved quotation; both always agree.
 *
 * Development is priced in hours: project set-up + each page (a fixed part
 * plus its sections) + each feature, adjusted for complexity and technology,
 * times the hourly rate.
 */

const round2 = (n: number) => Math.round(n * 100) / 100;
/** Hours are shown in half-hour steps. */
const halfHours = (n: number) => Math.round(n * 2) / 2;

export function needsBackend(req: Requirement, rates: RateCard): boolean {
  return (
    req.projectType === "cms-website" ||
    req.projectType === "ecommerce" ||
    req.projectType === "web-app" ||
    req.modules.some((m) => rates.modules[m]?.backend)
  );
}

/**
 * The technology approach that applies. Static sites have no backend to
 * choose, and module / version work keeps the existing project's stack.
 */
export function effectiveStack(req: Requirement, rates: RateCard): StackChoice {
  if (!needsBackend(req, rates) || req.scope === "module" || req.scope === "version") return "custom";
  return req.stack && rates.stacks[req.stack] ? req.stack : "custom";
}

/** Typical size of a page when the requirement does not say. */
export function defaultSections(page: string, rates: RateCard): number {
  if (/^home\b/i.test(page)) return Math.max(rates.page.defaultSections, 5);
  if (/contact|privacy|terms|refund|return|shipping polic/i.test(page)) return 2;
  return rates.page.defaultSections;
}

export function sectionsOf(req: Requirement, page: string, rates: RateCard): number {
  const n = req.pageDetails?.[page]?.sections;
  return n && n > 0 ? Math.min(30, Math.round(n)) : defaultSections(page, rates);
}

/** Technology the client picked (valid ids only). Module / version work keeps the existing stack. */
export function chosenTech(req: Requirement, rates: RateCard) {
  if (req.scope === "module" || req.scope === "version" || !rates.technology) return {} as Record<"frontend" | "backend" | "database", { label: string; factor: number } | undefined>;
  const pick = (layer: "frontend" | "backend" | "database") => {
    const id = req.tech?.[layer];
    return id ? rates.technology[layer]?.[id] : undefined;
  };
  return { frontend: pick("frontend"), backend: pick("backend"), database: pick("database") };
}

/** Hours factor of the technology: the chosen backend replaces the approach's own factor. */
export function techFactor(req: Requirement, rates: RateCard): number {
  const t = chosenTech(req, rates);
  const backendNeeded = needsBackend(req, rates);
  const stackPart = backendNeeded && t.backend ? t.backend.factor : (rates.stacks[effectiveStack(req, rates)]?.devFactor ?? 1);
  return stackPart * (t.frontend?.factor ?? 1) * (backendNeeded ? (t.database?.factor ?? 1) : 1);
}

export function suggestStack(req: Requirement, rates: RateCard): StackSuggestion {
  const backendNeeded = needsBackend(req, rates);
  const choice = effectiveStack(req, rates);
  const approach = rates.stacks[choice];
  const notes: string[] = [];

  const tech = chosenTech(req, rates);
  let frontend = tech.frontend ? (backendNeeded ? tech.frontend.label : `${tech.frontend.label}, exported as a static site`) : backendNeeded ? approach.frontend : "Next.js (React), exported as a static site";
  let backend = backendNeeded ? (tech.backend?.label ?? approach.backend) : "None (static site)";
  let database = backendNeeded ? (tech.database?.label ?? approach.database) : "None";
  // Technology the client asked for (or confirmed instead) is shown as asked, not replaced by our default.
  const clientFront = clientLayerIds(req, "frontend");
  const clientBack = clientLayerIds(req, "backend");
  const clientData = clientLayerIds(req, "database");
  if (tech.frontend || tech.backend || tech.database) notes.push("Technology chosen by the client; the estimate is adjusted for it.");
  if (choice !== "custom") notes.push(approach.note);
  if (req.projectType === "cms-website" && choice === "custom" && !tech.frontend) {
    frontend = "Next.js (React) + SILPI CMS admin";
    notes.push("Built on the SILPI CMS starter (React + Node): pages, posts, media, menus and SEO are editable by the client.");
  }
  let styling = "Tailwind CSS";
  if (clientFront.length) {
    frontend = frontendLabel(clientFront);
    styling = clientFront.includes("bootstrap") ? "Bootstrap" : clientFront.some((id) => id === "html" || id === "css") ? "CSS" : styling;
  }
  if (backendNeeded && clientBack.length) backend = listLabels(clientBack);
  if (backendNeeded && clientData.length) database = listLabels(clientData);
  if (req.clientTech && req.scope !== "module" && req.scope !== "version") {
    const asked = req.clientTech.stated.join(", ");
    if (req.clientTech.confirmedIds?.length) {
      notes.push(`The client asked for ${asked}, which could not be used; they confirmed ${listLabels(req.clientTech.confirmedIds, ", ")} instead.`);
    } else {
      notes.push(`Technology requested by the client: ${asked}. It is used as requested; nothing is substituted without the client's confirmation.`);
      for (const name of unmatchedNames(req.clientTech)) notes.push(`"${name}" is not in our technology list yet: confirm with the client before building.`);
    }
    if (!backendNeeded && (clientBack.length || clientData.length)) {
      notes.push(`The requested ${listLabels([...clientBack, ...clientData], ", ")} is not used because this project needs no server or database.`);
    }
  }
  if (!backendNeeded && req.modules.includes("contact-form")) {
    notes.push("Contact form enquiries reach the client by email through a form service (e.g. Web3Forms free plan); no server needed.");
  }
  if (req.modules.includes("payments")) notes.push("Payments through Razorpay (UPI, cards, net banking).");
  if (req.modules.includes("chat") && (!clientBack.length || clientBack.includes("nodejs"))) notes.push("Live chat uses Socket.IO on the Node server.");
  if (req.modules.includes("multilingual") && (!clientFront.length || clientFront.includes("nextjs"))) notes.push("Translations through next-intl; content can be entered per language.");
  if (req.scope === "module" || req.scope === "version") {
    notes.push(`Work is added to the existing project${req.existingProject ? ` "${req.existingProject}"` : ""}; its current stack is kept.`);
  }

  const hosting = !backendNeeded ? "static" : req.projectType === "ecommerce" || req.projectType === "web-app" ? "cloud" : "vps";
  if (req.hosting.needed && backendNeeded && (req.hosting.plan === "shared" || req.hosting.plan === "static")) {
    notes.push("Shared or static hosting cannot run a Node.js backend; VPS or cloud hosting is recommended.");
  }

  return { approach: backendNeeded ? approach.label : "Static site", frontend, backend, database, styling, hosting, notes };
}

export function gstFor(client: Pick<Client, "state">, rates: RateCard, taxable: number): Quote["gst"] {
  if (client.state === "Outside India") {
    return { mode: "export", rate: 0, cgst: 0, sgst: 0, igst: 0, total: 0 };
  }
  const rate = rates.gstRate;
  if (client.state && client.state === rates.business.state) {
    const half = round2((taxable * rate) / 200);
    return { mode: "intra", rate, cgst: half, sgst: half, igst: 0, total: round2(half * 2) };
  }
  const igst = round2((taxable * rate) / 100);
  return { mode: "inter", rate, cgst: 0, sgst: 0, igst, total: igst };
}

export function buildQuote(req: Requirement, client: Pick<Client, "state">, rates: RateCard, discount = 0): Quote {
  const items: LineItem[] = [];
  const rate = rates.hourlyRate;
  const stack = effectiveStack(req, rates);
  const factor = (rates.complexity[req.complexity]?.multiplier ?? 1) * techFactor(req, rates);
  let devHours = 0;
  const work = (category: LineItem["category"], description: string, rawHours: number, detail?: string) => {
    const hours = halfHours(rawHours * (category === "development" ? factor : 1));
    if (hours <= 0 || rate <= 0) return;
    devHours += hours;
    items.push({ category, description, detail, qty: hours, unit: "hour", rate, amount: round2(hours * rate) });
  };

  const type = rates.projectTypes[req.projectType];
  const billable = billablePages(req);
  const supporting = supportingPages(req);
  // Shared parts and small utility pages are built once as part of the set-up, never billed as pages.
  const included = [
    "shared header, footer and navigation",
    ...(supporting.length ? [`supporting page${supporting.length === 1 ? "" : "s"}: ${supporting.join(", ")}`] : []),
  ];
  const setupShare = rates.scopeBaseFactor[req.scope] ?? 1;
  const scopeLabel = { full: "", partial: " (partial scope)", module: "", version: ` (version ${req.version || "upgrade"})` }[req.scope];
  work(
    "development",
    `${type.label}${scopeLabel}: set-up, testing & deployment`,
    type.setupHours * setupShare,
    `${rates.complexity[req.complexity].label} complexity${stack === "custom" ? "" : ` · ${rates.stacks[stack].label}`}. Includes ${included.join("; ")}. Responsive layout, cross-browser testing, go-live.`,
  );
  if (req.scope === "module" || req.scope === "version") {
    work("development", "Existing codebase review & setup", rates.existingProjectHours, "Read the current code, set up a copy and plan the changes safely.");
  }

  for (const page of billable) {
    const sections = sectionsOf(req, page, rates);
    const purpose = req.pageDetails?.[page]?.purpose?.trim();
    work("development", `Page: ${page}`, rates.page.baseHours + sections * rates.page.sectionHours, `${sections} section${sections === 1 ? "" : "s"}${purpose ? ` · ${purpose}` : ""}`);
  }

  for (const id of req.modules) {
    const mod = rates.modules[id];
    if (mod) work("development", mod.label, mod.hours, mod.detail);
  }

  if (req.premiumCare && rates.premiumCareHours > 0) {
    work("development", "Premium care", rates.premiumCareHours / factor, "Speed and security check before launch, priority support and a longer free support period.");
  }

  const design = rates.design[req.design];
  if (design) work("design", design.label, design.hours, design.detail);

  // Domain and hosting are never part of the development quotation: see separateServices().

  const subtotal = round2(items.reduce((sum, item) => sum + item.amount, 0));
  const safeDiscount = Math.min(Math.max(0, round2(discount)), subtotal);
  const taxable = round2(subtotal - safeDiscount);
  const gst = gstFor(client, rates, taxable);
  const exact = round2(taxable + gst.total);
  const grandTotal = Math.round(exact);
  const roundOff = round2(grandTotal - exact);

  const advance = Math.round((grandTotal * rates.advancePercent) / 100);
  const schedule = [
    { label: "Advance - before work starts", percent: rates.advancePercent, amount: advance },
    { label: "Balance - after demo approval, before delivery", percent: 100 - rates.advancePercent, amount: grandTotal - advance },
  ];

  // Phase 2: features and pages kept on record, priced for information only.
  const deferredIds = (req.deferredModules ?? []).filter((m) => rates.modules[m] && !req.modules.includes(m));
  const deferredPages = (req.deferredPages ?? []).filter((p) => !req.pages.includes(p));
  const deferred =
    deferredIds.length || deferredPages.length
      ? {
          modules: [...deferredIds.map((m) => rates.modules[m].label), ...deferredPages.map((p) => `${p} page`)],
          amount: round2(
            deferredIds.reduce((sum, m) => sum + halfHours(rates.modules[m].hours * factor) * rate, 0) +
              deferredPages.reduce((sum, p) => sum + halfHours((rates.page.baseHours + sectionsOf(req, p, rates) * rates.page.sectionHours) * factor) * rate, 0),
          ),
        }
      : undefined;

  return {
    items,
    totalHours: devHours,
    subtotal,
    discount: safeDiscount,
    taxable,
    gst,
    roundOff,
    grandTotal,
    schedule,
    stack: suggestStack(req, rates),
    estimatedWeeks: Math.max(1, Math.ceil(devHours / Math.max(1, rates.hoursPerWeek))),
    seo: seoAdvice(req),
    services: separateServices(req, client, rates),
    deferred,
    pageCount: { billable: billable.length, supporting: supporting.length },
  };
}

const INR = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 });
export const formatINR = (amount: number) => INR.format(amount);
