"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, CheckCircle2, FileText, Loader2, Plus, Printer, RefreshCw, RotateCcw, Trash2, XCircle } from "lucide-react";

import { DeleteLeadDialog } from "@/components/business/delete-lead-dialog";
import { AssetsPanel } from "@/components/business/assets-panel";
import { ExecutionPanel } from "@/components/business/execution-panel";
import { BudgetSummary } from "@/components/business/budget-summary";
import { AccuracyCard, HoursPanel } from "@/components/business/hours-panel";
import { LeadCostPanel } from "@/components/business/cost-panel";
import { RunningServicesEditor } from "@/components/business/running-services-editor";
import { PaymentPanel, ProposalsPanel, SharePanel } from "@/components/business/proposals-panel";
import { QuotationDocument } from "@/components/business/quotation-document";
import { RequirementWizard } from "@/components/business/requirement-wizard";
import { Card, Input, StageBadge, jsonFetch } from "@/components/business/ui";
import { formatINR } from "@/lib/business/pricing";
import { STAGE_LABELS, type Lead, type RequirementInsights, type Stage } from "@/lib/business/types";
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
                    <p className="text-xs capitalize text-slate-500">{lead.requirement.scope} · {lead.requirement.projectType.replace("-", " ")}</p>
                  </td>
                  <td className="px-5 py-3 text-slate-300">{lead.client.company || lead.client.name}</td>
                  <td className="px-5 py-3 text-slate-400">{lead.quotation?.number ?? "—"}</td>
                  <td className="px-5 py-3 text-right tabular-nums text-slate-200">{lead.quotation ? formatINR(lead.quotation.grandTotal) : "—"}</td>
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
  return <RequirementWizard onCancel={() => router.push("/clients")} onCreated={(lead) => router.push(`/clients/${lead.id}`)} />;
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
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const apply = (r: { lead: Lead; history: History }) => { setLead(r.lead); setHistory(r.history); setError(""); };

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

  return (
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
          <button onClick={() => window.print()} className={`${button} border border-white/10 text-slate-200 hover:bg-white/5`}><Printer size={15} /> Print / Save PDF</button>
        </div>
      </div>

      {error && <p className="no-print rounded-lg border border-rose-400/20 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">{error}</p>}

      <div className="grid gap-6 xl:grid-cols-[1fr_300px]">
        <div className="min-w-0 space-y-5">
          {/* Originals first: the project is generated from the client's own content. */}
          {lead.quotation && ["approved", "advance_paid", "in_development", "testing", "demo_ready", "final_paid", "delivered"].includes(lead.stage) && <AssetsPanel leadId={lead.id} />}
          {["approved", "advance_paid", "in_development", "testing", "demo_ready"].includes(lead.stage) && <ExecutionPanel lead={lead} onChanged={apply} />}
          {lead.quotation && ["approved", "advance_paid", "in_development", "testing", "demo_ready", "final_paid", "delivered"].includes(lead.stage) && <HoursPanel lead={lead} onChanged={apply} />}
          {lead.quotation?.budgetCheck && lead.quotation.budgetCheck.status !== "none" && <BudgetSummary check={lead.quotation.budgetCheck} />}
          {lead.quotation && <ProposalsPanel lead={lead} editable={editable} onChanged={apply} />}
          {/* Internal only: kept out of the printed or saved quotation */}
          {lead.quotation && <div className="no-print"><LeadCostPanel lead={lead} onConfigure={() => router.push("/pricing")} /></div>}
          {lead.quotation && <div className="no-print"><RunningServicesEditor key={lead.quotation.id} leadId={lead.id} /></div>}
          {lead.quotation ? <QuotationDocument quotation={lead.quotation} requirement={lead.requirement} /> : <Card className="text-sm text-slate-400">No quotation yet.</Card>}
        </div>

        <div className="no-print space-y-5">
          {["approved", "advance_paid", "in_development", "testing", "demo_ready", "final_paid"].includes(lead.stage) && <PaymentPanel key={`pay-${lead.updatedAt}`} lead={lead} onChanged={apply} />}
          <SharePanel key={lead.updatedAt} lead={lead} onChanged={apply} />
          {lead.requirement.insights && <InsightsCard insights={lead.requirement.insights} />}
          {editable && (
            <Card className="space-y-3">
              <p className="text-xs font-semibold text-slate-300">Adjust & re-price</p>
              <p className="text-[11px] text-slate-500">Re-prices the selected proposal with the current rate card; creates a new quotation number.</p>
              <Input type="number" min={0} value={discount} onChange={(e) => setDiscount(e.target.value)} placeholder="Discount in ₹ (before GST)" />
              <button disabled={!!busy} onClick={requote} className={`${button} w-full justify-center bg-violet-500 text-white hover:bg-violet-400`}>
                {busy === "requote" ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />} Re-price quotation
              </button>
            </Card>
          )}

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
        </div>
      </div>
    </div>
  );
}

/** What the AI separated out of the documents: still useful while talking to the client. */
function InsightsCard({ insights }: { insights: RequirementInsights }) {
  const groups = [
    { title: "Confirmed", items: insights.confirmed, color: "text-emerald-300" },
    { title: "Assumed: confirm", items: insights.assumptions, color: "text-amber-300" },
    { title: "Unanswered: ask", items: insights.questions, color: "text-rose-300" },
  ].filter((g) => g.items.length);
  if (!groups.length) return null;
  return (
    <Card>
      <p className="text-xs font-semibold text-slate-300">From the client&apos;s documents</p>
      {groups.map((g) => (
        <details key={g.title} className="mt-2 text-xs" open={g.title.startsWith("Unanswered")}>
          <summary className={`cursor-pointer ${g.color}`}>{g.title} ({g.items.length})</summary>
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-slate-400">{g.items.map((i) => <li key={i}>{i}</li>)}</ul>
        </details>
      ))}
    </Card>
  );
}
