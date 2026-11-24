"use client";

import { useEffect, useState } from "react";
import { Check, CheckCircle2, Copy, FileDown, Hammer, Link2, Loader2, Mail, MessageCircle, MessageSquareWarning, Minus } from "lucide-react";

import { ComparisonTable } from "@/components/business/comparison-table";
import { DEV_START_HEADER } from "@/lib/dev-flags"; // TEMP DEV
import { JOBS_CHANGED } from "@/components/business/execution-panel";
import { GenerateConfirmDialog } from "@/components/business/generate-confirm-dialog";
import { Card, jsonFetch } from "@/components/business/ui";
import { formatINR } from "@/lib/business/pricing";
import type { Proposal } from "@/lib/business/proposals";
import { paymentStatus } from "@/lib/business/payment-status";
import { PAYMENT_MODES, type ComparisonRow, type Lead, type PaymentMode, type Stage } from "@/lib/business/types";
import { cn } from "@/lib/utils";

type History = { fromStage: Stage | null; toStage: Stage; note: string; at: string }[];

const TIER_STYLE = {
  basic: "border-sky-400/30",
  standard: "border-violet-400/50 ring-1 ring-violet-400/20",
  premium: "border-amber-400/30",
} as const;

/** Basic / Standard / Premium side by side; the selected one is the quotation. */
export function ProposalsPanel({ lead, editable, onChanged }: { lead: Lead; editable: boolean; onChanged: (r: { lead: Lead; history: History }) => void }) {
  const [proposals, setProposals] = useState<Proposal[] | null>(null);
  const [comparison, setComparison] = useState<ComparisonRow[]>([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const selected = lead.quotation?.tier;

  useEffect(() => {
    jsonFetch<{ proposals: Proposal[]; comparison: ComparisonRow[] }>(`/api/business/leads/${lead.id}/proposals`)
      .then((r) => {
        setProposals(r.proposals);
        setComparison(r.comparison);
      })
      .catch((e: Error) => setError(e.message));
  }, [lead.id, lead.quotation?.id]);

  const choose = async (tier: Proposal["tier"]) => {
    setBusy(tier);
    setError("");
    try {
      onChanged(await jsonFetch(`/api/business/leads/${lead.id}/proposals`, { method: "POST", body: JSON.stringify({ tier }) }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  };

  const budget = lead.requirement.budget ?? 0;

  return (
    <Card className="no-print space-y-4">
      <div>
        <p className="text-sm font-semibold text-slate-100">Three proposals</p>
        <p className="mt-1 text-xs text-slate-400">
          The client sees all three and picks one when approving.{budget > 0 && <> Client budget: <span className="text-slate-200">{formatINR(budget)}</span> incl. GST.</>}
        </p>
      </div>
      {error && <p className="rounded-md border border-rose-400/20 bg-rose-500/10 px-2.5 py-1.5 text-xs text-rose-200">{error}</p>}
      {!proposals && !error && <p className="flex items-center gap-2 text-xs text-slate-400"><Loader2 size={14} className="animate-spin" /> Working out proposals...</p>}
      {proposals && (
        <div className="grid gap-3 lg:grid-cols-3">
          {proposals.map((p) => {
            const isSelected = p.tier === selected;
            return (
              <div key={p.tier} className={cn("flex flex-col rounded-xl border bg-white/[.02] p-4", TIER_STYLE[p.tier])}>
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-slate-100">{p.title}</p>
                  {p.tier === "standard" && <span className="rounded-full bg-violet-500/20 px-2 py-0.5 text-[10px] text-violet-200">Recommended</span>}
                </div>
                <p className="mt-0.5 text-[11px] text-slate-500">{p.tagline}</p>
                <p className="mt-3 text-xl font-semibold tabular-nums text-white">{formatINR(p.grandTotal)}</p>
                <p className="text-[11px] text-slate-500">
                  incl. GST · {p.quote.totalHours} h · ~{p.estimatedWeeks} wk{p.discount > 0 && ` · ${formatINR(p.discount)} discount`}
                </p>
                {budget > 0 && (
                  <p className={cn("mt-1 text-[11px] font-medium", p.grandTotal <= budget ? "text-emerald-300" : "text-rose-300")}>
                    {p.grandTotal <= budget ? "Within budget" : `${formatINR(p.grandTotal - budget)} over budget`}
                  </p>
                )}
                <p className="mt-3 text-[11px] text-slate-400">
                  <span className="text-slate-500">{p.pages.length} pages:</span> {p.pages.join(", ")}
                  {p.supportingPages?.length ? <span className="text-slate-500"> · supporting (not billed): {p.supportingPages.join(", ")}</span> : null}
                </p>
                <ul className="mt-2 space-y-1 text-xs text-slate-300">
                  {p.features.map((f) => <li key={f} className="flex gap-1.5"><Check size={13} className="mt-0.5 shrink-0 text-emerald-300" />{f}</li>)}
                </ul>
                {p.leftOut.length > 0 && (
                  <ul className="mt-2 space-y-1 text-[11px] text-slate-500">
                    {p.leftOut.map((f) => <li key={f} className="flex gap-1.5"><Minus size={12} className="mt-0.5 shrink-0" />{f}</li>)}
                  </ul>
                )}
                <div className="mt-auto pt-4">
                  {isSelected ? (
                    <p className="flex items-center justify-center gap-1.5 rounded-lg bg-violet-500/15 py-2 text-xs font-medium text-violet-100"><CheckCircle2 size={14} /> In the quotation</p>
                  ) : (
                    <button
                      onClick={() => choose(p.tier)}
                      disabled={!editable || !!busy}
                      title={editable ? undefined : "Reopen the quotation to change it"}
                      className="flex w-full items-center justify-center gap-2 rounded-lg border border-white/10 py-2 text-sm text-slate-200 hover:bg-white/5 disabled:opacity-40"
                    >
                      {busy === p.tier && <Loader2 size={14} className="animate-spin" />} Use {p.title}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {comparison.length > 0 && <ComparisonTable rows={comparison} selected={selected} tone="dark" />}
    </Card>
  );
}

/** Downloads and the client's private approval link, with their latest answer. */
/** WhatsApp wants the number with country code and digits only. */
function whatsappNumber(phone: string): string {
  const digits = phone.replace(/\D/g, "").replace(/^0+/, "");
  return digits.length === 10 ? `91${digits}` : digits;
}

export function SharePanel({ lead, onChanged }: { lead: Lead; onChanged: (r: { lead: Lead; history: History }) => void }) {
  const [link, setLink] = useState(lead.shareToken ? `/q/${lead.shareToken}` : "");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const full = link && typeof window !== "undefined" ? `${window.location.origin}${link}` : "";
  const response = lead.clientResponse;

  const create = async () => {
    setBusy(true);
    setError("");
    try {
      setLink((await jsonFetch<{ path: string }>(`/api/business/leads/${lead.id}/share`, { method: "POST", body: "{}" })).path);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const copy = async () => {
    await navigator.clipboard.writeText(full).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  const button = "flex items-center justify-center gap-2 rounded-lg border border-white/10 px-3 py-2 text-sm text-slate-200 hover:bg-white/5";
  const q = lead.quotation;
  const cheapest = q?.proposals?.length ? Math.min(...q.proposals.map((p) => p.grandTotal)) : q?.grandTotal ?? 0;
  const text = q
    ? [
        `Hello ${lead.client.name},`,
        `Thank you for your enquiry. Your quotation ${q.number} for "${(q.requirement ?? lead.requirement).title}" from ${q.business.name} is ready${q.proposals?.length ? `, with three options starting from ${formatINR(cheapest)} (incl. GST)` : ""}.`,
        `View, choose and approve it here: ${full}`,
        `This link is valid until ${new Date(q.validUntil).toLocaleDateString("en-IN")}.`,
      ].join("\n\n")
    : "";
  const logSent = (channel: "whatsapp" | "email") => {
    jsonFetch<{ lead: Lead; history: History }>(`/api/business/leads/${lead.id}/sent`, { method: "POST", body: JSON.stringify({ channel }) })
      .then(onChanged)
      .catch(() => {});
  };

  return (
    <Card className="no-print space-y-3">
      <p className="text-xs font-semibold text-slate-300">Send to client</p>
      <div className="grid grid-cols-2 gap-2">
        <a href={`/api/business/leads/${lead.id}/document?format=pdf`} className={button}><FileDown size={15} /> PDF</a>
        <a href={`/api/business/leads/${lead.id}/document?format=docx`} className={button}><FileDown size={15} /> Word</a>
      </div>

      {response && (
        <div className={cn("rounded-lg border p-3 text-xs", response.action === "approved" ? "border-emerald-400/30 bg-emerald-500/10 text-emerald-100" : "border-amber-400/30 bg-amber-500/10 text-amber-100")}>
          <p className="flex items-center gap-1.5 font-semibold">
            {response.action === "approved" ? <CheckCircle2 size={14} /> : <MessageSquareWarning size={14} />}
            {response.action === "approved" ? `Approved by ${response.name}` : `${response.name} asked for changes`}
            {response.tier && ` · ${response.tier}`}
          </p>
          {response.message && <p className="mt-1 whitespace-pre-line text-slate-300">&ldquo;{response.message}&rdquo;</p>}
          <p className="mt-1 text-[11px] text-slate-400">{new Date(response.at).toLocaleString("en-IN")}</p>
        </div>
      )}

      {link ? (
        <div className="space-y-2">
          <div className="flex gap-2">
            <input readOnly value={full} className="min-w-0 flex-1 rounded-lg border border-white/[.08] bg-white/[.03] px-2 py-1.5 text-[11px] text-slate-300" onFocus={(e) => e.target.select()} />
            <button onClick={copy} className="rounded-lg border border-white/10 px-2.5 text-slate-300 hover:bg-white/5" aria-label="Copy link">{copied ? <Check size={14} /> : <Copy size={14} />}</button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <a
              href={`https://wa.me/${whatsappNumber(lead.client.phone)}?text=${encodeURIComponent(text)}`}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => logSent("whatsapp")}
              className={cn(button, "border-emerald-400/30 text-emerald-200 hover:bg-emerald-500/10")}
            >
              <MessageCircle size={15} /> WhatsApp
            </a>
            <a
              href={`mailto:${lead.client.email}?subject=${encodeURIComponent(`Quotation ${q?.number ?? ""} from ${q?.business.name ?? ""}`)}&body=${encodeURIComponent(text)}`}
              onClick={() => logSent("email")}
              className={button}
            >
              <Mail size={15} /> Email
            </a>
          </div>
          <p className="text-[11px] text-slate-500">WhatsApp / Email open with the message ready; you press send. Anyone with this link can see the quotation and approve it. Send it only to the client. It works for the client once this site is online (not on localhost).</p>
        </div>
      ) : (
        <button onClick={create} disabled={busy} className={cn(button, "w-full")}>
          {busy ? <Loader2 size={15} className="animate-spin" /> : <Link2 size={15} />} Create client approval link
        </button>
      )}
      {error && <p className="text-xs text-rose-300">{error}</p>}
    </Card>
  );
}

/** Waiting for the advance: what is due, and recording money received outside the site. */
export function PaymentPanel({ lead, onChanged }: { lead: Lead; onChanged: (r: { lead: Lead; history: History }) => void }) {
  const status = paymentStatus(lead.quotation, lead.payments);
  const kind = lead.stage === "demo_ready" ? "balance" : "advance";
  const remaining = kind === "advance" ? status.advanceRemaining : status.balanceRemaining;
  const [amount, setAmount] = useState(String(remaining));
  const [mode, setMode] = useState<PaymentMode>("upi");
  const [reference, setReference] = useState("");
  const [receivedOn, setReceivedOn] = useState(() => new Date().toISOString().slice(0, 10));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const save = async () => {
    setBusy(true);
    setError("");
    try {
      const r = await jsonFetch<{ lead: Lead; history: History }>(`/api/business/leads/${lead.id}/payments`, {
        method: "POST",
        body: JSON.stringify({ kind, amount: Number(amount), mode, reference, receivedOn }),
      });
      setReference("");
      onChanged(r);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Development shortcut: start the work now, without the advance. Local Claude Code only (the API always needs its own cost approval).
  const [skipBusy, setSkipBusy] = useState(false);
  const [skipError, setSkipError] = useState("");
  const [skipChecked, setSkipChecked] = useState(false);
  // Nothing is generated until this is confirmed.
  const [confirmSkip, setConfirmSkip] = useState(false);
  const startWithoutPayment = async () => {
    setSkipBusy(true);
    setSkipError("");
    const post = async (url: string, body: object) => {
      const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", [DEV_START_HEADER]: "1" }, body: JSON.stringify(body) });
      const data = (await res.json().catch(() => ({}))) as { success?: boolean; error?: string };
      if (!res.ok || data.success === false) throw new Error(data.error || "Could not start.");
    };
    try {
      await post(`/api/execution/leads/${lead.id}/prepare`, { scopeConfirmed: true });
      const jobs = (await (await fetch(`/api/execution/leads/${lead.id}`, { headers: { [DEV_START_HEADER]: "1" } })).json()) as { jobs?: { id: string; state: string }[] };
      const job = jobs.jobs?.find((j) => j.state === "prepared");
      if (!job) throw new Error("A run for this project already exists. Use the Generate the project panel.");
      await post(`/api/execution/jobs/${job.id}/start`, { mode: "local", withoutAdvance: true, reason: "Development: started without advance payment" });
      const fresh = await jsonFetch<{ lead: Lead; history: History }>(`/api/business/leads/${lead.id}`);
      onChanged(fresh);
      window.dispatchEvent(new Event(JOBS_CHANGED));
    } catch (e) {
      setSkipError((e as Error).message);
    } finally {
      setSkipBusy(false);
    }
  };

  const waiting = (kind === "advance" && remaining > 0 && ["approved", "in_development", "testing"].includes(lead.stage)) || lead.stage === "demo_ready";
  const field = "w-full rounded-lg border border-white/[.08] bg-white/[.03] px-2.5 py-1.5 text-sm text-slate-100 outline-none focus:border-violet-400/60";

  return (
    <Card className={cn("no-print space-y-3", waiting && "border-amber-400/30")}>
      <p className="text-xs font-semibold text-slate-300">{waiting ? `Waiting for ${kind} payment` : "Payments"}</p>
      <div className="space-y-1 text-xs">
        <div className="flex justify-between"><span className="text-slate-500">Advance due</span><span className="tabular-nums text-slate-200">{formatINR(status.advanceDue)}</span></div>
        <div className="flex justify-between"><span className="text-slate-500">Advance received</span><span className="tabular-nums text-emerald-300">{formatINR(status.advancePaid)}</span></div>
        {status.balancePaid > 0 && <div className="flex justify-between"><span className="text-slate-500">Balance received</span><span className="tabular-nums text-emerald-300">{formatINR(status.balancePaid)}</span></div>}
      </div>
      {lead.payments.length > 0 && (
        <ul className="space-y-1 border-t border-white/[.06] pt-2 text-[11px] text-slate-400">
          {lead.payments.map((p) => (
            <li key={p.id}>{p.receivedOn} · {p.kind} · {formatINR(p.amount)} · {p.mode.toUpperCase()}{p.reference && ` · ${p.reference}`}</li>
          ))}
        </ul>
      )}
      {waiting && remaining > 0 && (
        <div className="space-y-2 border-t border-white/[.06] pt-3">
          <p className="text-[11px] text-slate-500">Received the money by UPI, bank transfer or cash? Record it here. (The online payment page comes later.)</p>
          <div className="grid grid-cols-2 gap-2">
            <input type="number" min={1} value={amount} onChange={(e) => setAmount(e.target.value)} className={field} aria-label="Amount received" />
            <select value={mode} onChange={(e) => setMode(e.target.value as PaymentMode)} className={cn(field, "[&>option]:bg-[#121620]")} aria-label="Payment mode">
              {PAYMENT_MODES.map((m) => <option key={m} value={m}>{m.toUpperCase()}</option>)}
            </select>
            <input value={reference} onChange={(e) => setReference(e.target.value)} placeholder={mode === "cash" ? "Note (optional)" : "UTR / reference no."} className={field} />
            <input type="date" value={receivedOn} onChange={(e) => setReceivedOn(e.target.value)} className={field} aria-label="Date received" />
          </div>
          {error && <p className="text-xs text-rose-300">{error}</p>}
          <button onClick={save} disabled={busy} className="flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-500/90 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-50">
            {busy ? <Loader2 size={15} className="animate-spin" /> : <CheckCircle2 size={15} />} Record {kind} received
          </button>
          <p className="text-[11px] text-slate-500">Check the money is in your bank account before recording it.</p>
        </div>
      )}
      {waiting && kind === "advance" && lead.stage === "approved" && (
        <div className="space-y-2 border-t border-white/[.06] pt-3" data-testid="without-payment">
          {/* TEMP DEV: remove this checkbox block (and src/lib/dev-start.ts) once everything works and payments are enforced. */}
          <label className="flex cursor-pointer items-start gap-2.5 text-xs text-slate-200">
            <input type="checkbox" checked={skipChecked} onChange={(e) => setSkipChecked(e.target.checked)} disabled={skipBusy} className="mt-0.5 h-4 w-4 accent-violet-500" data-testid="without-payment-checkbox" />
            <span>
              <span className="font-semibold">Start without payment</span>
              <span className="mt-0.5 block text-[11px] text-slate-500">For development: generate the project now, without the advance. Runs on Local Claude Code, confirms the approved scope, and is recorded in the history.</span>
            </span>
          </label>
          {confirmSkip && (
            <GenerateConfirmDialog
              project={lead.requirement.title}
              client={lead.client.company || lead.client.name}
              content={null}
              advanceMissing={remaining > 0 ? remaining : null}
              demo
              mode="local"
              busy={skipBusy}
              onCancel={() => setConfirmSkip(false)}
              onConfirm={() => { setConfirmSkip(false); void startWithoutPayment(); }}
            />
          )}
          {skipChecked && (
            <button type="button" onClick={() => setConfirmSkip(true)} disabled={skipBusy} className="flex w-full items-center justify-center gap-2 rounded-lg border border-violet-400/50 bg-violet-500/15 px-3 py-2 text-sm font-semibold text-violet-100 hover:bg-violet-500/25 disabled:opacity-50" data-testid="start-without-payment">
              {skipBusy ? <Loader2 size={15} className="animate-spin" /> : <Hammer size={15} />} Start generating the project
            </button>
          )}
          {skipError && <p className="text-xs text-rose-300" data-testid="without-payment-error">{skipError}</p>}
        </div>
      )}
      {lead.stage === "advance_paid" && <p className="text-xs text-emerald-300">Advance received in full. Ready to start the work.</p>}
    </Card>
  );
}
