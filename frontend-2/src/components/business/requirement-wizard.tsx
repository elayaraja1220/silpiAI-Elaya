"use client";

import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { AlertTriangle, ArrowLeft, ArrowRight, Check, CheckCircle2, HelpCircle, Loader2, Plus, ShieldCheck, Sparkles, Star, X } from "lucide-react";

import { currencyOf } from "@/lib/business/currency";
import { COUNTRIES, currencyOfCountry, flagOf } from "@/lib/business/countries";
import { formatMoney, INR_MONEY, isForeign, symbolOf } from "@/lib/business/money";
import { buildQuote, needsBackend, quoteMoney, sectionsOf, stylingFits } from "@/lib/business/pricing";
import { checkBudget } from "@/lib/business/budget";
import { buildProposals, defaultTier } from "@/lib/business/proposals";
import type { CostConfig } from "@/lib/business/cost-types";
import type { TechEntry } from "@/lib/business/tech-catalog";
import { recommendTechnology } from "@/lib/business/tech-recommend";
import { parseClientTech } from "@/lib/business/tech-preference";
import {
  billablePages,
  defaultPageKind,
  isLegalPage,
  isSharedComponent,
  moveToPhase2,
  optionalPageSuggestions,
  pageKind,
  applyPagePlan,
  autoComplexity,
  restorePage,
  restoreFromPhase2,
  splitPages,
} from "@/lib/business/scope";
import { INDIAN_STATES } from "@/lib/business/rate-card";
import {
  COMPLEXITIES,
  DESIGN_SOURCES,
  MODULES,
  PROJECT_TYPES,
  SCOPES,
  type Client,
  type Lead,
  type ModuleId,
  type PageDetail,
  type PageKind,
  type MarketSnapshot,
  type Quote,
  type RateCard,
  type Requirement,
  type RequirementDraft,
  type RequirementInsights,
  type Scope,
  type Tier,
} from "@/lib/business/types";
import { cn } from "@/lib/utils";

import { BudgetSummary } from "./budget-summary";
import { estimateStatus, mergeInsights } from "@/lib/business/clarifications";
import { estimateBasis } from "@/lib/business/estimate-ledger";
import { EstimateBreakdown } from "./estimate-breakdown";
import { ClarificationSummary } from "./clarification-summary";
import { DocumentAnalyzer, type AnalysisOutcome } from "./document-analyzer";
import { PackageDetails } from "./package-details";
import { ScopeSummary } from "./scope-summary";
import { WizardCostPanel } from "./cost-panel";
import { BudgetInput } from "./budget-input";
import { MoneyProvider } from "./money-context";
import { TechnologyRecommendations } from "./technology-recommendations";
import { TechnologyChooser } from "./technology-chooser";
import { applyClientTech } from "@/lib/business/client-tech";
import { Card, Choice, Field, Input, Section, Select, Textarea, jsonFetch } from "./ui";
import { FixedBasisPicker, type FixedBasisChoice } from "./fixed-market-basis";

const STEPS = ["Requirement", "Pages & features", "Package", "Client & services", "Review"] as const;
const CLIENT_STEPS = ["Your requirement", "Pages & features", "Package", "Your details & services", "Review"] as const;
const PACKAGE_STEP = 2;

const SCOPE_OPTIONS: { id: Scope; title: string; detail: string }[] = [
  { id: "full", title: "Full project", detail: "A complete new website or app" },
  { id: "partial", title: "Partial", detail: "Part of a project, e.g. only the frontend" },
  { id: "module", title: "Module", detail: "Add features to an existing project" },
  { id: "version", title: "New version", detail: "Upgrade an existing project, e.g. v2" },
];

const PAGE_SUGGESTIONS = ["Home", "About", "Services", "Products", "Gallery", "Blog", "Pricing", "FAQ", "Testimonials", "Careers", "Contact", "404 Not Found"];

const emptyClient: Client = { name: "", email: "", phone: "", company: "", gstin: "", state: "Tamil Nadu", address: "" };
const emptyRequirement: Requirement = {
  title: "",
  summary: "",
  scope: "full",
  existingProject: "",
  version: "",
  projectType: "business-website",
  complexity: "standard",
  pages: [],
  modules: [],
  design: "ai",
  references: "",
  domain: { needed: false, choice: "self", name: "", tld: ".com", years: 1 },
  hosting: { needed: false, choice: "self", plan: "static", years: 1 },
  deadlineWeeks: 0,
  budget: 0,
};

/** Merges the AI draft into the form; empty or unknown values keep what is already there. */
function mergeDraft(d: RequirementDraft, files: string[], client: Client, req: Requirement): { client: Client; req: Requirement } {
  const pick = <T extends string>(value: T, list: readonly T[], fallback: T) => (list.includes(value) ? value : fallback);
  // Only real pages are pages: header / footer / navigation become shared components,
  // 404 and thank-you pages are supporting pages (included in the set-up, not billed).
  const pageList = d.pages.filter((p) => p.name.trim()).slice(0, 60);
  const split = splitPages([...pageList.map((p) => p.name), ...(d.supportingPages ?? [])]);
  const pages = split.pages;
  const supporting = new Set((d.supportingPages ?? []).map((p) => p.trim().toLowerCase()));
  const pageDetails: Requirement["pageDetails"] = {};
  for (const name of pages) {
    const p = pageList.find((x) => x.name.trim() === name);
    const kind = supporting.has(name.toLowerCase()) ? "supporting" : defaultPageKind(name);
    pageDetails[name] = {
      sections: Math.max(1, Math.min(30, Math.round(p?.sections ?? 1) || 3)),
      purpose: (p?.purpose ?? "").trim().slice(0, 200),
      ...(kind === "supporting" ? { kind } : {}),
    };
  }
  const modules = d.modules.filter((m) => MODULES.includes(m));
  const source = files.length ? `From client documents: ${files.join(", ")}` : "";
  const merged: Requirement = {
    ...req,
    title: d.title || req.title,
    summary: d.summary || req.summary,
    scope: pick(d.scope, SCOPES, req.scope),
    existingProject: d.existingProject || req.existingProject,
    projectType: pick(d.projectType, PROJECT_TYPES, req.projectType),
    complexity: pick(d.complexity, COMPLEXITIES, req.complexity),
    pages: pages.length ? pages : req.pages,
    pageDetails: pages.length ? pageDetails : req.pageDetails,
    modules,
    mustHave: d.mustHave.filter((m) => modules.includes(m)),
    deferredModules: [],
    sharedComponents: [...new Set([...(d.sharedComponents ?? []), ...split.components])].slice(0, 20),
    qualityRequirements: (d.qualityRequirements ?? []).slice(0, 20),
    externalServices: (d.externalServices ?? []).slice(0, 20),
    seoKeywords: d.seoKeywords.slice(0, 12),
    // Technology the client named is kept exactly as stated; it is never replaced silently.
    clientTech: parseClientTech(d.technologyPreference) ?? req.clientTech,
    insights: mergeInsights(d, req.insights),
    design: pick(d.design, DESIGN_SOURCES, req.design),
    references: [d.references, source].filter(Boolean).join("\n"),
    // The client already owns a named domain unless they asked us to register it.
    domain: {
      ...req.domain,
      choice: d.needsDomain ? "arrange" : d.domainName ? "owned" : "self",
      needed: d.needsDomain,
      name: d.domainName.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 63) || req.domain.name,
    },
    hosting: { ...req.hosting, choice: d.needsHosting ? "arrange" : "self", needed: d.needsHosting },
    deadlineWeeks: Math.max(0, Math.min(104, Math.round(d.deadlineWeeks) || 0)),
    // A budget the team typed is the latest word from the client; the document only fills an empty field.
    budget: req.budget && req.budget > 0 ? req.budget : d.clientBudget > 0 ? Math.round(d.clientBudget) : req.budget,
  };
  return {
    // Contact details found in the document are kept for the client step.
    client: {
      ...client,
      name: d.client.name || client.name,
      email: d.client.email || client.email,
      phone: d.client.phone || client.phone,
      company: d.client.company || client.company,
      state: INDIAN_STATES.includes(d.client.state) ? d.client.state : client.state,
    },
    req: merged,
  };
}

