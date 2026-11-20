"use client";

import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { AlertTriangle, ArrowLeft, ArrowRight, Check, CheckCircle2, HelpCircle, Loader2, Plus, ShieldCheck, Sparkles, Star, X } from "lucide-react";

import { buildQuote, formatINR, needsBackend, sectionsOf } from "@/lib/business/pricing";
import { checkBudget } from "@/lib/business/budget";
import { buildProposals, defaultTier } from "@/lib/business/proposals";
import type { TechEntry } from "@/lib/business/tech-catalog";
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
  type Quote,
  type RateCard,
  type Requirement,
  type RequirementDraft,
  type Scope,
  type Tier,
} from "@/lib/business/types";
import { cn } from "@/lib/utils";

import { BudgetSummary } from "./budget-summary";
import { DocumentAnalyzer, type AnalysisOutcome } from "./document-analyzer";
import { PackageDetails } from "./package-details";
import { QuoteTotals } from "./quotation-document";
import { ScopeSummary } from "./scope-summary";
import { TechnologyCheck } from "./technology-check";
import { Card, Choice, Field, Input, Select, Textarea, jsonFetch } from "./ui";

const STEPS = ["Requirement", "Pages & features", "Package", "Client & services", "Review"] as const;
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
    insights: { confirmed: d.confirmed, assumptions: d.assumptions, questions: d.missingInfo },
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

