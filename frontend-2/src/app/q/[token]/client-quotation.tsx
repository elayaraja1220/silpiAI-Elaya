"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, ExternalLink, FileDown, Loader2, MessageSquare, MonitorPlay } from "lucide-react";

import { ClientChatWidget } from "@/components/business/client-chat-widget";
import { ClientAssets } from "@/components/business/client-assets";
import { QuotationDocument } from "@/components/business/quotation-document";
import type { TechPreview, TechSelection } from "@/lib/business/client-tech";
import type { ClientView, OpenPoint } from "@/lib/business/client-view";
import { upiLink } from "@/lib/business/payment-status";
import { MoneyProvider } from "@/components/business/money-context";
import { formatMoney, moneyOf } from "@/lib/business/money";
import type { Tier } from "@/lib/business/types";

import { TechnologyChooser } from "@/components/business/technology-chooser";

const card = "rounded-2xl border border-white/[.08] bg-white/[.03] p-5 sm:p-6";
const field = "mt-1 w-full rounded-lg border border-white/10 bg-[#141824] px-3 py-2 text-slate-100 outline-none placeholder:text-slate-500 focus:border-violet-400";
const ghost = "rounded-lg border border-white/15 px-3 py-2 text-sm text-slate-200 transition hover:bg-white/[.06]";