/** The title and requirement are no longer typed by hand; fill them from the client and pages when the document did not. */
function withTitleAndSummary(req: Requirement, client: Client): Requirement {
  const who = client.company.trim() || client.name.trim() || "Client";
  const title = req.title.trim() || `${who} website`;
  const parts = [...req.pages, ...req.modules.map(String)].filter(Boolean);
  const summary = req.summary.trim().length >= 20 ? req.summary : `${title}. Scope: ${parts.join(", ") || "as discussed with the client"}.`;
  return { ...req, title, summary };
}

/** Quick per-step checks so the user sees problems before the server does. */
function stepError(step: number, client: Client, req: Requirement): string {
  if (step === 0) {
    if ((req.scope === "module" || req.scope === "version") && !req.existingProject.trim()) return "Name the existing project.";
  }
  if (step === 1) {
    if (req.scope !== "module" && billablePages(req).length === 0) return "Add at least one page (supporting pages such as 404 are not enough).";
    if (req.scope === "module" && req.modules.length === 0 && req.pages.length === 0) return "Pick at least one module or page.";
  }
  if (step === 3) {
    if (!client.name.trim()) return "Enter the client's name.";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(client.email.trim())) return "Enter a valid email.";
    if (!/^[+0-9 ()-]{7,20}$/.test(client.phone.trim())) return "Enter a valid phone number.";
    if (client.gstin && !/^[0-9]{2}[A-Z0-9]{13}$/.test(client.gstin)) return "GSTIN must be 15 characters, e.g. 33ABCDE1234F1Z5.";
  }
  return "";
}

export type ClientRequest = { leadId: string; token: string; quotationNumber: string | null };

/**
 * The fixed-price requirement form. `mode="studio"` (the default) is the studio's own form, exactly as before. `mode="client"` is the same form for a client's own request:
 * it talks to the client's doors (/api/workspace/fixed-price/*), is prefilled with the client's name and email, and leaves out everything that is the studio's business:
 * the cost, profit and running-cost panel, the market-rate basis, the technology recommendations (the client chooses technology on their quotation page) and the
 * cost of reading their document. The server prices the quotation either way.
 */