export function RequirementWizard({ onCreated, onCancel }: { onCreated: (lead: Lead) => void; onCancel: () => void }) {
  const [rates, setRates] = useState<RateCard | null>(null);
  const [catalog, setCatalog] = useState<TechEntry[] | null>(null);
  const [existing, setExisting] = useState<string[]>([]);
  const [step, setStep] = useState(0);
  const [client, setClient] = useState<Client>(emptyClient);
  const [req, setReq] = useState<Requirement>(emptyRequirement);
  const [tier, setTier] = useState<Tier | null>(null);
  const [pageDraft, setPageDraft] = useState("");
  const [pageNote, setPageNote] = useState("");
  const [docBudget, setDocBudget] = useState(0);
  const [beforeFit, setBeforeFit] = useState<Pick<Requirement, "pages" | "modules"> & { mustHave: ModuleId[]; deferredModules: ModuleId[]; deferredPages: string[] } | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [analysis, setAnalysis] = useState<AnalysisOutcome | null>(null);

  useEffect(() => {
    jsonFetch<{ rateCard: RateCard }>("/api/business/rate-card")
      .then((r) => setRates(r.rateCard))
      .catch((e: Error) => setError(e.message));
    jsonFetch<{ catalog: TechEntry[] }>("/api/business/tech-catalog")
      .then((r) => setCatalog(r.catalog))
      .catch(() => {});
    // Existing generated projects, offered for module / version work.
    fetch("/api/projects")
      .then((r) => r.json())
      .then((r: { projects?: { name: string }[] }) => setExisting((r.projects ?? []).map((p) => p.name)))
      .catch(() => {});
  }, []);

  // The estimate stays at zero until the document is analysed or the requirement is filled in.
  const started = step > 0 || analysis !== null;
  // Complexity follows the project type and features (the server does the same).
  const priced = useMemo(() => (rates ? { ...req, complexity: autoComplexity(req, rates) } : req), [req, rates]);
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
  // Budget is compared with the shown package; the price itself is never changed to fit.
  const budgetCheck = useMemo(
    () => (rates && estimate && budget > 0 ? checkBudget(shown?.requirement ?? priced, estimate, client, rates, proposals ?? undefined) : null),
    [rates, estimate, budget, shown, priced, client, proposals],
  );
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
      const { lead } = await jsonFetch<{ lead: Lead }>("/api/business/leads", {
        method: "POST",
        body: JSON.stringify({ client, requirement: withTitleAndSummary(req, client), tier: shownTier }),
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
      <Field label="Client budget (₹, incl. GST)" hint="The most the client can pay for development. We suggest Basic, Standard or Premium from this. Leave empty if not known.">
        <Input type="number" min={0} value={budget || ""} onChange={(e) => setR("budget", Math.max(0, Math.round(Number(e.target.value) || 0)))} placeholder="e.g. 10000" className="text-base" />
      </Field>
      {docBudget > 0 && docBudget !== budget && (
        <p className="-mt-3 flex flex-wrap items-center gap-2 text-[11px] text-amber-200">
          The document says {formatINR(docBudget)}; your {formatINR(budget)} is used.
          <button type="button" onClick={() => { setR("budget", docBudget); setDocBudget(0); }} className="rounded-md border border-amber-400/40 px-1.5 py-0.5 hover:bg-amber-500/15">
            Use {formatINR(docBudget)}
          </button>
        </p>
      )}
      {budget > 0 && (
        <div className="flex items-start justify-between gap-4 rounded-xl border border-white/[.08] bg-white/[.02] px-4 py-3">
          <div>
            <p className="text-sm font-medium text-slate-100">Stay within budget</p>
            <p className="mt-0.5 text-[11px] text-slate-400">
              {req.budgetStrict
                ? `On: we show what ${formatINR(budget)} can build. The client's pages and features stay as requested until you click "Use this scope".`
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
    <div className="grid gap-6 xl:grid-cols-[1fr_340px]">
      <div className="min-w-0 space-y-5">
        {/* Step indicator */}
        <ol className="flex flex-wrap gap-2">
          {STEPS.map((label, i) => (
            <li key={label}>
              <button
                type="button"
                onClick={() => i < step && setStep(i)}
                disabled={i > step}
                className={cn(
                  "flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs transition",
                  i === step ? "border-violet-400/60 bg-violet-500/15 text-white" : i < step ? "border-white/10 text-slate-300 hover:bg-white/5" : "border-white/[.06] text-slate-600",
                )}
              >
                <span className={cn("flex h-4 w-4 items-center justify-center rounded-full text-[9px]", i < step ? "bg-emerald-500/80 text-white" : "bg-white/10")}>
                  {i < step ? <Check size={10} /> : i + 1}
                </span>
                {label}
              </button>
            </li>
          ))}
        </ol>

        <Card className="space-y-5">
          {step === 0 && analysis && budgetBlock}
          {step === 0 && !analysis && <DocumentAnalyzer onDraft={applyAnalysis}>{budgetBlock}</DocumentAnalyzer>}
          {analysis && (step === 0 || step === STEPS.length - 1) && <AnalysisNotes analysis={analysis} onClear={() => setAnalysis(null)} />}

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
              <Field
                label={`Pages: ${billableCount} billed${req.pages.length > billableCount ? ` + ${req.pages.length - billableCount} supporting` : ""}`}
                hint={`Each page: ${rates.page.baseHours} h + ${rates.page.sectionHours} h per section (hero, gallery, form...) at ${formatINR(rates.hourlyRate)}/hour, adjusted for complexity. Supporting pages (404, thank-you) and the shared header, footer and navigation are included in the set-up.`}
              >
                <div className="space-y-1.5 rounded-lg border border-white/[.08] bg-white/[.02] p-2">
                  {req.pages.map((p) => {
                    const kind = pageKind(req, p);
                    return (
                    <div key={p} className={cn("grid grid-cols-[minmax(0,1fr)_88px_24px] items-center gap-2 sm:grid-cols-[minmax(120px,200px)_minmax(0,1fr)_88px_24px]", kind === "supporting" && "opacity-70")}>
                      <span className="flex min-w-0 items-center gap-1.5 text-sm text-violet-200">
                        <span className="truncate">{p}</span>
                        <button
                          type="button"
                          onClick={() => setKind(p, kind === "main" ? "supporting" : "main")}
                          title={kind === "main" ? "Billed page. Click to mark as a supporting page (not billed)." : "Supporting page, included in the set-up. Click to bill it as a full page."}
                          className={cn("shrink-0 rounded px-1 text-[9px] uppercase tracking-wider", kind === "main" ? "bg-violet-500/20 text-violet-200" : "bg-white/[.06] text-slate-400")}
                        >
                          {kind === "main" ? "page" : "supporting"}
                        </button>
                        {isLegalPage(p) && <span className="shrink-0 rounded bg-white/[.06] px-1 text-[9px] uppercase tracking-wider text-slate-400">legal</span>}
                      </span>
                      <input
                        value={req.pageDetails?.[p]?.purpose ?? ""}
                        onChange={(e) => setDetail(p, { purpose: e.target.value.slice(0, 200) })}
                        placeholder="Short details: what this page shows"
                        className="order-last col-span-3 rounded-md border border-white/[.06] bg-transparent px-2 py-1 text-xs text-slate-300 outline-none placeholder:text-slate-600 focus:border-violet-400/50 sm:order-none sm:col-span-1"
                      />
                      <label className="flex items-center gap-1 text-[11px] text-slate-500">
                        <input
                          type="number"
                          min={1}
                          max={30}
                          value={sectionsOf(req, p, rates)}
                          onChange={(e) => setDetail(p, { sections: Math.max(1, Math.min(30, Math.round(Number(e.target.value)) || 1)) })}
                          className="w-12 rounded-md border border-white/[.06] bg-transparent px-1.5 py-1 text-xs text-slate-200 outline-none"
                        />
                        sec
                      </label>
                      <button type="button" aria-label={`Remove ${p}`} onClick={() => setR("pages", req.pages.filter((x) => x !== p))} className="text-slate-500 hover:text-white"><X size={13} /></button>
                    </div>
                    );
                  })}
                  <input value={pageDraft} onChange={(e) => setPageDraft(e.target.value)} onKeyDown={onPageKey} onBlur={() => addPage(pageDraft)} placeholder="Type a page and press Enter" className="w-full bg-transparent px-1 py-1 text-sm outline-none placeholder:text-slate-600" />
                </div>
              </Field>
              {pageNote && <p className="text-[11px] text-sky-200">{pageNote}</p>}
              {(req.deferredPages?.length ?? 0) > 0 && (
                <Field label="Phase 2 pages (kept on record, not priced now)">
                  <ul className="flex flex-wrap gap-1.5">
                    {req.deferredPages!.map((p) => (
                      <li key={p} className="flex items-center gap-1.5 rounded-md border border-amber-400/20 bg-amber-500/[.06] px-2 py-1 text-[11px] text-amber-100">
                        {p}
                        <button type="button" onClick={() => setReq((r) => restorePage(r, p))} className="text-amber-300 hover:text-white">Add back</button>
                      </li>
                    ))}
                  </ul>
                </Field>
              )}
              <div className="flex flex-wrap gap-1.5">
                {PAGE_SUGGESTIONS.filter((p) => !req.pages.some((x) => x.toLowerCase() === p.toLowerCase())).map((p) => (
                  <button key={p} type="button" onClick={() => addPage(p)} className="flex items-center gap-1 rounded-md border border-white/[.08] px-2 py-1 text-[11px] text-slate-400 hover:text-white">
                    <Plus size={11} /> {p}
                  </button>
                ))}
              </div>
              {optionalPages.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-slate-500">
                  <span>Optional pages (add only if the client asks):</span>
                  {optionalPages.map((p) => (
                    <button key={p} type="button" onClick={() => addPage(p)} className="flex items-center gap-1 rounded-md border border-dashed border-white/[.12] px-2 py-1 text-slate-400 hover:text-white">
                      <Plus size={11} /> {p}
                    </button>
                  ))}
                </div>
              )}
              <p className="text-[11px] text-slate-500">
                Shared components (not pages): {(req.sharedComponents?.length ? req.sharedComponents : ["Header", "Footer", "Navigation"]).join(", ")}.
              </p>
              <Field label="Modules / features" hint="Only selected features are priced. Optional features can be moved to Phase 2 below.">
                <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
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
              </Field>
              {req.modules.length > 0 && (
                <Field label="Selected features" hint="Must-have features stay in every package and can never move to Phase 2.">
                  <ul className="divide-y divide-white/[.05] rounded-lg border border-white/[.08]">
                    {req.modules.map((m) => {
                      const must = req.mustHave?.includes(m) ?? false;
                      return (
                        <li key={m} className="flex flex-wrap items-center justify-between gap-2 px-3 py-1.5 text-xs">
                          <span className="text-slate-200">{rates.modules[m].label} <span className="text-slate-500">· {rates.modules[m].hours} h</span></span>
                          <span className="flex items-center gap-1.5">
                            <span className={cn("rounded px-1.5 py-0.5 text-[10px]", must ? "bg-amber-500/15 text-amber-200" : "bg-white/[.05] text-slate-400")}>{must ? "Must-have" : "Optional"}</span>
                            {!must && (
                              <button type="button" onClick={() => toPhase2(m)} className="rounded-md border border-white/[.1] px-1.5 py-0.5 text-[10px] text-slate-300 hover:bg-white/5">Move to Phase 2</button>
                            )}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </Field>
              )}
              {(req.deferredModules?.length ?? 0) > 0 && (
                <Field label="Phase 2 features (kept on record, not priced now)">
                  <ul className="flex flex-wrap gap-1.5">
                    {req.deferredModules!.map((m) => (
                      <li key={m} className="flex items-center gap-1.5 rounded-md border border-amber-400/20 bg-amber-500/[.06] px-2 py-1 text-[11px] text-amber-100">
                        {rates.modules[m]?.label ?? m}
                        <button type="button" onClick={() => fromPhase2(m)} className="text-amber-300 hover:text-white">Add back</button>
                      </li>
                    ))}
                  </ul>
                </Field>
              )}
              {req.modules.length > 0 && (
                <Field label="Must-have features" hint="Always included in the Standard and Premium packages. Basic keeps only what the site cannot work without. Tap to mark.">
                  <div className="flex flex-wrap gap-1.5">
                    {req.modules.map((m) => {
                      const on = req.mustHave?.includes(m) ?? false;
                      return (
                        <button
                          key={m}
                          type="button"
                          aria-pressed={on}
                          onClick={() => setR("mustHave", on ? (req.mustHave ?? []).filter((x) => x !== m) : [...(req.mustHave ?? []), m])}
                          className={cn("flex items-center gap-1 rounded-md border px-2 py-1 text-[11px]", on ? "border-amber-400/50 bg-amber-500/10 text-amber-100" : "border-white/[.08] text-slate-400 hover:text-white")}
                        >
                          <Star size={11} className={on ? "fill-amber-300 text-amber-300" : ""} /> {rates.modules[m].label}
                        </button>
                      );
                    })}
                  </div>
                </Field>
              )}
              <Field label="Design">
                <div className="grid gap-2 sm:grid-cols-3">
                  {DESIGN_SOURCES.map((d) => (
                    <Choice key={d} active={req.design === d} onClick={() => setR("design", d)} title={rates.design[d].label} detail={rates.design[d].hours ? `${rates.design[d].hours} h · ${rates.design[d].detail}` : rates.design[d].detail} />
                  ))}
                </div>
              </Field>
              <details className="rounded-xl border border-white/[.08] bg-white/[.02] px-4 py-3" open={Object.keys(req.tech ?? {}).length > 0}>
                <summary className="cursor-pointer text-sm font-medium text-slate-100">
                  Technology <span className="text-xs font-normal text-slate-400">(optional, for technical clients)</span>
                </summary>
                <p className="mt-2 text-[11px] text-slate-400">
                  Leave every choice on &quot;SILPI chooses&quot; if the client does not mind. A different technology changes the development hours, and the estimate updates straight away.
                  {!needsBackend(req, rates) && " This site needs no backend or database, so only the frontend matters."}
                </p>
                <div className="mt-3 grid gap-3 sm:grid-cols-3">
                  {(["frontend", "backend", "database"] as const).map((layer) => {
                    const backendLayer = layer !== "frontend";
                    const off = backendLayer && !needsBackend(req, rates);
                    const options = Object.entries(rates.technology?.[layer] ?? {}).filter(([id, o]) => o.available || req.tech?.[layer] === id);
                    const current = req.tech?.[layer] ? rates.technology[layer][req.tech[layer]!] : undefined;
                    return (
                      <Field key={layer} label={layer === "frontend" ? "Frontend" : layer === "backend" ? "Backend" : "Database"} hint={current?.detail}>
                        <Select
                          value={req.tech?.[layer] ?? ""}
                          disabled={off}
                          onChange={(e) => {
                            const next = { ...(req.tech ?? {}) };
                            if (e.target.value) next[layer] = e.target.value;
                            else delete next[layer];
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
              <Field label="References" hint="Sites the client likes, brand colours, logo notes.">
                <Textarea value={req.references} onChange={(e) => setR("references", e.target.value)} className="min-h-16" />
              </Field>
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
                <TechnologyCheck
                  requirement={priced}
                  budget={budget}
                  rates={rates}
                  catalog={catalog}
                  onConfirm={(ids) => setReq((r) => (r.clientTech ? { ...r, clientTech: { ...r.clientTech, confirmedIds: ids } } : r))}
                  onUndo={() => setReq((r) => (r.clientTech ? { ...r, clientTech: { stated: r.clientTech.stated, ids: r.clientTech.ids } } : r))}
                />
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
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-violet-400/30 bg-violet-500/10 px-4 py-3 text-sm">
                  <span>
                    <span className="font-semibold text-white">{shown.title} package</span>
                    <span className="block text-xs text-slate-400">{shown.pages.length} pages · {shown.requirement.modules.length} features · {shown.quote.totalHours} h · about {shown.estimatedWeeks} weeks</span>
                  </span>
                  <span className="flex items-center gap-3">
                    <span className="text-lg font-semibold tabular-nums text-white">{formatINR(shown.grandTotal)}</span>
                    <button type="button" onClick={() => setStep(PACKAGE_STEP)} className="text-xs text-violet-300 hover:text-white">Change</button>
                  </span>
                </div>
              )}
              <div>
                <p className="mb-3 text-[11px] font-semibold uppercase tracking-[.15em] text-slate-500">Client details</p>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Client name *"><Input value={client.name} onChange={(e) => setC("name", e.target.value)} placeholder="Full name" /></Field>
                  <Field label="Company"><Input value={client.company} onChange={(e) => setC("company", e.target.value)} placeholder="Business name (optional)" /></Field>
                  <Field label="Email *"><Input type="email" value={client.email} onChange={(e) => setC("email", e.target.value)} placeholder="client@example.com" /></Field>
                  <Field label="Phone *"><Input value={client.phone} onChange={(e) => setC("phone", e.target.value)} placeholder="+91 98765 43210" /></Field>
                  <Field label="State *" hint="Decides CGST + SGST (same state) or IGST (other state).">
                    <Select value={client.state} onChange={(e) => setC("state", e.target.value)}>
                      {INDIAN_STATES.map((s) => <option key={s}>{s}</option>)}
                    </Select>
                  </Field>
                  <Field label="GSTIN" hint="Optional, for business clients."><Input value={client.gstin} onChange={(e) => setC("gstin", e.target.value.toUpperCase())} placeholder="33ABCDE1234F1Z5" maxLength={15} /></Field>
                  <Field label="Billing address" className="sm:col-span-2"><Textarea value={client.address} onChange={(e) => setC("address", e.target.value)} className="min-h-16" /></Field>
                  <Field label="Client deadline (weeks)" hint={shown ? `This package needs about ${shown.estimatedWeeks} weeks. 0 = no fixed deadline.` : "0 = no fixed deadline."}>
                    <Input type="number" min={0} value={req.deadlineWeeks} onChange={(e) => setR("deadlineWeeks", Math.max(0, Number(e.target.value) || 0))} />
                  </Field>
                </div>
                {shown && req.deadlineWeeks > 0 && req.deadlineWeeks < shown.estimatedWeeks && (
                  <p className="mt-2 text-xs text-amber-300">The deadline is shorter than the {shown.estimatedWeeks} weeks this package needs. Agree the date with the client.</p>
                )}
              </div>
            </>
          )}

          {/* 5. Review: everything, including every page name */}
          {step === 4 && shown && (
            <div className="space-y-5 text-sm">
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
                  {budget > 0 && <p>Client budget: {formatINR(budget)}</p>}
                </ReviewBlock>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-violet-400/30 bg-violet-500/10 px-4 py-3">
                <span>
                  <span className="font-semibold text-white">{shown.title} package</span>
                  <span className="block text-xs text-slate-400">{shown.quote.totalHours} h · about {shown.estimatedWeeks} weeks{shown.terms ? ` · ${shown.terms.revisions} revisions · ${shown.terms.supportDays} days support` : ""}</span>
                </span>
                <span className="text-lg font-semibold tabular-nums text-white">{formatINR(shown.grandTotal)}</span>
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

              <p className="text-xs text-slate-500">Saving creates the quotation with the {shown.title} package selected and all three packages for the client to compare. You can still change the package, add a discount or share it afterwards.</p>
            </div>
          )}

          {/* Package choice, before the package details page: click one to see its details. */}
          {proposals && step < PACKAGE_STEP && (
            <div className="space-y-2 border-t border-white/[.06] pt-4">
              <p className="text-[11px] font-semibold uppercase tracking-[.15em] text-slate-500">Choose a package</p>
              <div className="grid gap-2 sm:grid-cols-3">
                {proposals.map((p) => {
                  const active = p.tier === shownTier;
                  return (
                    <button
                      key={p.tier}
                      type="button"
                      onClick={() => openPackage(p.tier)}
                      className={cn(
                        "flex flex-col gap-1 rounded-xl border px-3 py-2.5 text-left text-xs transition",
                        active ? "border-violet-400/60 bg-violet-500/15" : "border-white/[.08] bg-white/[.03] hover:border-white/20",
                      )}
                    >
                      <span className="flex items-center justify-between gap-2">
                        <span className="text-sm font-semibold text-slate-100">{p.title}</span>
                        {p.tier === suggested && <span className="flex items-center gap-0.5 rounded-full bg-emerald-500/20 px-1.5 text-[9px] font-semibold text-emerald-300"><Sparkles size={9} /> suggested</span>}
                      </span>
                      <span className={cn("text-base font-semibold tabular-nums", budget > 0 ? (p.grandTotal <= budget ? "text-emerald-300" : "text-rose-300") : "text-white")}>{formatINR(p.grandTotal)}</span>
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
            <button type="button" onClick={step === 0 ? onCancel : () => { setError(""); setStep(step - 1); }} className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-slate-400 hover:text-white">
              <ArrowLeft size={15} /> {step === 0 ? "Cancel" : "Back"}
            </button>
            {step < STEPS.length - 1 ? (
              <button type="button" onClick={next} disabled={step === PACKAGE_STEP && !proposals} className="flex items-center gap-2 rounded-lg bg-violet-500 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-400 disabled:opacity-50">
                {step === PACKAGE_STEP ? <>Finalise {shown?.title ?? ""} package <Check size={15} /></> : step === 1 ? <>See packages <ArrowRight size={15} /></> : <>Next <ArrowRight size={15} /></>}
              </button>
            ) : (
              <button type="button" onClick={submit} disabled={saving} className="flex items-center gap-2 rounded-lg bg-violet-500 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-400 disabled:opacity-60">
                {saving ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} Save & create quotation
              </button>
            )}
          </div>
        </Card>
      </div>

      {/* Live estimate */}
      <aside className="xl:sticky xl:top-24 xl:self-start">
        <Card>
          <p className="text-[11px] font-semibold uppercase tracking-[.15em] text-slate-500">
            Estimate{shown && <span className="normal-case tracking-normal text-violet-300"> · {shown.title} package</span>}
          </p>
          {estimate ? (
            <div className="mt-3 space-y-4 text-slate-300">
              <QuoteTotals quote={estimate} />
              <div className="space-y-1 border-t border-white/[.06] pt-3 text-xs">
                {estimate.schedule.map((s) => (
                  <div key={s.label} className="flex justify-between gap-3"><span className="text-slate-500">{s.percent}% {s.label.split(" - ")[0].toLowerCase()}</span><span className="tabular-nums">{formatINR(s.amount)}</span></div>
                ))}
              </div>
              <p className="text-xs text-slate-500">
                {estimate.pageCount ? `${estimate.pageCount.billable} page${estimate.pageCount.billable === 1 ? "" : "s"}${estimate.pageCount.supporting ? ` + ${estimate.pageCount.supporting} supporting` : ""} · ` : ""}
                {estimate.totalHours} development hours · about {estimate.estimatedWeeks} week{estimate.estimatedWeeks === 1 ? "" : "s"} of work
              </p>
              {estimate.deferred && <p className="text-[11px] text-amber-200/80">Phase 2 (not priced): {estimate.deferred.modules.join(", ")}</p>}
            </div>
          ) : (
            <div className="mt-3 space-y-1 text-sm text-slate-500">
              <div className="flex justify-between"><span>Subtotal</span><span className="tabular-nums">{formatINR(0)}</span></div>
              <div className="flex justify-between"><span>GST</span><span className="tabular-nums">{formatINR(0)}</span></div>
              <div className="mt-1 flex justify-between border-t border-slate-400/30 pt-2 text-base font-semibold"><span>Grand total</span><span className="tabular-nums">{formatINR(0)}</span></div>
              <div className="space-y-0.5 pt-2 text-xs">
                <div className="flex justify-between gap-3"><span>Domain name</span><span>Not included</span></div>
                <div className="flex justify-between gap-3"><span>Hosting</span><span>Not included</span></div>
                <p className="pt-1 text-[11px] text-slate-500">Buy separately, for example from Hostinger or GoDaddy.</p>
              </div>
              <p className="pt-2 text-xs">The estimate appears after the document is analysed or the requirement is filled in.</p>
            </div>
          )}
          {budgetCheck && (
            <div className="mt-4">
              <BudgetSummary check={budgetCheck} onMoveToPhase2={toPhase2} onApplyPlan={applyPlan} onChangeDesign={(x) => setR("design", x)} compact />
            </div>
          )}
        </Card>
      </aside>
    </div>
  );
}

function ReviewBlock({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-white/[.06] bg-white/[.02] p-4 text-xs text-slate-400">
      <p className="mb-2 text-[11px] font-semibold uppercase tracking-[.15em] text-slate-500">{title}</p>
      {children}
    </section>
  );
}

/** What the AI could not tell from the document: ask the client before sending the quotation. */
function AnalysisNotes({ analysis, onClear }: { analysis: AnalysisOutcome; onClear: () => void }) {
  const { draft } = analysis;
  const confirmed = draft.confirmed ?? [];
  return (
    <div className="rounded-xl border border-amber-400/20 bg-amber-500/[.06] p-4 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 font-semibold text-amber-200">
          <AlertTriangle size={14} /> Filled from {analysis.files.length ? analysis.files.join(", ") : "your notes"}. Check every field.
        </p>
        <button type="button" onClick={onClear} className="text-[11px] text-slate-400 hover:text-white">Analyse another document</button>
      </div>
      {confirmed.length > 0 && (
        <div className="mt-3">
          <p className="flex items-center gap-1.5 text-emerald-200"><CheckCircle2 size={13} /> Confirmed by the client ({confirmed.length}):</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-slate-400">{confirmed.map((c) => <li key={c}>{c}</li>)}</ul>
        </div>
      )}
      {draft.missingInfo.length > 0 && (
        <div className="mt-3">
          <p className="flex items-center gap-1.5 text-rose-200"><HelpCircle size={13} /> Unanswered: ask the client ({draft.missingInfo.length}):</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-slate-400">{draft.missingInfo.map((q) => <li key={q}>{q}</li>)}</ul>
        </div>
      )}
      {draft.assumptions.length > 0 && (
        <div className="mt-3">
          <p className="flex items-center gap-1.5 text-amber-200"><AlertTriangle size={13} /> Assumed by the AI: confirm with the client ({draft.assumptions.length}):</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-slate-400">{draft.assumptions.map((a) => <li key={a}>{a}</li>)}</ul>
        </div>
      )}
      <p className="mt-2 text-[11px] text-slate-500">Analysis cost: ${analysis.costUsd.toFixed(4)} USD ({analysis.model})</p>
    </div>
  );
}
