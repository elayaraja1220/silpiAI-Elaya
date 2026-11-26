"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, CheckCircle2, FileText, Loader2, Plus, Printer, RefreshCw, RotateCcw, Trash2, XCircle } from "lucide-react";

import { AnalysisPanel } from "@/components/business/analysis-panel";
import { deferredTexts, type InsightDecision } from "@/lib/business/clarifications";
import { documentsOf } from "@/lib/business/requirement-view";
import { DeleteLeadDialog } from "@/components/business/delete-lead-dialog";
import { AssetsPanel } from "@/components/business/assets-panel";
import { DemoPanel } from "@/components/business/demo-panel";
import { JourneyStepper, LeadTabBar, NextSteps, TabPanel, type FilesProgress, type TabDef, type TabId } from "@/components/business/lead-tabs";
import { assetsOpen, isDesignKey } from "@/lib/business/assets";
import { ExecutionPanel } from "@/components/business/execution-panel";
import { BudgetSummary } from "@/components/business/budget-summary";
import { AccuracyCard, HoursPanel } from "@/components/business/hours-panel";
import { LeadCostPanel } from "@/components/business/cost-panel";
import { TechnologyChooser } from "@/components/business/technology-chooser";
import { RunningServicesEditor } from "@/components/business/running-services-editor";
import { HourlyTermsCard } from "@/components/business/hourly-terms-card";
import { PaymentPanel, ProposalsPanel, SharePanel } from "@/components/business/proposals-panel";
import { QuotationDocument } from "@/components/business/quotation-document";
import { BillingModePicker, HourlyEngagementForm } from "@/components/business/hourly-engagement-form";
import { RequirementWizard } from "@/components/business/requirement-wizard";
import { Card, Input, StageBadge, jsonFetch } from "@/components/business/ui";
import { formatMoney, moneyOf } from "@/lib/business/money";
import { ApprovalRecordCard } from "@/components/business/approval-record";
import { MoneyProvider } from "@/components/business/money-context";
import { STAGE_LABELS, type BillingMode, type Lead, type Quote, type RequirementInsights, type Stage } from "@/lib/business/types";
import { formatRelativeTime } from "@/lib/utils";

type History = { fromStage: Stage | null; toStage: Stage; note: string; at: string }[];

