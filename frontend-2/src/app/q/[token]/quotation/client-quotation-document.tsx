"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Check, Copy, FileDown, FileText, Loader2, Mail, MessageCircle, Printer } from "lucide-react";

import { MoneyProvider } from "@/components/business/money-context";
import { QuotationDocument } from "@/components/business/quotation-document";
import type { ClientView } from "@/lib/business/client-view";
import { mailtoLink, quotationMessage, whatsappLink } from "@/lib/share-quotation";

const ghost = "inline-flex items-center gap-1.5 rounded-lg border border-white/15 px-3 py-2 text-sm text-slate-200 transition hover:bg-white/[.06]";

/**
 * The full quotation, on its own page. At the top it says clearly which quotation this is, with the PDF to download, Print, and the quotation link ready to send to the
 * client's own WhatsApp number or e-mail address (the ones on the quotation); WhatsApp and the mail program open with the message written and the person presses send.
 * Only the quotation itself is printed.
 */
export function ClientQuotationDocument({ token }: { token: string }) {
  const [view, setView] = useState<ClientView | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    fetch(`/api/client/${encodeURIComponent(token)}`)
      .then((r) => r.json())
      .then((r: { success: boolean; view?: ClientView; error?: string }) => {
        if (!r.success || !r.view) throw new Error(r.error || "This quotation link is not valid.");
        setView(r.view);
      })
      .catch((e: Error) => setError(e.message));
  }, [token]);

  if (error) return <p className="mx-auto max-w-lg rounded-2xl border border-white/[.08] bg-white/[.03] p-6 text-center text-sm text-slate-300">{error}</p>;
  if (!view) return <div className="flex justify-center py-20 text-slate-400"><Loader2 className="animate-spin" /></div>;

  const q = view.quotation;
  const back = `/q/${encodeURIComponent(token)}`;
  const link = `${window.location.origin}${back}`;
  const text = quotationMessage({ name: q.client.name, number: view.number, title: view.requirement.title, business: q.business.name, link, validUntil: q.validUntil });
  const copy = async () => {
    await navigator.clipboard.writeText(link).catch(() => undefined);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <MoneyProvider quote={q}>
      <div className="mx-auto max-w-4xl space-y-6">
        <div className="no-print space-y-4">
          <Link href={back} className="inline-flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200"><ArrowLeft size={14} /> Back to your quotation</Link>
          <header className="flex flex-wrap items-end justify-between gap-4">
            <div className="min-w-0">
              <p className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1.5 rounded-md border border-violet-400/40 bg-violet-500/15 px-2.5 py-1 text-xs font-semibold tracking-wide text-violet-100" data-testid="quotation-number"><FileText size={13} /> Quotation {view.number}</span>
                <span className="text-xs text-slate-400">valid until {new Date(q.validUntil).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}</span>
              </p>
              <h1 className="mt-2 text-2xl font-semibold text-white">{view.requirement.title}</h1>
              <p className="text-sm text-slate-400">from {q.business.name}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <a href={`/api/client/${encodeURIComponent(token)}/document?format=pdf`} className={ghost} data-testid="quotation-pdf"><FileDown size={15} /> PDF</a>
              <button type="button" onClick={() => window.print()} className={ghost} data-testid="quotation-print"><Printer size={15} /> Print</button>
            </div>
          </header>

          <section className="rounded-2xl border border-white/[.08] bg-white/[.03] p-4" aria-label="Send this quotation" data-testid="share-quotation">
            <p className="text-sm font-medium text-slate-100">Send this quotation</p>
            <p className="mt-0.5 text-xs text-slate-400">WhatsApp or your mail program opens with the message ready. You press send.</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <a href={whatsappLink(q.client.phone, text)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 rounded-lg border border-emerald-400/35 bg-emerald-500/10 px-3.5 py-2 text-sm text-emerald-200 transition hover:bg-emerald-500/20" data-testid="share-whatsapp">
                <MessageCircle size={16} /> WhatsApp{q.client.phone ? <span className="text-emerald-100/70"> · {q.client.phone}</span> : null}
              </a>
              <a href={mailtoLink(q.client.email, `Quotation ${view.number} from ${q.business.name}`, text)} className={`${ghost} px-3.5`} data-testid="share-email">
                <Mail size={16} /> Email{q.client.email ? <span className="text-slate-400"> · {q.client.email}</span> : null}
              </a>
              <button type="button" onClick={() => void copy()} className={`${ghost} px-3.5`} aria-label="Copy the link">{copied ? <Check size={16} /> : <Copy size={16} />} {copied ? "Copied" : "Copy link"}</button>
            </div>
            <p className="mt-2 text-[11px] text-slate-500">Anyone who has this link can see the quotation. Send it only to people you trust.</p>
          </section>
        </div>

        <QuotationDocument quotation={q} requirement={q.requirement!} running={view.running} deferred={view.deferred} />
        <p className="no-print pb-6 text-center text-xs text-slate-500">This page is private to you. Please do not share the link with anyone you do not trust.</p>
      </div>
    </MoneyProvider>
  );
}