export function RequirementWizard({ onCreated, onCancel, mode = "studio", defaults, onClientCreated, initialBrief = "" }: { onCreated: (lead: Lead) => void; onCancel: () => void; mode?: "studio" | "client"; defaults?: Partial<Client>; onClientCreated?: (r: ClientRequest) => void; initialBrief?: string }) {
  const isClient = mode === "client";
  const apiBase = isClient ? "/api/workspace/fixed-price" : "/api/business";
  const [rates, setRates] = useState<RateCard | null>(null);
  const [catalog, setCatalog] = useState<TechEntry[] | null>(null);
  const [costConfig, setCostConfig] = useState<CostConfig | null>(null);
  const [existing, setExisting] = useState<string[]>([]);
  const [step, setStep] = useState(0);
  const [client, setClient] = useState<Client>(() => ({ ...emptyClient, ...(defaults ?? {}) }));
  // What the client typed on the front page, if anything: it is the summary until a document is analysed, and the notes the analysis starts from.
  const [req, setReq] = useState<Requirement>(() => (initialBrief.trim() ? { ...emptyRequirement, summary: initialBrief.trim() } : emptyRequirement));
  const [tier, setTier] = useState<Tier | null>(null);
  const [pageDraft, setPageDraft] = useState("");
  const [pageNote, setPageNote] = useState("");
  const [docBudget, setDocBudget] = useState(0);
  const [beforeFit, setBeforeFit] = useState<Pick<Requirement, "pages" | "modules"> & { mustHave: ModuleId[]; deferredModules: ModuleId[]; deferredPages: string[] } | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [techOpen, setTechOpen] = useState(false);
  const [analysis, setAnalysis] = useState<AnalysisOutcome | null>(null);

  useEffect(() => {
    jsonFetch<{ rateCard: RateCard }>(`${apiBase}/rate-card`)
      .then((r) => setRates(r.rateCard))
      .catch((e: Error) => setError(e.message));
    // A client's form needs nothing more: no technology catalog, cost settings or existing projects (those are the studio's).
    if (isClient) return;
    jsonFetch<{ catalog: TechEntry[] }>("/api/business/tech-catalog")
      .then((r) => setCatalog(r.catalog))
      .catch(() => {});
    jsonFetch<{ config: CostConfig }>("/api/business/cost-config")
      .then((r) => setCostConfig(r.config))
      .catch(() => {});
    // Existing generated projects, offered for module / version work.
    fetch("/api/projects")
      .then((r) => r.json())
      .then((r: { projects?: { name: string }[] }) => setExisting((r.projects ?? []).map((p) => p.name)))
      .catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The estimate stays at zero until the document is analysed or the requirement is filled in.
  const started = step > 0 || analysis !== null;
  // Complexity follows the project type and features (the server does the same).
  const [basisChoice, setBasisChoice] = useState<FixedBasisChoice>(null);
  const [basisPreview, setBasisPreview] = useState<{ market: MarketSnapshot; riskBp: number } | null>(null);
  const basisCountry = client.country ?? (client.state === "Outside India" ? "" : "IN");
  const fixedBasis = basisChoice ? { ...basisChoice, ...(basisCountry ? { country: basisCountry } : {}) } : undefined;
  // The preview uses the figure fetched for the screen; the server looks it up again when the quotation is saved.
  const priced = useMemo(() => (rates ? { ...req, complexity: autoComplexity(req, rates), ...(fixedBasis ? { fixedBasis: { ...fixedBasis, ...(basisPreview ?? {}) } } : {}) } : req), [req, rates, fixedBasis?.roleId, fixedBasis?.levelId, fixedBasis?.country, basisPreview]); // eslint-disable-line react-hooks/exhaustive-deps
  const quote: Quote | null = useMemo(() => {
    if (!rates || !started) return null;
    try {
      return buildQuote(priced, client, rates);
    } catch {
      return null;
    }
  }, [priced, client, rates, started]);

  const budget = req.budget ?? 0;
  const proposals = useMemo(() => {
    if (!rates || !quote || priced.pages.length + priced.modules.length === 0) return null;
    try {
      return buildProposals(priced, client, rates);
    } catch {
      return null;
    }
  }, [rates, quote, priced, client]);
  const suggested: Tier = proposals ? defaultTier(proposals, budget) : "standard";
  const shownTier = tier ?? suggested;
  const shown = proposals?.find((p) => p.tier === shownTier) ?? null;
  const estimate = shown?.quote ?? quote;
  const preliminary = estimateStatus(req.insights?.tracker ?? []).level === "preliminary";
  // The quotation's currency: the client's own when they are abroad and a price is set for it, otherwise rupees. Amounts are held in rupees and written in it.
  const money = rates ? quoteMoney(client, rates) : INR_MONEY;
  const fmt = (inr: number) => formatMoney(inr, money);
  const hourlyInr = rates ? (isForeign(money) ? rates.countryPricing![money.code]!.hourlyRate * money.unit : rates.hourlyRate) : 0;
  // Features the client selected that the package being shown does not contain (Basic keeps only the essentials and must-haves, Standard adds the recommended ones),
  // so ticking one does not change that package's price. Said on the screen, with the way to include them.
  const leftOutHere = shown ? req.modules.filter((m) => (shown.requirement.excludedModules ?? []).includes(m)) : [];
  const includedIn = (m: ModuleId) => (proposals ?? []).filter((p) => p.requirement.modules.includes(m)).map((p) => p.title);
  // Budget is compared with the shown package; the price itself is never changed to fit.
  const budgetCheck = useMemo(
    () => (rates && estimate && budget > 0 ? checkBudget(shown?.requirement ?? priced, estimate, client, rates, proposals ?? undefined) : null),
    [rates, estimate, budget, shown, priced, client, proposals],
  );
  const techRecommendation = useMemo(() => {
    if (!catalog || !rates || !shown) return undefined;
    try {
      return recommendTechnology(shown.requirement, budget, catalog, rates, { client }).options[0];
    } catch {
      return undefined;
    }
  }, [catalog, rates, shown, budget]);
  const toPhase2 = (m: ModuleId) => setReq((r) => moveToPhase2(r, m));
  const fromPhase2 = (m: ModuleId) => setReq((r) => restoreFromPhase2(r, m));
  // The client agreed to the scope their budget covers: planned pages stay, the rest wait in Phase 2.
  const applyPlan = () => {
    const plan = budgetCheck?.pagePlan;
    if (!plan || plan.pages.length === 0) return;
    // Remember the scope before the first cut, so switching "Stay within budget" off restores it.
    if (!beforeFit) setBeforeFit({ pages: req.pages, modules: req.modules, mustHave: req.mustHave ?? [], deferredModules: req.deferredModules ?? [], deferredPages: req.deferredPages ?? [] });
    setReq((r) => applyPagePlan(r, plan));
    setTier(null);
  };
  const setStrict = (on: boolean) => {
    if (on) {
      setR("budgetStrict", true);
      return;
    }
    setReq((r) => {
      if (!beforeFit) return { ...r, budgetStrict: false };
      // Pages added since stay; pages moved to Phase 2 for the budget come back.
      const pages = [...beforeFit.pages.filter((p) => r.pages.includes(p) || (r.deferredPages ?? []).includes(p)), ...r.pages.filter((p) => !beforeFit.pages.includes(p))];
      return { ...r, budgetStrict: false, pages, modules: beforeFit.modules, mustHave: beforeFit.mustHave, deferredModules: beforeFit.deferredModules, deferredPages: beforeFit.deferredPages };
    });
    setBeforeFit(null);
    setTier(null);
  };
  const toggleModule = (m: ModuleId) =>
    setReq((r) =>
      r.modules.includes(m)
        ? { ...r, modules: r.modules.filter((x) => x !== m), mustHave: (r.mustHave ?? []).filter((x) => x !== m) }
        : restoreFromPhase2(r, m),
    );
  const setKind = (page: string, kind: PageKind) => setDetail(page, { kind });

  const setDetail = (page: string, patch: Partial<PageDetail>) =>
    setReq((r) => {
      const current = r.pageDetails?.[page] ?? { sections: rates ? sectionsOf(r, page, rates) : 3, purpose: "" };
      return { ...r, pageDetails: { ...(r.pageDetails ?? {}), [page]: { ...current, ...patch } } };
    });
  const setC = <K extends keyof Client>(key: K, value: Client[K]) => setClient((c) => ({ ...c, [key]: value }));
  const setR = <K extends keyof Requirement>(key: K, value: Requirement[K]) => setReq((r) => ({ ...r, [key]: value }));
  const addPage = (name: string) => {
    const page = name.trim();
    setPageDraft("");
    if (!page) return;
    // Header, footer, navigation... are shared components, not pages.
    if (isSharedComponent(page)) {
      if (!(req.sharedComponents ?? []).some((c) => c.toLowerCase() === page.toLowerCase())) setR("sharedComponents", [...(req.sharedComponents ?? []), page]);
      setPageNote(`"${page}" is a shared component (part of every page), so it is included in the set-up and not counted as a page.`);
      return;
    }
    setPageNote("");
    if (!req.pages.some((p) => p.toLowerCase() === page.toLowerCase())) setR("pages", [...req.pages, page]);
  };
  const onPageKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addPage(pageDraft);
    }
  };

  const applyAnalysis = (outcome: AnalysisOutcome) => {
    const merged = mergeDraft(outcome.draft, outcome.files, client, req);
    setClient(merged.client);
    setReq(merged.req);
    setAnalysis(outcome);
    // Tell the team when the document states a different budget from the one they typed.
    const docBudget = Math.round(outcome.draft.clientBudget || 0);
    setDocBudget(docBudget > 0 && docBudget !== merged.req.budget ? docBudget : 0);
    setTier(null);
    setError("");
  };

  /** Checks every step before `target`; stops at the first one with a problem. */
  const goTo = (target: number) => {
    for (let s = 0; s < target; s++) {
      const problem = stepError(s, client, req);
      if (problem) {
        setError(problem);
        setStep(s);
        return false;
      }
    }
    setError("");
    setStep(target);
    return true;
  };
  const openPackage = (t: Tier) => {
    setTier(t);
    goTo(PACKAGE_STEP);
  };
  const next = () => {
    if (step === PACKAGE_STEP && !tier) setTier(suggested);
    goTo(Math.min(step + 1, STEPS.length - 1));
  };

  const submit = async () => {
    setSaving(true);
    setError("");
    try {
      if (isClient) {
        const { request } = await jsonFetch<{ request: ClientRequest }>(`${apiBase}/leads`, {
          method: "POST",
          body: JSON.stringify({ client, requirement: withTitleAndSummary(req, client), tier: shownTier }),
        });
        onClientCreated?.(request);
        return;
      }
      const { lead } = await jsonFetch<{ lead: Lead }>("/api/business/leads", {
        method: "POST",
        body: JSON.stringify({ client, requirement: withTitleAndSummary(fixedBasis ? { ...req, fixedBasis } : req, client), tier: shownTier }),
      });
      onCreated(lead);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (!rates) {
    return (
      <Card className="flex items-center gap-3 text-sm text-slate-400">
        {error ? <span className="text-rose-300">{error}</span> : <><Loader2 size={16} className="animate-spin" /> Loading rate card...</>}
      </Card>
    );
  }

  const optionalPages = optionalPageSuggestions(req);
  const billableCount = billablePages(req).length;

  // Budget question: sits right above the "Analyse & fill the form" button (or at the top once a document is analysed).
  const budgetBlock = (
    <>
      <BudgetInput
        ratesUrl={`${apiBase}/exchange-rates`}
        value={budget}
        onChange={(inr) => setR("budget", Math.max(0, Math.round(inr)))}
        hint="The most the client can pay for development, including GST. We suggest Basic, Standard or Premium from the rupee amount. Leave empty if not known."
      />
      {docBudget > 0 && docBudget !== budget && (
        <p className="-mt-3 flex flex-wrap items-center gap-2 text-[11px] text-amber-200">
          The document says {fmt(docBudget)}; your {fmt(budget)} is used.
          <button type="button" onClick={() => { setR("budget", docBudget); setDocBudget(0); }} className="rounded-md border border-amber-400/40 px-1.5 py-0.5 hover:bg-amber-500/15">
            Use {fmt(docBudget)}
          </button>
        </p>
      )}
      {budget > 0 && (
        <div className="flex items-start justify-between gap-4 rounded-xl border border-white/[.08] bg-white/[.02] px-4 py-3">
          <div>
            <p className="text-sm font-medium text-slate-100">Stay within budget</p>
            <p className="mt-0.5 text-[11px] text-slate-400">
              {req.budgetStrict
                ? `On: we show what ${fmt(budget)} can build. The client's pages and features stay as requested until you click "Use this scope".`
                : "Off: the full scope is priced and compared with the budget. Nothing is moved."}
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={!!req.budgetStrict}
            aria-label="Stay within budget"
            onClick={() => setStrict(!req.budgetStrict)}
            className={cn("relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition", req.budgetStrict ? "bg-emerald-500" : "bg-white/15")}
          >
            <span className={cn("absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all", req.budgetStrict ? "left-[22px]" : "left-0.5")} />
          </button>
        </div>
      )}
    </>
  );

  return (
    <MoneyProvider money={money}>
    <div className="grid gap-6 xl:grid-cols-[1fr_340px]">
      <div className="min-w-0 space-y-5">
        {/* Step indicator */}
        <ol className="flex flex-wrap gap-2">
          {(isClient ? CLIENT_STEPS : STEPS).map((label, i) => (
            <li key={label}>
              <button
                type="button"
                onClick={() => i < step && setStep(i)}
                disabled={i > step}
                className={cn(
                  "flex items-center gap-2 rounded-full border px-3.5 py-2 text-xs font-medium transition",
                  i === step ? "border-violet-400/60 bg-violet-500/20 text-white shadow-[0_0_20px_-4px_rgba(139,92,246,.6)]" : i < step ? "border-white/10 bg-white/[.03] text-slate-300 hover:bg-white/[.07]" : "border-white/[.06] text-slate-600",
                )}
              >
                <span className={cn("flex h-5 w-5 items-center justify-center rounded-full text-[10px]", i < step ? "bg-emerald-500 text-white" : i === step ? "bg-violet-500 text-white" : "bg-white/10")}>
                  {i < step ? <Check size={10} /> : i + 1}
                </span>
                {label}
              </button>
            </li>
          ))}
        </ol>

        <Card className="space-y-5">
          {step === 0 && analysis && budgetBlock}
          {step === 0 && !analysis && <DocumentAnalyzer endpoint={`${apiBase}/analyze`} initialNotes={initialBrief} onDraft={applyAnalysis}>{budgetBlock}</DocumentAnalyzer>}
          {analysis && (step === 0 || step === STEPS.length - 1) && <AnalysisNotes clientMode={isClient} analysis={analysis} insights={req.insights} onClear={() => setAnalysis(null)} />}

          {/* 1. Requirement: what the client wants and the one budget question */}
          {step === 0 && (
            <>
              {(req.scope === "module" || req.scope === "version") && (
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Existing project *" hint="Pick a SILPI project or type any name.">
                    <Input list="silpi-existing" value={req.existingProject} onChange={(e) => setR("existingProject", e.target.value)} />
                    <datalist id="silpi-existing">{existing.map((n) => <option key={n} value={n} />)}</datalist>
                  </Field>
                  {req.scope === "version" && <Field label="New version"><Input value={req.version} onChange={(e) => setR("version", e.target.value)} placeholder="v2.0" /></Field>}
                </div>
              )}
            </>
          )}

          {/* 2. Pages & features */}
          {step === 1 && (
            <>
              <Section
                title="Pages"
                hint={`Each page: ${rates.page.baseHours} h + ${rates.page.sectionHours} h per section at ${fmt(hourlyInr)}/hour, adjusted for complexity. Supporting pages (404, thank-you) and the shared header, footer and navigation are included in the set-up.`}
                aside={
                  <span className="rounded-full border border-violet-400/30 bg-violet-500/10 px-3 py-1 text-xs font-medium text-violet-200">
                    {billableCount} billed{req.pages.length > billableCount ? ` + ${req.pages.length - billableCount} supporting` : ""}
                  </span>
                }
              >
                <div className="space-y-2">
                  {req.pages.map((p) => {
                    const kind = pageKind(req, p);
                    return (
                      <div key={p} className={cn("rounded-xl border border-white/[.07] bg-white/[.025] p-3 transition hover:border-white/[.14]", kind === "supporting" && "opacity-70")}>
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-semibold text-slate-100">{p}</span>
                          <button
                            type="button"
                            onClick={() => setKind(p, kind === "main" ? "supporting" : "main")}
                            title={kind === "main" ? "Billed page. Click to mark as a supporting page (not billed)." : "Supporting page, included in the set-up. Click to bill it as a full page."}
                            className={cn("rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider", kind === "main" ? "bg-violet-500/20 text-violet-200" : "bg-white/[.07] text-slate-400")}
                          >
                            {kind === "main" ? "Billed" : "Supporting"}
                          </button>
                          {isLegalPage(p) && <span className="rounded-full bg-white/[.07] px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-slate-400">Legal</span>}
                          <span className="ml-auto flex items-center gap-2">
                            <label className="flex items-center gap-1.5 text-[11px] text-slate-500">
                              Sections
                              <input
                                type="number"
                                min={1}
                                max={30}
                                value={sectionsOf(req, p, rates)}
                                onChange={(e) => setDetail(p, { sections: Math.max(1, Math.min(30, Math.round(Number(e.target.value)) || 1)) })}
                                className="w-14 rounded-lg border border-white/[.08] bg-white/[.04] px-2 py-1 text-center text-xs text-slate-100 outline-none focus:border-violet-400/60"
                              />
                            </label>
                            <button type="button" aria-label={`Remove ${p}`} onClick={() => setR("pages", req.pages.filter((x) => x !== p))} className="rounded-md p-1 text-slate-500 transition hover:bg-rose-500/10 hover:text-rose-300"><X size={14} /></button>
                          </span>
                        </div>
                        <input
                          value={req.pageDetails?.[p]?.purpose ?? ""}
                          onChange={(e) => setDetail(p, { purpose: e.target.value.slice(0, 200) })}
                          placeholder="What this page shows"
                          className="mt-2 w-full rounded-lg border border-transparent bg-transparent px-0 py-1 text-xs text-slate-400 outline-none placeholder:text-slate-600 focus:border-white/10 focus:bg-white/[.03] focus:px-2"
                        />
                      </div>
                    );
                  })}
                  <div className="flex items-center gap-2 rounded-xl border border-dashed border-white/[.12] px-3 py-2.5 transition focus-within:border-violet-400/50">
                    <Plus size={14} className="text-slate-500" />
                    <input value={pageDraft} onChange={(e) => setPageDraft(e.target.value)} onKeyDown={onPageKey} onBlur={() => addPage(pageDraft)} placeholder="Add a page: type a name and press Enter" className="w-full bg-transparent text-sm outline-none placeholder:text-slate-600" />
                  </div>
                </div>
                {pageNote && <p className="text-[11px] text-sky-200">{pageNote}</p>}
                {(req.deferredPages?.length ?? 0) > 0 && (
                  <div className="space-y-1.5">
                    <p className="text-xs text-slate-400">Phase 2 pages (kept on record, not priced now)</p>
                    <ul className="flex flex-wrap gap-1.5">
                      {req.deferredPages!.map((p) => (
                        <li key={p} className="flex items-center gap-2 rounded-full border border-amber-400/20 bg-amber-500/[.06] px-3 py-1 text-[11px] text-amber-100">
                          {p}
                          <button type="button" onClick={() => setReq((r) => restorePage(r, p))} className="font-medium text-amber-300 hover:text-white">Add back</button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="mr-1 text-[11px] text-slate-500">Quick add</span>
                  {PAGE_SUGGESTIONS.filter((p) => !req.pages.some((x) => x.toLowerCase() === p.toLowerCase())).map((p) => (
                    <button key={p} type="button" onClick={() => addPage(p)} className="flex items-center gap-1 rounded-full border border-white/[.08] bg-white/[.02] px-2.5 py-1 text-[11px] text-slate-300 transition hover:border-violet-400/40 hover:bg-violet-500/10 hover:text-white">
                      <Plus size={11} /> {p}
                    </button>
                  ))}
                  {optionalPages.map((p) => (
                    <button key={p} type="button" title="Add only if the client asks" onClick={() => addPage(p)} className="flex items-center gap-1 rounded-full border border-dashed border-white/[.15] px-2.5 py-1 text-[11px] text-slate-400 transition hover:text-white">
                      <Plus size={11} /> {p} <span className="text-slate-600">· optional</span>
                    </button>
                  ))}
                </div>
                <p className="text-[11px] text-slate-500">
                  Shared components (not pages): {(req.sharedComponents?.length ? req.sharedComponents : ["Header", "Footer", "Navigation"]).join(", ")}.
                </p>
              </Section>

              <Section
                title="Modules & features"
                hint="Only selected features are priced. Optional features can be moved to Phase 2."
                aside={req.modules.length > 0 ? <span className="rounded-full border border-white/10 px-3 py-1 text-xs text-slate-300">{req.modules.length} selected</span> : undefined}
              >
                {leftOutHere.length > 0 && shown && (
                  <div role="status" className="space-y-2 rounded-xl border border-amber-400/30 bg-amber-500/[.07] px-4 py-3 text-xs text-amber-100">
                    <p>
                      <b>{leftOutHere.map((m) => rates.modules[m].label).join(", ")}</b> {leftOutHere.length === 1 ? "is" : "are"} selected, but {leftOutHere.length === 1 ? "it is" : "they are"} <b>not part of the {shown.title} package</b>, so the {shown.title} price does not change.
                      {shown.tier !== "premium" ? " Premium includes everything selected." : ""} To price {leftOutHere.length === 1 ? "it" : "them"} in {shown.title} as well, mark {leftOutHere.length === 1 ? "it" : "them"} as a must-have (a must-have is in every package).
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <button type="button" onClick={() => setR("mustHave", [...new Set([...(req.mustHave ?? []), ...leftOutHere])])} className="rounded-full border border-amber-300/50 px-3 py-1 text-[11px] font-medium text-amber-50 hover:bg-amber-400/10">
                        Make {leftOutHere.length === 1 ? "it" : "them"} must-have: include in {shown.title}
                      </button>
                      {shown.tier !== "premium" && <button type="button" onClick={() => setTier("premium")} className="rounded-full border border-white/20 px-3 py-1 text-[11px] text-slate-200 hover:bg-white/5">Show the Premium price</button>}
                    </div>
                  </div>
                )}
                <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
                  {MODULES.map((m) => (
                    <Choice
                      key={m}
                      active={req.modules.includes(m)}
                      onClick={() => toggleModule(m)}
                      title={`${rates.modules[m].label}${req.deferredModules?.includes(m) ? " · Phase 2" : ""}`}
                      detail={`${rates.modules[m].hours} h · ${rates.modules[m].detail}`}
                    />
                  ))}
                </div>
                {req.modules.length > 0 && (
                  <div className="rounded-xl border border-white/[.07] bg-white/[.02]">
                    <p className="border-b border-white/[.06] px-4 py-2.5 text-xs text-slate-400">
                      Must-have features stay in every package and never move to Phase 2. Basic keeps only what the site cannot work without.
                    </p>
                    <ul className="divide-y divide-white/[.05]">
                      {req.modules.map((m) => {
                        const must = req.mustHave?.includes(m) ?? false;
                        return (
                          <li key={m} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-xs">
                            <span className="text-slate-200">
                              {rates.modules[m].label} <span className="text-slate-500">· {rates.modules[m].hours} h</span>
                              {shown && (shown.requirement.excludedModules ?? []).includes(m) && <span className="ml-2 rounded-full border border-amber-400/40 px-2 py-0.5 text-[10px] text-amber-200">not in {shown.title}{includedIn(m).length ? ` · in ${includedIn(m).join(", ")}` : ""}</span>}
                            </span>
                            <span className="flex items-center gap-2">
                              <button
                                type="button"
                                aria-pressed={must}
                                onClick={() => setR("mustHave", must ? (req.mustHave ?? []).filter((x) => x !== m) : [...(req.mustHave ?? []), m])}
                                className={cn("flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] transition", must ? "border-amber-400/50 bg-amber-500/10 text-amber-100" : "border-white/[.08] text-slate-400 hover:text-white")}
                              >
                                <Star size={11} className={must ? "fill-amber-300 text-amber-300" : ""} /> {must ? "Must-have" : "Optional"}
                              </button>
                              {!must && (
                                <button type="button" onClick={() => toPhase2(m)} className="rounded-full border border-white/[.1] px-2.5 py-1 text-[11px] text-slate-300 transition hover:bg-white/5">Move to Phase 2</button>
                              )}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                )}
                {(req.deferredModules?.length ?? 0) > 0 && (
                  <div className="space-y-1.5">
                    <p className="text-xs text-slate-400">Phase 2 features (kept on record, not priced now)</p>
                    <ul className="flex flex-wrap gap-1.5">
                      {req.deferredModules!.map((m) => (
                        <li key={m} className="flex items-center gap-2 rounded-full border border-amber-400/20 bg-amber-500/[.06] px-3 py-1 text-[11px] text-amber-100">
                          {rates.modules[m]?.label ?? m}
                          <button type="button" onClick={() => fromPhase2(m)} className="font-medium text-amber-300 hover:text-white">Add back</button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </Section>

              <Section title="Design">
                <div className="grid gap-2.5 sm:grid-cols-3">
                  {DESIGN_SOURCES.map((d) => (
                    <Choice key={d} active={req.design === d} onClick={() => setR("design", d)} title={rates.design[d].label} detail={rates.design[d].hours ? `${rates.design[d].hours} h · ${rates.design[d].detail}` : rates.design[d].detail} />
                  ))}
                </div>
              </Section>

              <details className="group rounded-xl border border-white/[.08] bg-white/[.02] px-4 py-3 open:bg-white/[.03]" open={Object.keys(req.tech ?? {}).length > 0}>
                <summary className="flex cursor-pointer list-none items-center justify-between text-sm font-medium text-slate-100">
                  <span>Technology <span className="text-xs font-normal text-slate-500">(optional, for technical clients)</span></span>
                  <span className="text-xs text-slate-500 transition group-open:rotate-90">▸</span>
                </summary>
                <p className="mt-2 text-[11px] text-slate-400">
                  Leave every choice on &quot;SILPI chooses&quot; if the client does not mind. A different technology changes the development hours, and the estimate updates straight away.
                  {!needsBackend(req, rates) && " This site needs no backend or database, so only the frontend matters."}
                </p>
                <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  {(["frontend", "backend", "database", "styling"] as const).map((layer) => {
                    const backendLayer = layer === "backend" || layer === "database";
                    const off = backendLayer && !needsBackend(req, rates);
                    const options = Object.entries(rates.technology?.[layer] ?? {}).filter(([id, o]) => (o.available || req.tech?.[layer] === id) && (layer !== "styling" || stylingFits(rates, req.tech?.frontend, id)));
                    const current = req.tech?.[layer] ? rates.technology[layer][req.tech[layer]!] : undefined;
                    return (
                      <Field key={layer} label={layer === "frontend" ? "Frontend" : layer === "backend" ? "Backend" : layer === "database" ? "Database" : "Styling / UI library"} hint={current?.detail}>
                        <Select
                          value={req.tech?.[layer] ?? ""}
                          disabled={off}
                          onChange={(e) => {
                            const next = { ...(req.tech ?? {}) };
                            if (e.target.value) next[layer] = e.target.value;
                            else delete next[layer];
                            // A UI library that does not work with the new frontend is dropped.
                            if (layer === "frontend" && next.styling && !stylingFits(rates, next.frontend, next.styling)) delete next.styling;
                            setR("tech", next);
                          }}
                        >
                          <option value="">{off ? "Not needed" : "SILPI chooses"}</option>
                          {options.map(([id, o]) => <option key={id} value={id}>{o.label}{o.factor !== 1 ? ` (${o.factor > 1 ? "+" : ""}${Math.round((o.factor - 1) * 100)}% hours)` : ""}</option>)}
                        </Select>
                      </Field>
                    );
                  })}
                </div>
              </details>

              <Section title="References" hint="Sites the client likes, brand colours, logo notes.">
                <Textarea value={req.references} onChange={(e) => setR("references", e.target.value)} className="min-h-24" />
              </Section>
            </>
          )}

          {/* 3. Package details: compare and finalise */}
          {step === PACKAGE_STEP && (
            proposals ? (
              <>
                {((req.deferredPages?.length ?? 0) > 0 || (req.deferredModules?.length ?? 0) > 0) && (
                  <div className="rounded-lg border border-amber-400/40 bg-amber-500/10 p-3 text-xs text-amber-100">
                    <p className="font-semibold">Phase 2: not in this quotation</p>
                    <p className="mt-1 text-slate-200">
                      {[...(req.deferredPages ?? []).map((p) => `${p} page`), ...(req.deferredModules ?? []).map((m) => rates.modules[m]?.label ?? m)].join(", ")}.
                    </p>
                    <p className="mt-1 text-slate-300">These were requested but are left out of the prices below. They stay on record and can be added back.</p>
                  </div>
                )}
                {budgetCheck && <BudgetSummary check={budgetCheck} onMoveToPhase2={toPhase2} onApplyPlan={applyPlan} onChangeDesign={(x) => setR("design", x)} />}
                {!isClient && (<>
                <TechnologyRecommendations
                  client={client}
                  requirement={priced}
                  budget={budget}
                  rates={rates}
                  catalog={catalog}
                  onUse={(ids) => setReq((r) => { const { tech: _t, ...rest } = r; return { ...rest, selectedStack: { ids } }; })}
                  onConfirm={(ids) => setReq((r) => (r.clientTech ? { ...r, clientTech: { ...r.clientTech, confirmedIds: ids } } : r))}
                  onUndo={() => setReq((r) => (r.clientTech ? { ...r, clientTech: { stated: r.clientTech.stated, ids: r.clientTech.ids } } : r))}
                  onClearSelection={() => setReq((r) => { const { selectedStack: _s, ...rest } = r; return rest; })}
                  onChooseTech={() => setTechOpen(true)}
                  techChosen={Object.keys(req.tech ?? {}).length > 0}
                />
                {techOpen && (
                  <TechnologyChooser
                    local={{ requirement: priced, client, rates }}
                    tier={shownTier}
                    value={null}
                    intro="Choose the frontend, backend and database. Each option shows how it changes the price compared with the current estimate; the estimate on the right updates when you apply it."
                    applyLabel="Use this technology"
                    onClose={() => setTechOpen(false)}
                    onApply={(tech) => { setReq((r) => applyClientTech(r, tech, rates)); setTechOpen(false); }}
                  />
                )}
                </>)}
                <PackageDetails proposals={proposals} rates={rates} selected={shownTier} suggested={suggested} budget={budget} onSelect={setTier} />
              </>
            ) : (
              <p className="text-sm text-slate-400">Add pages or features to see the packages.</p>
            )
          )}

          {/* 4. Client details, deadline and the optional services */}
          {step === 3 && (
            <>
              {shown && (
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-violet-400/30 bg-gradient-to-r from-violet-500/20 to-indigo-500/[.06] px-5 py-4 text-sm">
                  <span>
                    <span className="font-semibold text-white">{shown.title} package</span>
                    <span className="block text-xs text-slate-400">{shown.pages.length} pages · {shown.requirement.modules.length} features · {shown.quote.totalHours} h · about {shown.estimatedWeeks} weeks</span>
                  </span>
                  <span className="flex items-center gap-3">
                    <span className="text-lg font-semibold tabular-nums text-white">{fmt(shown.grandTotal)}</span>
                    <button type="button" onClick={() => setStep(PACKAGE_STEP)} className="text-xs text-violet-300 hover:text-white">Change</button>
                  </span>
                </div>
              )}
              <Section title={isClient ? "Your details" : "Client details"} hint="Used on the quotation. The state decides CGST + SGST or IGST.">
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label={isClient ? "Your name *" : "Client name *"}><Input value={client.name} onChange={(e) => setC("name", e.target.value)} placeholder="Full name" /></Field>
                  <Field label="Company"><Input value={client.company} onChange={(e) => setC("company", e.target.value)} placeholder="Business name (optional)" /></Field>
                  <Field label="Email *"><Input type="email" value={client.email} onChange={(e) => setC("email", e.target.value)} placeholder="client@example.com" /></Field>
                  <Field label="Phone *"><Input value={client.phone} onChange={(e) => setC("phone", e.target.value)} placeholder="+91 98765 43210" /></Field>
                  <Field label="State *" hint="Decides CGST + SGST (same state) or IGST (other state).">
                    <Select value={client.state} onChange={(e) => setClient((c) => ({ ...c, state: e.target.value, ...(e.target.value === "Outside India" ? {} : { currency: undefined, country: undefined }) }))}>
                      {INDIAN_STATES.map((s) => <option key={s}>{s}</option>)}
                    </Select>
                  </Field>
                  {client.state === "Outside India" && (
                    <Field label="Client country" hint="Only countries whose currency you have set a price for are listed.">
                      <Select value={client.country ?? ""} onChange={(e) => setClient((c) => ({ ...c, country: e.target.value || undefined, currency: e.target.value ? currencyOfCountry(e.target.value) ?? c.currency : c.currency }))}>
                        <option value="">Not chosen</option>
                        {COUNTRIES.filter((k) => k.code !== "IN" && rates?.countryPricing?.[k.currency]).map((k) => <option key={k.code} value={k.code}>{flagOf(k.code)} {k.name} ({k.currency})</option>)}
                      </Select>
                    </Field>
                  )}
                  {client.state === "Outside India" && (
                    <Field label="Quote in" hint={Object.keys(rates?.countryPricing ?? {}).length ? "The price is hours x your hourly price for that currency. No Indian GST on a client abroad." : "No prices are set for other currencies yet: add them in Business & pricing."}>
                      <Select value={client.currency ?? "INR"} onChange={(e) => setC("currency", e.target.value === "INR" ? undefined : e.target.value)}>
                        <option value="INR">Indian rupees (₹)</option>
                        {Object.keys(rates?.countryPricing ?? {}).map((c) => <option key={c} value={c}>{currencyOf(c).name} ({symbolOf(c)})</option>)}
                      </Select>
                    </Field>
                  )}
                  {!isClient && <FixedBasisPicker country={basisCountry} choice={basisChoice} onChoice={setBasisChoice} onPreview={setBasisPreview} />}
                  <Field label="GSTIN" hint="Optional, for business clients."><Input value={client.gstin} onChange={(e) => setC("gstin", e.target.value.toUpperCase())} placeholder="33ABCDE1234F1Z5" maxLength={15} /></Field>
                  <Field label="Billing address" className="sm:col-span-2"><Textarea value={client.address} onChange={(e) => setC("address", e.target.value)} className="min-h-16" /></Field>
                  <Field label="Client deadline (weeks)" hint={shown ? `This package needs about ${shown.estimatedWeeks} weeks. 0 = no fixed deadline.` : "0 = no fixed deadline."}>
                    <Input type="number" min={0} value={req.deadlineWeeks} onChange={(e) => setR("deadlineWeeks", Math.max(0, Number(e.target.value) || 0))} />
                  </Field>
                </div>
                {shown && req.deadlineWeeks > 0 && req.deadlineWeeks < shown.estimatedWeeks && (
                  <p className="mt-2 text-xs text-amber-300">The deadline is shorter than the {shown.estimatedWeeks} weeks this package needs. {isClient ? "We will confirm a realistic date with you." : "Agree the date with the client."}</p>
                )}
              </Section>
            </>
          )}

          {/* 5. Review: everything, including every page name */}
          {step === 4 && shown && (
            <div className="space-y-5 text-sm">
              {!isClient && <details className="rounded-xl border border-amber-400/20 bg-amber-500/[.03] p-4" open>
                <summary className="cursor-pointer text-xs font-semibold text-amber-100">Costs, profitability and running costs <span className="font-normal text-amber-200/70">(internal view, never shown to the client)</span></summary>
                <div className="mt-3">
                  <WizardCostPanel
                    quote={shown.quote}
                    requirement={shown.requirement}
                    rates={rates}
                    config={costConfig}
                    recommendation={techRecommendation}
                    onConfigure={() => window.open("/pricing", "_blank")}
                  />
                </div>
              </details>}
              <div className="grid gap-4 sm:grid-cols-2">
                <ReviewBlock title="Client">
                  <p className="text-slate-200">{client.name}{client.company ? ` · ${client.company}` : ""}</p>
                  <p>{client.email} · {client.phone}</p>
                  <p>{client.state}{client.gstin ? ` · GSTIN ${client.gstin}` : ""}</p>
                  {client.address && <p className="whitespace-pre-line">{client.address}</p>}
                </ReviewBlock>
                <ReviewBlock title="Project">
                  <p className="text-slate-200">{req.title}</p>
                  <p>{rates.projectTypes[req.projectType].label} · {SCOPE_OPTIONS.find((s) => s.id === req.scope)?.title}</p>
                  <p>Deadline: {req.deadlineWeeks > 0 ? `${req.deadlineWeeks} weeks` : "none fixed"} · needs about {shown.estimatedWeeks} weeks</p>
                  {budget > 0 && <p>Client budget: {fmt(budget)}</p>}
                </ReviewBlock>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-violet-400/30 bg-gradient-to-r from-violet-500/20 to-indigo-500/[.06] px-5 py-4">
                <span>
                  <span className="font-semibold text-white">{shown.title} package</span>
                  <span className="block text-xs text-slate-400">{shown.quote.totalHours} h · about {shown.estimatedWeeks} weeks{shown.terms ? ` · ${shown.terms.revisions} revisions · ${shown.terms.supportDays} days support` : ""}</span>
                </span>
                <span className="text-lg font-semibold tabular-nums text-white">{fmt(shown.grandTotal)}</span>
              </div>

              <ReviewBlock title={`All pages: ${shown.pages.length} billed${shown.supportingPages?.length ? ` + ${shown.supportingPages.length} supporting` : ""}`}>
                <ol className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
                  {shown.pages.map((p, i) => (
                    <li key={p} className="flex items-center justify-between gap-2">
                      <span className="flex items-center gap-2 text-slate-200">
                        <span className="w-5 text-right text-[11px] text-slate-500">{i + 1}.</span> {p}
                        {isLegalPage(p) && <ShieldCheck size={12} className="text-emerald-300" aria-label="Legal page" />}
                      </span>
                      <span className="text-[11px] text-slate-500">{sectionsOf(shown.requirement, p, rates)} sections</span>
                    </li>
                  ))}
                  {(shown.supportingPages ?? []).map((p) => (
                    <li key={p} className="flex items-center justify-between gap-2 text-slate-400">
                      <span className="flex items-center gap-2"><span className="w-5" /> {p}</span>
                      <span className="text-[11px]">supporting, not billed</span>
                    </li>
                  ))}
                </ol>
              </ReviewBlock>

              <ReviewBlock title="Project scope">
                <ScopeSummary requirement={shown.requirement} rates={rates} />
              </ReviewBlock>

              {budgetCheck && <BudgetSummary check={budgetCheck} onMoveToPhase2={toPhase2} onApplyPlan={applyPlan} onChangeDesign={(x) => setR("design", x)} />}


              <ReviewBlock title="Technology & SEO">
                <p>{shown.quote.stack.frontend} · {shown.quote.stack.backend} · {shown.quote.stack.database} · {shown.quote.stack.styling}</p>
                {shown.quote.seo.keywords.length > 0 && <p className="mt-1">Keywords: {shown.quote.seo.keywords.join(", ")}</p>}
              </ReviewBlock>

              <p className="text-xs text-slate-500">{isClient ? `Saving creates your quotation with the ${shown.title} package selected, and all three packages to compare. You will approve it on the next page: nothing is charged until you approve it and pay the advance.` : `Saving creates the quotation with the ${shown.title} package selected and all three packages for the client to compare. You can still change the package, add a discount or share it afterwards.`}</p>
            </div>
          )}

          {/* Package choice, before the package details page: click one to see its details. */}
          {proposals && step < PACKAGE_STEP && (
            <div className="space-y-3 border-t border-white/[.06] pt-6">
              <h3 className="text-[15px] font-semibold tracking-tight text-slate-100">Choose a package</h3>
              <div className="grid gap-3 sm:grid-cols-3">
                {proposals.map((p) => {
                  const active = p.tier === shownTier;
                  return (
                    <button
                      key={p.tier}
                      type="button"
                      onClick={() => openPackage(p.tier)}
                      className={cn(
                        "flex flex-col gap-1 rounded-2xl border px-4 py-3.5 text-left text-xs transition hover:-translate-y-0.5",
                        active ? "border-violet-400/60 bg-gradient-to-b from-violet-500/20 to-violet-500/[.06] shadow-[0_0_24px_-8px_rgba(139,92,246,.7)]" : "border-white/[.08] bg-white/[.03] hover:border-white/20",
                      )}
                    >
                      <span className="flex items-center justify-between gap-2">
                        <span className="text-sm font-semibold text-slate-100">{p.title}</span>
                        {p.tier === suggested && <span className="flex items-center gap-0.5 rounded-full bg-emerald-500/20 px-1.5 text-[9px] font-semibold text-emerald-300"><Sparkles size={9} /> suggested</span>}
                      </span>
                      <span className={cn("mt-1 text-xl font-semibold tracking-tight tabular-nums", budget > 0 ? (p.grandTotal <= budget ? "text-emerald-300" : "text-rose-300") : "text-white")}>{fmt(p.grandTotal)}</span>
                      <span className="text-[11px] text-slate-500">{p.pages.length} page{p.pages.length === 1 ? "" : "s"} · {p.requirement.modules.length} features · {p.estimatedWeeks} wk</span>
                      <span className="mt-1 flex items-center gap-1 text-[11px] text-violet-300">See details <ArrowRight size={11} /></span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {error && <p className="rounded-lg border border-rose-400/20 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">{error}</p>}

          <div className="flex flex-wrap justify-between gap-3 border-t border-white/[.06] pt-4">
            <button type="button" onClick={step === 0 ? onCancel : () => { setError(""); setStep(step - 1); }} className="flex items-center gap-2 rounded-xl px-3 py-2.5 text-sm text-slate-400 transition hover:bg-white/5 hover:text-white">
              <ArrowLeft size={15} /> {step === 0 ? "Cancel" : "Back"}
            </button>
            {step < STEPS.length - 1 ? (
              <button type="button" onClick={next} disabled={step === PACKAGE_STEP && !proposals} className="flex items-center gap-2 rounded-xl bg-gradient-to-r from-violet-500 to-indigo-500 px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-violet-500/25 transition hover:brightness-110 disabled:opacity-50">
                {step === PACKAGE_STEP ? <>Finalise {shown?.title ?? ""} package <Check size={15} /></> : step === 1 ? <>See packages <ArrowRight size={15} /></> : <>Next <ArrowRight size={15} /></>}
              </button>
            ) : (
              <button type="button" onClick={submit} disabled={saving} className="flex items-center gap-2 rounded-xl bg-gradient-to-r from-violet-500 to-indigo-500 px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-violet-500/25 transition hover:brightness-110 disabled:opacity-60">
                {saving ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} {isClient ? "Get my quotation" : "Save & create quotation"}
              </button>
            )}
          </div>
        </Card>
      </div>

      {/* Live estimate */}
      <aside className="xl:sticky xl:top-24 xl:self-start">
        <Card className="overflow-hidden p-0">
          <div className="bg-gradient-to-br from-violet-600/30 via-indigo-600/15 to-transparent px-6 pb-5 pt-6">
            <p className="flex items-center justify-between text-[11px] font-semibold uppercase tracking-[.15em] text-slate-400">
              <span>Estimate</span>
              {shown && <span className="rounded-full bg-violet-500/20 px-2.5 py-0.5 normal-case tracking-normal text-violet-200">{shown.title}</span>}
            </p>
            <p className="mt-3 text-[34px] font-semibold leading-none tracking-tight tabular-nums text-white">{fmt(estimate ? estimate.grandTotal : 0)}</p>
            <p className="mt-1.5 text-xs text-slate-400">Grand total incl. GST</p>
            {preliminary && <p data-testid="wizard-preliminary" className="mt-2 inline-block rounded-full bg-amber-500/20 px-2.5 py-0.5 text-[11px] text-amber-100">Preliminary estimate: open questions or approvals remain</p>}
          </div>
          <div className="px-6 pb-6 pt-4">
          {estimate ? (
            <div className="space-y-4 text-slate-300">
              <dl className="space-y-1.5 text-[13px]">
                <div className="flex justify-between gap-4"><dt className="text-slate-400">Development subtotal</dt><dd className="tabular-nums text-slate-100">{fmt(estimate.subtotal)}</dd></div>
                {estimate.discount > 0 && <div className="flex justify-between gap-4"><dt className="text-slate-400">Discount</dt><dd className="tabular-nums text-emerald-300">-{fmt(estimate.discount)}</dd></div>}
                <div className="flex justify-between gap-4"><dt className="text-slate-400">Taxable value</dt><dd className="tabular-nums text-slate-100">{fmt(estimate.taxable)}</dd></div>
                {estimate.gst.mode === "intra" && (
                  <>
                    <div className="flex justify-between gap-4"><dt className="text-slate-400">CGST @ {estimate.gst.rate / 2}%</dt><dd className="tabular-nums">{fmt(estimate.gst.cgst)}</dd></div>
                    <div className="flex justify-between gap-4"><dt className="text-slate-400">SGST @ {estimate.gst.rate / 2}%</dt><dd className="tabular-nums">{fmt(estimate.gst.sgst)}</dd></div>
                  </>
                )}
                {estimate.gst.mode === "inter" && <div className="flex justify-between gap-4"><dt className="text-slate-400">IGST @ {estimate.gst.rate}%</dt><dd className="tabular-nums">{fmt(estimate.gst.igst)}</dd></div>}
                {estimate.gst.mode === "export" && <p className="text-xs text-slate-500">GST: export of services (zero-rated, under LUT)</p>}
                {estimate.roundOff !== 0 && <div className="flex justify-between gap-4"><dt className="text-slate-400">Round off</dt><dd className="tabular-nums">{fmt(estimate.roundOff)}</dd></div>}
              </dl>
              <div className="grid grid-cols-2 gap-2">
                {estimate.schedule.map((s) => (
                  <div key={s.label} className="rounded-xl border border-white/[.06] bg-white/[.03] px-3 py-2">
                    <p className="text-[10px] uppercase tracking-wider text-slate-500">{s.percent}% {s.label.split(" - ")[0].toLowerCase()}</p>
                    <p className="mt-0.5 text-sm font-semibold tabular-nums text-slate-100">{fmt(s.amount)}</p>
                  </div>
                ))}
              </div>
              <div className="flex flex-wrap gap-1.5 text-[11px]">
                {estimate.pageCount && <span className="rounded-full bg-white/[.06] px-2.5 py-1 text-slate-300">{estimate.pageCount.billable} page{estimate.pageCount.billable === 1 ? "" : "s"}{estimate.pageCount.supporting ? ` + ${estimate.pageCount.supporting} supporting` : ""}</span>}
                <span className="rounded-full bg-white/[.06] px-2.5 py-1 text-slate-300">{estimate.totalHours} dev hours</span>
                <span className="rounded-full bg-white/[.06] px-2.5 py-1 text-slate-300">about {estimate.estimatedWeeks} week{estimate.estimatedWeeks === 1 ? "" : "s"}</span>
              </div>
              <div className="space-y-1 rounded-xl border border-dashed border-white/10 px-3 py-2.5 text-xs text-slate-400">
                <div className="flex justify-between gap-3"><span>Domain name</span><span className="text-slate-500">Not included</span></div>
                <div className="flex justify-between gap-3"><span>Hosting</span><span className="text-slate-500">Not included</span></div>
                <p className="pt-1 text-[11px] text-slate-500">Bought separately from a domain and hosting provider of the client's choice.</p>
              </div>
              {estimate.deferred && <p className="text-[11px] text-amber-200/80">Phase 2 (not priced): {estimate.deferred.modules.join(", ")}</p>}
            </div>
          ) : (
            <div className="space-y-1 text-sm text-slate-500">
              <div className="flex justify-between"><span>Subtotal</span><span className="tabular-nums">{fmt(0)}</span></div>
              <div className="flex justify-between"><span>GST</span><span className="tabular-nums">{fmt(0)}</span></div>
              <div className="space-y-0.5 pt-2 text-xs">
                <div className="flex justify-between gap-3"><span>Domain name</span><span>Not included</span></div>
                <div className="flex justify-between gap-3"><span>Hosting</span><span>Not included</span></div>
                <p className="pt-1 text-[11px] text-slate-500">Bought separately from a domain and hosting provider of the client's choice.</p>
              </div>
              <p className="pt-2 text-xs">The estimate appears after the document is analysed or the requirement is filled in.</p>
            </div>
          )}
          {budgetCheck && (
            <div className="mt-4">
              <BudgetSummary check={budgetCheck} onMoveToPhase2={toPhase2} onApplyPlan={applyPlan} onChangeDesign={(x) => setR("design", x)} compact />
            </div>
          )}
          </div>
        </Card>
        {estimate && rates && (
          <details className="group mt-4 rounded-2xl border border-white/[.07] bg-white/[.025]" data-testid="wizard-breakdown">
            <summary className="flex cursor-pointer list-none items-center justify-between px-5 py-3 text-xs font-semibold text-slate-200 [&::-webkit-details-marker]:hidden">
              How this estimate is calculated
              <span className="text-[11px] font-normal text-slate-500 group-open:hidden">show</span>
            </summary>
            <div className="border-t border-white/[.05] px-5 py-4">
              <EstimateBreakdown quote={estimate} basis={estimateBasis(shown?.requirement ?? priced, rates)} compact />
            </div>
          </details>
        )}
      </aside>
    </div>
    </MoneyProvider>
  );
}

function ReviewBlock({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-white/[.07] bg-white/[.025] p-5 text-xs leading-5 text-slate-400">
      <p className="mb-3 text-[11px] font-semibold uppercase tracking-[.15em] text-violet-300/80">{title}</p>
      {children}
    </section>
  );
}

/** What the AI could not tell from the document: ask the client before sending the quotation. */
function AnalysisNotes({ analysis, insights, onClear, clientMode = false }: { analysis: AnalysisOutcome; insights?: RequirementInsights; onClear: () => void; clientMode?: boolean }) {
  return (
    <div className="rounded-xl border border-amber-400/20 bg-amber-500/[.06] p-4 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 font-semibold text-amber-200">
          <AlertTriangle size={14} /> Filled from {analysis.files.length ? analysis.files.join(", ") : "your notes"}. Check every field.
        </p>
        <button type="button" onClick={onClear} className="text-[11px] text-slate-400 hover:text-white">Analyse another document</button>
      </div>
      {insights && <div className="mt-3"><ClarificationSummary insights={insights} documents={analysis.files} /></div>}
      {analysis.files.some((f) => /.(png|jpe?g|webp|gif)$/i.test(f)) && (
        <p className="mt-3 rounded-lg border border-sky-400/25 bg-sky-500/10 px-3 py-2 text-[11px] leading-5 text-sky-100" data-testid="design-note">
          You gave pictures. They were read as the requirement only; they are <b>not</b> saved as a design. If the website must look like a design, upload it again after the client approves, under Client files, Design, Design reference.
        </p>
      )}
      {analysis.cached ? (
        <p className="mt-2 text-[11px] text-emerald-300" data-testid="analysis-cached">This document was analysed before. The saved result is used, so the estimate is the same as last time (no cost).</p>
      ) : clientMode ? null : (
        <p className="mt-2 text-[11px] text-slate-500">Analysis cost: ${analysis.costUsd.toFixed(4)} USD ({analysis.model}){analysis.runs && analysis.runs > 1 ? ` · agreement of ${analysis.runs} readings` : ""}{analysis.partial ? " · only some readings finished, so this result was not saved" : ""}</p>
      )}
    </div>
  );
}