/** The client's page: settle any open points, compare the proposals, then approve one or ask for changes. */
export function ClientQuotation({ token, signedInName = "" }: { token: string; signedInName?: string }) {
  const [view, setView] = useState<ClientView | null>(null);
  const [error, setError] = useState("");
  const [tier, setTier] = useState<Tier | undefined>();
  const [mode, setMode] = useState<"approve" | "changes">("approve");
  const [name, setName] = useState(signedInName);
  const [message, setMessage] = useState("");
  const [agree, setAgree] = useState(false);
  const [agreeDeferred, setAgreeDeferred] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState("");
  // The technology the client picked on this page (a preview until they approve).
  const [techOpen, setTechOpen] = useState(false);
  const [techChoice, setTechChoice] = useState<{ tech: TechSelection; preview: TechPreview } | null>(null);
  // Open points: the answer being typed for each question, the point being saved, and any error.
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [settling, setSettling] = useState("");
  const [settleError, setSettleError] = useState("");

  useEffect(() => {
    fetch(`/api/client/${encodeURIComponent(token)}`)
      .then((r) => r.json())
      .then((r: { success: boolean; view?: ClientView; error?: string }) => {
        if (!r.success || !r.view) throw new Error(r.error || "This quotation link is not valid.");
        setView(r.view);
        setTier(r.view.quotation.tier);
      })
      .catch((e: Error) => setError(e.message));
  }, [token]);

  const submit = async () => {
    setBusy(true);
    setFormError("");
    try {
      const response = await fetch(`/api/client/${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: mode === "approve" ? "approved" : "changes_requested", tier, name, message, agree, acknowledgeDeferred: agreeDeferred, ...(mode === "approve" && techChoice ? { tech: techChoice.tech } : {}) }),
      });
      const r = (await response.json().catch(() => ({}))) as { success?: boolean; view?: ClientView; error?: string };
      if (!r.success || !r.view) throw new Error(r.error || "Could not send your answer. Please try again.");
      setView(r.view);
      setMessage("");
      setTechChoice(null);
    } catch (e) {
      setFormError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /** Settles one open point; including an addition changes the price, so a technology preview is cleared and the new prices are shown. */
  const settle = async (point: OpenPoint, action: "agree" | "include" | "leave-out" | "answer") => {
    setSettling(point.id);
    setSettleError("");
    try {
      const response = await fetch(`/api/client/${encodeURIComponent(token)}/settle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemId: point.id, action, answer: answers[point.id] ?? "" }),
      });
      const r = (await response.json().catch(() => ({}))) as { success?: boolean; view?: ClientView; error?: string };
      if (!r.success || !r.view) throw new Error(r.error || "Could not save that. Please try again.");
      setView(r.view);
      if (!r.view.quotation.proposals?.some((p) => p.tier === tier)) setTier(r.view.quotation.tier);
      setTechChoice(null);
    } catch (e) {
      setSettleError((e as Error).message);
    } finally {
      setSettling("");
    }
  };

  if (error) {
    return <p className="mx-auto max-w-lg rounded-2xl border border-white/[.08] bg-white/[.03] p-6 text-center text-sm text-slate-300">{error}</p>;
  }
  if (!view) {
    return (
      <div className="flex justify-center py-20 text-slate-400">
        <Loader2 className="animate-spin" />
      </div>
    );
  }

  const q = view.quotation;
  // Amounts are held in rupees; this client is shown them in the currency they were quoted in.
  const fmt = (n: number) => formatMoney(n, moneyOf(q));
  const proposals = q.proposals ?? [];
  const chosen = proposals.find((p) => p.tier === tier);
  // With a technology choice, every package has a new price from the server; without one, the quoted prices.
  const priceOf = (t: Tier | undefined, fallback: number) => (techChoice && t ? techChoice.preview.tiers[t] ?? fallback : fallback);
  const total = priceOf(tier, chosen?.grandTotal ?? q.grandTotal);
  const advance = Math.round((total * (q.schedule[0]?.percent ?? 50)) / 100);
  const response = view.response;
  const approved = view.stage !== "quoted" && view.stage !== "lost" && response?.action === "approved";
  const openPoints = view.openPoints ?? [];
  const step = (n: number) => (q.hourly ? "" : `${openPoints.length ? n + 1 : n}. `);

  // Why "Approve" cannot be pressed yet, in words, so the client knows what is left to do.
  const missing: string[] = [];
  if (mode === "approve") {
    if (view.preliminary) missing.push(openPoints.length ? `Settle the ${openPoints.length} open point${openPoints.length === 1 ? "" : "s"} under "Before you approve" above.` : "We are still confirming some details; we will tell you as soon as this can be approved.");
    if (!name.trim()) missing.push("Type your full name.");
    if (!agree) missing.push("Tick the box to agree to the price and the advance.");
    if (view.deferred?.length && !agreeDeferred) missing.push('Tick the box about the items "Not included in this price".');
  } else {
    if (!name.trim()) missing.push("Type your full name.");
    if (message.trim().length < 5) missing.push("Tell us what you would like to change (a few words at least).");
  }

  return (
    <MoneyProvider quote={q}>
      <div className="mx-auto max-w-4xl space-y-6">
        <header className="no-print flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-[.2em] text-violet-300">Fixed price · Quotation {view.number}</p>
            <h1 className="mt-1 text-2xl font-semibold text-white">{view.requirement.title}</h1>
            <p className="text-sm text-slate-400">from {q.business.name}</p>
          </div>
          <div className="flex gap-2">
            <a href={`/api/client/${encodeURIComponent(token)}/document?format=pdf`} className={`flex items-center gap-1.5 ${ghost}`}><FileDown size={15} /> PDF</a>
            <a href={`/api/client/${encodeURIComponent(token)}/document?format=docx`} className={`flex items-center gap-1.5 ${ghost}`}><FileDown size={15} /> Word</a>
          </div>
        </header>

        {approved && (
          <section className="no-print rounded-2xl border border-emerald-400/30 bg-emerald-500/10 p-5">
            <p className="flex items-center gap-2 font-semibold text-emerald-300"><CheckCircle2 size={18} /> Approved{response?.tier ? `: ${response.tier} proposal` : ""}. Thank you, {response?.name}!</p>
            {view.payment && view.payment.advanceRemaining <= 0 ? (
              <p className="mt-1 text-sm text-emerald-100/90">Advance received. Thank you! {view.stage === "advance_paid" ? "Work starts shortly" : "Work is in progress"}; you will see a demo of every page before the balance is due.</p>
            ) : view.stage === "in_development" ? (
              <p className="mt-1 text-sm text-emerald-100/90">Work has started. Please pay the advance of {fmt(view.payment?.advanceRemaining ?? 0)} below.</p>
            ) : (
              <p className="mt-1 text-sm text-emerald-100/90">Next step: the advance of {fmt(view.payment?.advanceRemaining ?? q.schedule[0]?.amount ?? 0)} starts the work.{q.hourly ? " You can ask for the log of hours worked at any time." : " You will see a demo of every page before the balance is due."}</p>
            )}
          </section>
        )}

        {approved && view.payment && view.payment.advanceRemaining > 0 && (
          <section className={`no-print ${card}`}>
            <h2 className="font-semibold text-white">Pay the advance: {fmt(view.payment.advanceRemaining)}</h2>
            <p className="mt-1 text-sm text-slate-400">Please write <b className="text-slate-200">{view.payment.reference}</b> in the payment note so we can match it. We confirm by message once it reaches our account.</p>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              {view.payment.upiId && (
                <div className="rounded-xl border border-white/10 p-4">
                  <p className="text-xs uppercase tracking-wider text-slate-500">UPI</p>
                  <p className="mt-1 font-mono text-base text-white">{view.payment.upiId}</p>
                  <a
                    href={upiLink(view.payment.upiId, view.payment.payee, view.payment.advanceRemaining, view.payment.reference)}
                    className="mt-3 inline-flex rounded-lg bg-violet-500 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-400"
                  >
                    Pay with UPI app
                  </a>
                  <p className="mt-2 text-[11px] text-slate-500">The button works on a phone with any UPI app. On a computer, pay to the UPI ID above from your phone.</p>
                </div>
              )}
              {view.payment.bankDetails && (
                <div className="rounded-xl border border-white/10 p-4">
                  <p className="text-xs uppercase tracking-wider text-slate-500">Bank transfer</p>
                  <p className="mt-1 whitespace-pre-line text-sm text-slate-200">{view.payment.bankDetails}</p>
                </div>
              )}
              {!view.payment.upiId && !view.payment.bankDetails && <p className="text-sm text-slate-400">We will send the payment details to you shortly.</p>}
            </div>
          </section>
        )}
        {view.demo && (
          <section className="no-print rounded-2xl border border-violet-400/30 bg-violet-500/10 p-5">
            <h2 className="flex items-center gap-2 font-semibold text-violet-200"><MonitorPlay size={18} /> Preview your website</h2>
            <p className="mt-1 text-sm text-violet-100/80">
              We have prepared a private demo of your website. It is for you to look through and is clearly marked as a demo. It is open until {new Date(view.demo.expiresAt).toLocaleDateString("en-IN", { day: "2-digit", month: "long", year: "numeric" })}.
              {view.demo.protected ? " It is protected: please ask us for the password." : ""}
            </p>
            <a href={view.demo.url} target="_blank" rel="noreferrer" className="mt-3 inline-flex items-center gap-2 rounded-lg bg-violet-500 px-4 py-2.5 text-sm font-semibold text-white hover:bg-violet-400"><ExternalLink size={15} /> Open the demo</a>
          </section>
        )}
        {/* The files section uses the full width of the client area (menu, item, status box), wider than the rest of this page. */}
        {approved && <div className="no-print relative left-1/2 w-[min(72rem,calc(100vw-2rem))] -translate-x-1/2 lg:w-[min(72rem,calc(100vw-20rem))]"><ClientAssets token={token} /></div>}
        {!approved && view.preliminary && view.open && (
          <p data-testid="preliminary-banner" className="no-print rounded-xl border border-amber-400/30 bg-amber-500/10 p-4 text-sm text-amber-100">
            <b>Preliminary estimate.</b> A few details of your project are still open, so this price may change. {openPoints.length ? "Settle them just below and the quotation can be approved." : "We will confirm them with you; you can ask for changes now."}
          </p>
        )}
        {!approved && view.deferred && view.deferred.length > 0 && view.open && (
          <section data-testid="deferred-banner" className="no-print rounded-2xl border border-amber-400/40 bg-amber-500/10 p-5 text-sm text-amber-100">
            <h2 className="font-semibold text-amber-200">Not included in this price</h2>
            <p className="mt-1">We do not yet have enough clear information to estimate the items below, so they are <b>not</b> in the price shown. Once they are clear, we will send you a separate quotation for them. The rest of the project can start now.</p>
            <ul className="mt-2 list-disc space-y-0.5 pl-5">{view.deferred.map((d) => <li key={d}>{d}</li>)}</ul>
          </section>
        )}
        {!approved && view.expired && (
          <p className="no-print rounded-xl border border-amber-400/30 bg-amber-500/10 p-4 text-sm text-amber-100">This quotation has expired. Please contact us for an updated one.</p>
        )}
        {!approved && response?.action === "changes_requested" && view.open && (
          <p className="no-print rounded-xl border border-sky-400/30 bg-sky-500/10 p-4 text-sm text-sky-100">
            We received your change request ({new Date(response.at).toLocaleDateString("en-IN")}). We will send a revised quotation; you can still approve this one below.
          </p>
        )}

        {view.open && openPoints.length > 0 && (
          <section className={`no-print ${card}`} data-testid="open-points">
            <h2 className="font-semibold text-white">1. Before you approve</h2>
            <p className="mt-1 text-sm text-slate-400">Please settle these {openPoints.length} point{openPoints.length === 1 ? "" : "s"}. Adding a suggested item changes the price; you will see the new price straight away.</p>
            <ul className="mt-4 space-y-3">
              {openPoints.map((p) => (
                <li key={p.id} className="rounded-xl border border-white/10 bg-[#141824] p-4" data-testid="open-point">
                  <p className="text-[11px] uppercase tracking-wider text-violet-300">{p.kind === "question" ? "Question for you" : p.kind === "assumption" ? "Our assumption" : "Suggested addition"}</p>
                  <p className="mt-1 text-sm text-slate-100">{p.text}</p>
                  {p.kind === "question" && (
                    <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                      <input value={answers[p.id] ?? ""} onChange={(e) => setAnswers((a) => ({ ...a, [p.id]: e.target.value }))} maxLength={1000} placeholder="Your answer" className={`${field.replace("mt-1 ", "")} flex-1`} />
                      <button type="button" disabled={!!settling || (answers[p.id] ?? "").trim().length < 2} onClick={() => void settle(p, "answer")} className="rounded-lg bg-violet-500 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-400 disabled:opacity-50">
                        {settling === p.id ? <Loader2 size={15} className="animate-spin" /> : "Send answer"}
                      </button>
                    </div>
                  )}
                  {p.kind === "assumption" && (
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button type="button" disabled={!!settling} onClick={() => void settle(p, "agree")} className="rounded-lg bg-violet-500 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-400 disabled:opacity-50">{settling === p.id ? <Loader2 size={15} className="animate-spin" /> : "I agree"}</button>
                      <button type="button" onClick={() => { setMode("changes"); setMessage(`About "${p.text.slice(0, 120)}": `); document.getElementById("your-answer")?.scrollIntoView({ behavior: "smooth" }); }} className={ghost}>That is not right</button>
                    </div>
                  )}
                  {p.kind === "proposal" && (
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button type="button" disabled={!!settling} onClick={() => void settle(p, "include")} className="rounded-lg bg-violet-500 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-400 disabled:opacity-50">{settling === p.id ? <Loader2 size={15} className="animate-spin" /> : "Include it"}</button>
                      <button type="button" disabled={!!settling} onClick={() => void settle(p, "leave-out")} className={`${ghost} disabled:opacity-50`}>Leave it out</button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
            {settleError && <p className="mt-3 rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-300">{settleError}</p>}
          </section>
        )}

        {view.open && (
          <section className={`no-print ${card}`}>
            {!q.hourly && <h2 className="font-semibold text-white">{step(1)}Choose a proposal</h2>}
            {q.hourly && <p className="text-sm text-slate-400">This is an hourly engagement: you pay for the hours actually worked, up to the cap shown below.</p>}
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              {proposals.map((p) => (
                <button
                  key={p.tier}
                  type="button"
                  onClick={() => setTier(p.tier)}
                  aria-pressed={tier === p.tier}
                  className={`rounded-xl border p-4 text-left transition ${tier === p.tier ? "border-violet-400 bg-violet-500/10 ring-2 ring-violet-400/30" : "border-white/10 hover:border-white/25"}`}
                >
                  <p className="font-semibold text-white">{p.title}{p.tier === "standard" && <span className="ml-2 rounded-full bg-violet-500/20 px-2 py-0.5 text-[10px] font-medium text-violet-200">Recommended</span>}</p>
                  <p className="text-xs text-slate-400">{p.tagline}</p>
                  <p className="mt-2 text-lg font-semibold tabular-nums text-white">{fmt(priceOf(p.tier, p.grandTotal))}</p>
                  <p className="text-[11px] text-slate-500">incl. GST · about {p.estimatedWeeks} week{p.estimatedWeeks === 1 ? "" : "s"}</p>
                  <ul className="mt-2 space-y-0.5 text-xs text-slate-300">
                    <li>{p.pages.length} page{p.pages.length === 1 ? "" : "s"}</li>
                    {p.features.map((f) => <li key={f}>✓ {f}</li>)}
                  </ul>
                  {p.leftOut.length > 0 && <p className="mt-2 text-[11px] text-slate-500">Not included: {p.leftOut.join("; ")}</p>}
                </button>
              ))}
            </div>

            {techChoice && (
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-violet-400/30 bg-violet-500/10 px-4 py-3 text-sm text-violet-100" data-testid="tech-banner">
                <p>
                  <b>Your technology:</b> {techChoice.preview.stack.frontend} · {techChoice.preview.stack.backend} · {techChoice.preview.stack.database}.
                  {" "}Price {techChoice.preview.delta === 0 ? "is unchanged" : techChoice.preview.delta > 0 ? `goes up by ${fmt(techChoice.preview.delta)}` : `goes down by ${fmt(-techChoice.preview.delta)}`} (final total {fmt(total)} incl. GST).
                </p>
                <span className="flex gap-2">
                  <button type="button" onClick={() => setTechOpen(true)} className="rounded-lg border border-violet-400/40 px-3 py-1.5 text-xs font-medium hover:bg-violet-500/20">Change</button>
                  <button type="button" onClick={() => setTechChoice(null)} className="rounded-lg border border-violet-400/40 px-3 py-1.5 text-xs font-medium hover:bg-violet-500/20">Remove my choice</button>
                </span>
              </div>
            )}

            {!q.hourly && !techChoice && (
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-emerald-400/25 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-100" data-testid="tech-hint">
                <p>Prefer a different frontend, backend or database? Choose your own technology and see how the price changes.</p>
                <button type="button" onClick={() => setTechOpen(true)} className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-[#0e1118] hover:bg-emerald-400">Choose technology</button>
              </div>
            )}

            <h2 id="your-answer" className="mt-8 scroll-mt-24 font-semibold text-white">{step(2)}Your answer</h2>
            <div className="mt-3 flex gap-2">
              <button type="button" onClick={() => setMode("approve")} className={`rounded-lg px-3 py-2 text-sm ${mode === "approve" ? "bg-white text-[#0e1118]" : "border border-white/15 text-slate-200"}`}>Approve & confirm</button>
              <button type="button" onClick={() => setMode("changes")} className={`flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm ${mode === "changes" ? "bg-white text-[#0e1118]" : "border border-white/15 text-slate-200"}`}><MessageSquare size={14} /> Request changes</button>
            </div>
            <div className="mt-4 space-y-3">
              <label className="block text-sm text-slate-300">
                Your full name
                <input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} className={field} />
              </label>
              <label className="block text-sm text-slate-300">
                {mode === "approve" ? "Message (optional)" : "What would you like to change?"}
                <textarea value={message} onChange={(e) => setMessage(e.target.value)} maxLength={2000} rows={3} className={field} />
              </label>
              {mode === "approve" && (
                <label className="flex items-start gap-2 text-sm text-slate-300">
                  <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} className="mt-1 accent-violet-500" />
                  <span>
                    {q.hourly ? (
                      <>I approve this hourly engagement at {fmt(q.hourly.rate)} per hour (estimate {fmt(q.hourly.expectedTotal)} incl. GST). I understand I will be billed for the hours actually worked, that hours beyond {q.hourly.capHours} ({fmt(q.hourly.capTotal)}) need my written approval, and I agree to pay the {q.schedule[0]?.percent ?? 50}% advance of {fmt(advance)} to start the work.</>
                    ) : (
                      <>I approve the <b className="capitalize text-white">{tier}</b> proposal for {fmt(total)} (incl. GST) and agree to pay the {q.schedule[0]?.percent ?? 50}% advance of {fmt(advance)} to start the work.</>
                    )}
                  </span>
                </label>
              )}
              {mode === "approve" && view.deferred && view.deferred.length > 0 && (
                <label className="flex items-start gap-2 rounded-lg border border-amber-400/30 bg-amber-500/10 p-3 text-sm text-amber-100" data-testid="deferred-ack">
                  <input type="checkbox" checked={agreeDeferred} onChange={(e) => setAgreeDeferred(e.target.checked)} className="mt-1 accent-amber-500" />
                  <span>I understand that the {view.deferred.length} item{view.deferred.length === 1 ? "" : "s"} listed under &quot;Not included in this price&quot; are not part of this quotation and will be quoted separately.</span>
                </label>
              )}
              {formError && <p className="rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-300">{formError}</p>}
              <button
                type="button"
                onClick={submit}
                disabled={busy || missing.length > 0}
                className="flex items-center gap-2 rounded-lg bg-violet-500 px-5 py-2.5 text-sm font-semibold text-white hover:bg-violet-400 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy && <Loader2 size={15} className="animate-spin" />} {mode === "approve" ? "Approve & confirm project" : "Send change request"}
              </button>
              {missing.length > 0 && (
                <ul className="space-y-0.5 text-xs text-slate-400" data-testid="approve-missing">
                  {missing.map((m) => <li key={m}>• {m}</li>)}
                </ul>
              )}
            </div>
          </section>
        )}

        <QuotationDocument
          quotation={q}
          requirement={q.requirement!}
          running={view.running}
          deferred={view.deferred}
          techAction={view.open && !q.hourly ? { onChoose: () => setTechOpen(true), chosen: techChoice?.preview.stack ?? null } : undefined}
        />
        {techOpen && <div className="no-print"><TechnologyChooser endpoint={`/api/client/${encodeURIComponent(token)}/technology`} tier={tier ?? "standard"} value={techChoice?.tech ?? null} onClose={() => setTechOpen(false)} onApply={(t, preview) => { setTechChoice({ tech: t, preview }); setTechOpen(false); }} /></div>}
        <p className="no-print pb-6 text-center text-xs text-slate-500">This page is private to you. Please do not share the link.</p>
        <div className="no-print"><ClientChatWidget token={token} businessName={q.business.name} /></div>
      </div>
    </MoneyProvider>
  );
}
