"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, ExternalLink, FileDown, Loader2, MessageSquare, MonitorPlay } from "lucide-react";

import { ClientAssets } from "@/components/business/client-assets";
import { QuotationDocument } from "@/components/business/quotation-document";
import type { ClientView } from "@/lib/business/client-view";
import { upiLink } from "@/lib/business/payment-status";
import { formatINR } from "@/lib/business/pricing";
import type { Tier } from "@/lib/business/types";

/** The client's page: compare the proposals, then approve one or ask for changes. */
export function ClientQuotation({ token }: { token: string }) {
  const [view, setView] = useState<ClientView | null>(null);
  const [error, setError] = useState("");
  const [tier, setTier] = useState<Tier | undefined>();
  const [mode, setMode] = useState<"approve" | "changes">("approve");
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState("");

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
        body: JSON.stringify({ action: mode === "approve" ? "approved" : "changes_requested", tier, name, message, agree }),
      });
      const r = (await response.json().catch(() => ({}))) as { success?: boolean; view?: ClientView; error?: string };
      if (!r.success || !r.view) throw new Error(r.error || "Could not send your answer. Please try again.");
      setView(r.view);
      setMessage("");
    } catch (e) {
      setFormError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (error) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-100 p-6 text-slate-700">
        <p className="rounded-xl bg-white p-6 text-sm shadow">{error}</p>
      </main>
    );
  }
  if (!view) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-100 text-slate-500">
        <Loader2 className="animate-spin" />
      </main>
    );
  }

  const q = view.quotation;
  const proposals = q.proposals ?? [];
  const chosen = proposals.find((p) => p.tier === tier);
  const total = chosen?.grandTotal ?? q.grandTotal;
  const advance = Math.round((total * (q.schedule[0]?.percent ?? 50)) / 100);
  const response = view.response;
  const approved = view.stage !== "quoted" && view.stage !== "lost" && response?.action === "approved";

  return (
    <main className="min-h-screen bg-slate-100 px-4 py-8 text-slate-800 sm:py-12">
      <div className="mx-auto max-w-4xl space-y-6">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-[.2em] text-violet-600">Quotation {view.number}</p>
            <h1 className="text-xl font-semibold text-slate-900">{view.requirement.title}</h1>
            <p className="text-sm text-slate-500">from {q.business.name}</p>
          </div>
          <div className="flex gap-2">
            <a href={`/api/client/${encodeURIComponent(token)}/document?format=pdf`} className="flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm hover:bg-slate-50"><FileDown size={15} /> PDF</a>
            <a href={`/api/client/${encodeURIComponent(token)}/document?format=docx`} className="flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm hover:bg-slate-50"><FileDown size={15} /> Word</a>
          </div>
        </header>

        {approved && (
          <section className="rounded-2xl border border-emerald-300 bg-emerald-50 p-5">
            <p className="flex items-center gap-2 font-semibold text-emerald-800"><CheckCircle2 size={18} /> Approved{response?.tier ? `: ${response.tier} proposal` : ""}. Thank you, {response?.name}!</p>
            {view.payment && view.payment.advanceRemaining <= 0 ? (
              <p className="mt-1 text-sm text-emerald-900">Advance received. Thank you! {view.stage === "advance_paid" ? "Work starts shortly" : "Work is in progress"}; you will see a demo of every page before the balance is due.</p>
            ) : view.stage === "in_development" ? (
              <p className="mt-1 text-sm text-emerald-900">Work has started. Please pay the advance of {formatINR(view.payment?.advanceRemaining ?? 0)} below.</p>
            ) : (
              <p className="mt-1 text-sm text-emerald-900">Next step: the advance of {formatINR(view.payment?.advanceRemaining ?? q.schedule[0]?.amount ?? 0)} starts the work. You will see a demo of every page before the balance is due.</p>
            )}
          </section>
        )}

        {approved && view.payment && view.payment.advanceRemaining > 0 && (
          <section className="rounded-2xl bg-white p-5 shadow-sm">
            <h2 className="font-semibold text-slate-900">Pay the advance: {formatINR(view.payment.advanceRemaining)}</h2>
            <p className="mt-1 text-sm text-slate-500">Please write <b>{view.payment.reference}</b> in the payment note so we can match it. We confirm by message once it reaches our account.</p>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              {view.payment.upiId && (
                <div className="rounded-xl border border-slate-200 p-4">
                  <p className="text-xs uppercase tracking-wider text-slate-400">UPI</p>
                  <p className="mt-1 font-mono text-base text-slate-900">{view.payment.upiId}</p>
                  <a
                    href={upiLink(view.payment.upiId, view.payment.payee, view.payment.advanceRemaining, view.payment.reference)}
                    className="mt-3 inline-flex rounded-lg bg-violet-600 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-500"
                  >
                    Pay with UPI app
                  </a>
                  <p className="mt-2 text-[11px] text-slate-400">The button works on a phone with GPay, PhonePe or Paytm. On a computer, pay to the UPI ID above from your phone.</p>
                </div>
              )}
              {view.payment.bankDetails && (
                <div className="rounded-xl border border-slate-200 p-4">
                  <p className="text-xs uppercase tracking-wider text-slate-400">Bank transfer</p>
                  <p className="mt-1 whitespace-pre-line text-sm text-slate-800">{view.payment.bankDetails}</p>
                </div>
              )}
              {!view.payment.upiId && !view.payment.bankDetails && <p className="text-sm text-slate-600">We will send the payment details to you shortly.</p>}
            </div>
          </section>
        )}
        {view.demo && (
          <section className="rounded-2xl border border-violet-300 bg-violet-50 p-5">
            <h2 className="flex items-center gap-2 font-semibold text-violet-900"><MonitorPlay size={18} /> Preview your website</h2>
            <p className="mt-1 text-sm text-violet-900/80">
              We have prepared a private demo of your website. It is for you to look through and is clearly marked as a demo. It is open until {new Date(view.demo.expiresAt).toLocaleDateString("en-IN", { day: "2-digit", month: "long", year: "numeric" })}.
              {view.demo.protected ? " It is protected: please ask us for the password." : ""}
            </p>
            <a href={view.demo.url} target="_blank" rel="noreferrer" className="mt-3 inline-flex items-center gap-2 rounded-lg bg-violet-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-violet-500"><ExternalLink size={15} /> Open the demo</a>
          </section>
        )}
        {approved && <ClientAssets token={token} />}
        {!approved && view.expired && (
          <p className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">This quotation has expired. Please contact us for an updated one.</p>
        )}
        {!approved && response?.action === "changes_requested" && view.open && (
          <p className="rounded-xl border border-sky-300 bg-sky-50 p-4 text-sm text-sky-900">
            We received your change request ({new Date(response.at).toLocaleDateString("en-IN")}). We will send a revised quotation; you can still approve this one below.
          </p>
        )}

        {view.open && (
          <section className="rounded-2xl bg-white p-5 shadow-sm sm:p-6">
            <h2 className="font-semibold text-slate-900">1. Choose a proposal</h2>
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              {proposals.map((p) => (
                <button
                  key={p.tier}
                  type="button"
                  onClick={() => setTier(p.tier)}
                  aria-pressed={tier === p.tier}
                  className={`rounded-xl border p-4 text-left transition ${tier === p.tier ? "border-violet-500 bg-violet-50 ring-2 ring-violet-200" : "border-slate-200 hover:border-slate-300"}`}
                >
                  <p className="font-semibold text-slate-900">{p.title}{p.tier === "standard" && <span className="ml-2 rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-medium text-violet-700">Recommended</span>}</p>
                  <p className="text-xs text-slate-500">{p.tagline}</p>
                  <p className="mt-2 text-lg font-semibold tabular-nums">{formatINR(p.grandTotal)}</p>
                  <p className="text-[11px] text-slate-500">incl. GST · about {p.estimatedWeeks} week{p.estimatedWeeks === 1 ? "" : "s"}</p>
                  <ul className="mt-2 space-y-0.5 text-xs text-slate-600">
                    <li>{p.pages.length} page{p.pages.length === 1 ? "" : "s"}</li>
                    {p.features.map((f) => <li key={f}>✓ {f}</li>)}
                  </ul>
                  {p.leftOut.length > 0 && <p className="mt-2 text-[11px] text-slate-400">Not included: {p.leftOut.join("; ")}</p>}
                </button>
              ))}
            </div>

            <h2 className="mt-6 font-semibold text-slate-900">2. Your answer</h2>
            <div className="mt-3 flex gap-2">
              <button type="button" onClick={() => setMode("approve")} className={`rounded-lg px-3 py-2 text-sm ${mode === "approve" ? "bg-slate-900 text-white" : "border border-slate-300"}`}>Approve & confirm</button>
              <button type="button" onClick={() => setMode("changes")} className={`flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm ${mode === "changes" ? "bg-slate-900 text-white" : "border border-slate-300"}`}><MessageSquare size={14} /> Request changes</button>
            </div>
            <div className="mt-4 space-y-3">
              <label className="block text-sm">
                Your full name
                <input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 outline-none focus:border-violet-500" />
              </label>
              <label className="block text-sm">
                {mode === "approve" ? "Message (optional)" : "What would you like to change?"}
                <textarea value={message} onChange={(e) => setMessage(e.target.value)} maxLength={2000} rows={3} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 outline-none focus:border-violet-500" />
              </label>
              {mode === "approve" && (
                <label className="flex items-start gap-2 text-sm text-slate-600">
                  <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} className="mt-1 accent-violet-600" />
                  <span>
                    I approve the <b className="capitalize">{tier}</b> proposal for {formatINR(total)} (incl. GST) and agree to pay the {q.schedule[0]?.percent ?? 50}% advance of {formatINR(advance)} to start the work.
                  </span>
                </label>
              )}
              {formError && <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{formError}</p>}
              <button
                type="button"
                onClick={submit}
                disabled={busy || !name.trim() || (mode === "approve" ? !agree : message.trim().length < 5)}
                className="flex items-center gap-2 rounded-lg bg-violet-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-violet-500 disabled:opacity-50"
              >
                {busy && <Loader2 size={15} className="animate-spin" />} {mode === "approve" ? "Approve & confirm project" : "Send change request"}
              </button>
            </div>
          </section>
        )}

        <QuotationDocument quotation={q} requirement={q.requirement!} running={view.running} />
        <p className="pb-6 text-center text-xs text-slate-400">This page is private to you. Please do not share the link.</p>
      </div>
    </main>
  );
}