/** Clients & quotations: requirement intake, pricing and approval (workflow step 1). */
export function ClientsPage() {
  const router = useRouter();
  const [leads, setLeads] = useState<Lead[] | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    jsonFetch<{ leads: Lead[] }>("/api/business/leads")
      .then((r) => { setLeads(r.leads); setError(""); })
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  const [toDelete, setToDelete] = useState<Lead | null>(null);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-100">Client requirements & quotations</h2>
          <p className="mt-1 text-xs text-slate-500">Collect a requirement, get the price with GST, and send the quotation.</p>
        </div>
        <button onClick={() => router.push("/clients/new")} className="flex items-center gap-2 rounded-lg bg-violet-500 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-400">
          <Plus size={16} /> Get your quotation
        </button>
      </div>

      {error && <p className="rounded-lg border border-rose-400/20 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">{error}</p>}

      {!leads && !error && <Card className="flex items-center gap-2 text-sm text-slate-400"><Loader2 size={15} className="animate-spin" /> Loading...</Card>}

      {leads?.length === 0 && (
        <Card className="py-12 text-center">
          <FileText className="mx-auto text-slate-600" size={28} />
          <p className="mt-3 text-sm text-slate-300">No requirements yet</p>
          <p className="mt-1 text-xs text-slate-500">Start with a client&apos;s requirement to create the first quotation.</p>
        </Card>
      )}

      {leads && <AccuracyCard leads={leads} />}

      {leads && leads.length > 0 && (
        <Card className="overflow-x-auto p-0">
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="border-b border-white/[.06] text-left text-[11px] uppercase tracking-wider text-slate-500">
                <th className="px-5 py-3 font-medium">Project</th>
                <th className="px-5 py-3 font-medium">Client</th>
                <th className="px-5 py-3 font-medium">Quotation</th>
                <th className="px-5 py-3 text-right font-medium">Total</th>
                <th className="px-5 py-3 font-medium">Stage</th>
                <th className="px-5 py-3 font-medium">Updated</th>
                <th className="px-3 py-3"><span className="sr-only">Delete</span></th>
              </tr>
            </thead>
            <tbody>
              {leads.map((lead) => (
                <tr key={lead.id} onClick={() => router.push(`/clients/${lead.id}`)} className="cursor-pointer border-b border-white/[.04] transition hover:bg-white/[.03]">
                  <td className="px-5 py-3">
                    <p className="font-medium text-slate-100">{lead.requirement.title}</p>
                    <p className="text-xs capitalize text-slate-500">{lead.requirement.billing === "hourly" ? "Hourly engagement" : `${lead.requirement.scope} · ${lead.requirement.projectType.replace("-", " ")}`}</p>
                  </td>
                  <td className="px-5 py-3 text-slate-300">{lead.client.company || lead.client.name}</td>
                  <td className="px-5 py-3 text-slate-400">{lead.quotation?.number ?? "—"}</td>
                  <td className="px-5 py-3 text-right tabular-nums text-slate-200">{lead.quotation ? <>{formatMoney(lead.quotation.grandTotal, moneyOf(lead.quotation))}{lead.quotation.hourly && <span className="ml-1 text-[10px] text-slate-500">est.</span>}</> : "—"}</td>
                  <td className="px-5 py-3"><StageBadge stage={lead.stage} /></td>
                  <td className="px-5 py-3 text-xs text-slate-500">{formatRelativeTime(lead.updatedAt)}</td>
                  <td className="px-3 py-3 text-right">
                    <button type="button" aria-label={`Delete ${lead.requirement.title}`} onClick={(e) => { e.stopPropagation(); setToDelete(lead); }} className="rounded-md p-1.5 text-slate-500 hover:bg-rose-500/10 hover:text-rose-300"><Trash2 size={15} /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {toDelete && <DeleteLeadDialog lead={toDelete} onClose={() => setToDelete(null)} onDeleted={load} onError={setError} />}
    </div>
  );
}

/** Page: /clients/new */
export function NewRequirementPage() {
  const router = useRouter();
  const [billing, setBilling] = useState<BillingMode>("fixed");
  const cancel = () => router.push("/clients");
  const created = (lead: Lead) => router.push(`/clients/${lead.id}`);
  // Both stay mounted so a half-filled fixed-price form is not lost when you look at the other one.
  return (
    <div className="space-y-5">
      <BillingModePicker mode={billing} onChange={setBilling} />
      <div className={billing === "fixed" ? "" : "hidden"}><RequirementWizard onCancel={cancel} onCreated={created} /></div>
      {billing === "hourly" && <HourlyEngagementForm onCancel={cancel} onCreated={created} />}
    </div>
  );
}

/** Page: /clients/[id] */
export function LeadDetailPage({ id }: { id: string }) {
  const router = useRouter();
  return <LeadDetail id={id} onBack={() => router.push("/clients")} />;
}

function LeadDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const router = useRouter();
  const [lead, setLead] = useState<Lead | null>(null);
  const [history, setHistory] = useState<History>([]);
  const [discount, setDiscount] = useState("");
  const [techOpen, setTechOpen] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const apply = (r: { lead: Lead; history: History }) => { setLead(r.lead); setHistory(r.history); setError(""); };

  // One section at a time. The tab is kept in the address (#files, #build...) so a refresh or a shared link opens the same place.
  const [tab, setTab] = useState<TabId>("summary");
  const [files, setFiles] = useState<FilesProgress | null>(null);
  const [genRequest, setGenRequest] = useState(0);
  useEffect(() => {
    const wanted = window.location.hash.slice(1);
    if (wanted) setTab(wanted as TabId);
  }, []);
  const go = (next: TabId) => {
    setTab(next);
    window.history.replaceState(null, "", `#${next}`);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  const filesOpen = !!lead && assetsOpen(lead.stage);
  useEffect(() => {
    if (!filesOpen) return;
    // "Uploaded" means the item has any file or text, whoever added it and whether or not it was checked yet.
    jsonFetch<{ assets: { key: string; files: unknown[]; text: string }[] }>(`/api/business/leads/${id}/assets`)
      .then((r) => setFiles({ withContent: r.assets.filter((a) => a.files.length > 0 || a.text.trim().length > 0).length, total: r.assets.length, hasDesign: r.assets.some((a) => isDesignKey(a.key) && a.files.length > 0) }))
      .catch(() => {});
  }, [id, filesOpen, tab]);

  useEffect(() => {
    jsonFetch<{ lead: Lead; history: History }>(`/api/business/leads/${id}`).then(apply).catch((e: Error) => setError(e.message));
  }, [id]);

  const run = async (label: string, url: string, method: string, body: object) => {
    setBusy(label);
    try {
      apply(await jsonFetch<{ lead: Lead; history: History }>(url, { method, body: JSON.stringify(body) }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  const setStage = (stage: Stage) => run(stage, `/api/business/leads/${id}`, "PATCH", { stage });
  const requote = () => run("requote", `/api/business/leads/${id}/quote`, "POST", { discount: Number(discount) || 0 });

  if (!lead) {
    return (
      <Card className="flex items-center gap-2 text-sm text-slate-400">
        {error ? <span className="text-rose-300">{error}</span> : <><Loader2 size={15} className="animate-spin" /> Loading...</>}
      </Card>
    );
  }

  const editable = lead.stage === "requirement" || lead.stage === "quoted";
  const button = "flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition disabled:opacity-50";
  const building = ["approved", "advance_paid", "in_development", "testing", "demo_ready"].includes(lead.stage);
  const payable = building || lead.stage === "final_paid";
  const tabs: TabDef[] = [
    { id: "summary", label: "Summary" },
    ...(lead.quotation ? [{ id: "quotation" as const, label: "Quotation" }] : []),
    ...(lead.quotation && filesOpen ? [{ id: "files" as const, label: "Client files & design", hint: files ? `${files.withContent}/${files.total}` : undefined }] : []),
    ...(building ? [{ id: "build" as const, label: "Build" }] : []),
    ...(lead.projectName ? [{ id: "demo" as const, label: "Demo preview" }] : []),
    ...(lead.quotation && filesOpen ? [{ id: "payments" as const, label: "Payments & hours" }] : []),
    ...(lead.quotation ? [{ id: "internal" as const, label: "Costs & services", hint: "team only" }] : []),
  ];
  const active: TabId = tabs.some((t) => t.id === tab) ? tab : "summary";

  return (
    <MoneyProvider quote={lead.quotation}>
    <div className="space-y-5">
      <div className="no-print flex flex-wrap items-center justify-between gap-3">
        <button onClick={onBack} className="flex items-center gap-2 text-sm text-slate-400 hover:text-white"><ArrowLeft size={15} /> All requirements</button>
        <div className="flex flex-wrap items-center gap-2">
          <StageBadge stage={lead.stage} />
          {lead.stage === "quoted" && (
            <button disabled={!!busy} onClick={() => setStage("approved")} className={`${button} bg-emerald-500/90 text-white hover:bg-emerald-500`}>
              {busy === "approved" ? <Loader2 size={15} className="animate-spin" /> : <CheckCircle2 size={15} />} Client approved
            </button>
          )}
          {lead.stage === "approved" && (
            <button disabled={!!busy} onClick={() => setStage("quoted")} className={`${button} border border-white/10 text-slate-300 hover:bg-white/5`}><RotateCcw size={15} /> Reopen quote</button>
          )}
          {lead.stage === "lost" ? (
            <button disabled={!!busy} onClick={() => setStage("requirement")} className={`${button} border border-white/10 text-slate-300 hover:bg-white/5`}><RotateCcw size={15} /> Reopen</button>
          ) : ["requirement", "quoted", "approved"].includes(lead.stage) && (
            <button disabled={!!busy} onClick={() => setStage("lost")} className={`${button} text-rose-300 hover:bg-rose-500/10`}><XCircle size={15} /> Mark lost</button>
          )}
          <button onClick={() => { if (active !== "quotation" && lead.quotation) go("quotation"); setTimeout(() => window.print(), 150); }} className={`${button} border border-white/10 text-slate-200 hover:bg-white/5`}><Printer size={15} /> Print / Save PDF</button>
        </div>
      </div>

      {error && <p className="no-print rounded-lg border border-rose-400/20 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">{error}</p>}

      {/* Who and how much, and where the project is */}
      <section className="no-print space-y-4 rounded-2xl border border-white/[.07] bg-gradient-to-b from-[#141927] to-[#10141f] p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-[11px] uppercase tracking-[.18em] text-violet-300">{lead.quotation ? `Quotation ${lead.quotation.number}` : "No quotation yet"}</p>
            <h2 className="mt-1 text-lg font-semibold leading-snug text-slate-100">{lead.requirement.title}</h2>
            <p className="mt-0.5 text-sm text-slate-400">{lead.client.company || lead.client.name} · {lead.requirement.billing === "hourly" ? <span>Hourly engagement · {lead.requirement.hourly?.role}</span> : <span className="capitalize">{lead.requirement.projectType.replace(/-/g, " ")}</span>}</p>
          </div>
          {lead.quotation && (
            <div className="text-right">
              <p className="text-2xl font-semibold tabular-nums text-white">{formatMoney(lead.quotation.grandTotal, moneyOf(lead.quotation))}</p>
              <p className="text-[11px] text-slate-500">{lead.quotation.hourly ? "estimate, incl. GST" : "incl. GST"}</p>
            </div>
          )}
        </div>
        <JourneyStepper stage={lead.stage} />
      </section>

      <LeadTabBar tabs={tabs} active={active} onChange={go} />

      {/* Summary: what to do next, then the background */}
      <TabPanel id="summary" active={active}>
        <NextSteps lead={lead} files={files} onGo={go} onApprove={() => setStage("approved")} busy={!!busy} />
        <div className="no-print grid gap-5 lg:grid-cols-2">
          <Card>
            <p className="text-xs font-semibold text-slate-300">Requirement</p>
            <p className="mt-2 whitespace-pre-line text-xs leading-5 text-slate-400">{lead.requirement.summary}</p>
            {lead.requirement.references && <p className="mt-2 whitespace-pre-line text-xs text-slate-500">Refs: {lead.requirement.references}</p>}
            {lead.requirement.existingProject && <p className="mt-2 text-xs text-slate-500">Existing project: {lead.requirement.existingProject} {lead.requirement.version}</p>}
          </Card>
          <Card>
            <p className="text-xs font-semibold text-slate-300">History</p>
            <ol className="mt-3 space-y-3 border-l border-white/10 pl-4">
              {history.map((h, i) => (
                <li key={i} className="relative text-xs">
                  <span className="absolute -left-[21px] top-1 h-2 w-2 rounded-full bg-violet-400" />
                  <p className="text-slate-200">{STAGE_LABELS[h.toStage]}{h.note && <span className="text-slate-500"> · {h.note}</span>}</p>
                  <p className="text-slate-500">{new Date(h.at).toLocaleString("en-IN")}</p>
                </li>
              ))}
            </ol>
          </Card>
          <div className="lg:col-span-2"><ApprovalRecordCard leadId={lead.id} refreshKey={`${lead.stage}:${lead.quotation?.id ?? ""}`} /></div>
          {lead.requirement.insights && (
            <div className="lg:col-span-2">
              <InsightsCard
                leadId={lead.id}
                insights={lead.requirement.insights}
                quotation={lead.quotation}
                documents={documentsOf(lead.requirement.references)}
                refreshKey={lead.updatedAt}
                busy={busy === "insight"}
                onDecide={(itemId, decision) => run("insight", `/api/business/leads/${lead.id}/insights`, "PATCH", { itemId, decision })}
              />
            </div>
          )}
        </div>
        {!lead.quotation && <Card className="text-sm text-slate-400">No quotation yet.</Card>}
      </TabPanel>

      {/* Quotation: the packages, sharing, and exactly what the client sees */}
      {lead.quotation && (
        <TabPanel id="quotation" active={active}>
          {lead.quotation.budgetCheck && lead.quotation.budgetCheck.status !== "none" && <BudgetSummary check={lead.quotation.budgetCheck} />}
          <div className="grid gap-5 xl:grid-cols-[1fr_320px]">
            <div className="min-w-0">{lead.quotation.hourly ? <HourlyTermsCard lead={lead} /> : <ProposalsPanel lead={lead} editable={editable} onChanged={apply} />}</div>
            <div className="no-print space-y-5">
              <SharePanel key={lead.updatedAt} lead={lead} onChanged={apply} />
              {editable && !lead.quotation.hourly && (
                <Card className="space-y-3">
                  <p className="text-xs font-semibold text-slate-300">Adjust & re-price</p>
                  <p className="text-[11px] text-slate-500">Re-prices the selected proposal with the current rate card; creates a new quotation number.</p>
                  <Input type="number" min={0} value={discount} onChange={(e) => setDiscount(e.target.value)} placeholder="Discount in ₹ (before GST)" />
                  <button disabled={!!busy} onClick={requote} className={`${button} w-full justify-center bg-violet-500 text-white hover:bg-violet-400`}>
                    {busy === "requote" ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />} Re-price quotation
                  </button>
                </Card>
              )}
            </div>
          </div>
          <p className="no-print pt-2 text-[11px] font-semibold uppercase tracking-[.15em] text-slate-500">What the client sees</p>
          <QuotationDocument
            quotation={lead.quotation}
            requirement={lead.requirement}
            deferred={deferredTexts(lead.requirement.insights?.tracker ?? [])}
            techAction={editable && !lead.quotation.hourly ? { onChoose: () => setTechOpen(true) } : undefined}
          />
          {techOpen && (
            <TechnologyChooser
              endpoint={`/api/business/leads/${id}/technology`}
              tier={lead.quotation.tier ?? "standard"}
              value={null}
              intro="Set the frontend, backend and database for this quotation. Each option shows how it changes the price. Applying it prices the quotation again with a new number; any discount you gave is kept."
              applyLabel="Apply to the quotation"
              applying={busy === "technology"}
              onClose={() => setTechOpen(false)}
              onApply={async (tech) => { await run("technology", `/api/business/leads/${id}/technology`, "PUT", { tech }); setTechOpen(false); }}
            />
          )}
        </TabPanel>
      )}

      {lead.quotation && filesOpen && (
        <TabPanel id="files" active={active}>
          <AssetsPanel leadId={lead.id} again={!!lead.projectName} onGenerate={building ? () => setGenRequest((n) => n + 1) : undefined} />
        </TabPanel>
      )}

      {building && (
        <TabPanel id="build" active={active}>
          <ExecutionPanel lead={lead} onChanged={apply} contentCount={files?.withContent ?? null} contentTotal={files?.total ?? 0} hasDesign={files?.hasDesign} onGoToFiles={() => go("files")} generateRequest={genRequest} onStarted={() => go("build")} />
        </TabPanel>
      )}

      {lead.projectName && (
        <TabPanel id="demo" active={active}>
          <DemoPanel leadId={lead.id} clientName={lead.client.company || lead.client.name} hasProject={!!lead.projectName} />
        </TabPanel>
      )}

      {lead.quotation && filesOpen && (
        <TabPanel id="payments" active={active}>
          <div className="grid gap-5 xl:grid-cols-[1fr_360px]">
            <div className="min-w-0"><HoursPanel lead={lead} onChanged={apply} /></div>
            {payable && <div className="no-print"><PaymentPanel key={`pay-${lead.updatedAt}`} lead={lead} onChanged={apply} /></div>}
          </div>
        </TabPanel>
      )}

      {/* Internal only: never in the printed or saved quotation */}
      {lead.quotation && (
        <TabPanel id="internal" active={active}>
          <div className="no-print"><LeadCostPanel lead={lead} onConfigure={() => router.push("/pricing")} /></div>
          <div className="no-print"><RunningServicesEditor key={lead.quotation.id} leadId={lead.id} /></div>
        </TabPanel>
      )}
    </div>
    </MoneyProvider>
  );
}

/** What the AI separated out of the documents: still useful while talking to the client. */
function InsightsCard({ leadId, insights, quotation, documents, refreshKey, busy, onDecide }: { leadId: string; insights: RequirementInsights; quotation?: Quote; documents: string[]; refreshKey: string; busy: boolean; onDecide: (itemId: string, decision: InsightDecision) => void }) {
  if (!insights.confirmed.length && !insights.questions.length && !insights.assumptions.length && !insights.tracker?.length) return null;
  return (
    <Card>
      <p className="text-xs font-semibold text-slate-300">From the client&apos;s documents</p>
      <div className="mt-2"><AnalysisPanel leadId={leadId} insights={insights} quotation={quotation} documents={documents} refreshKey={refreshKey} busy={busy} onDecide={onDecide} /></div>
    </Card>
  );
}
