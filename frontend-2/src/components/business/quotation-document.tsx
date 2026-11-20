import { formatINR } from "@/lib/business/pricing";
import { seoAdvice } from "@/lib/business/seo";

import { ComparisonTable } from "./comparison-table";
import { ServicesSummary } from "./services-summary";
import type { Quote, Quotation, Requirement } from "@/lib/business/types";

const date = (iso: string) => new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });

/** Totals block shared by the live estimate and the printed quotation. */
export function QuoteTotals({ quote }: { quote: Quote }) {
  const row = (label: string, value: number, strong = false) => (
    <div className={`flex justify-between gap-4 py-1 ${strong ? "mt-1 border-t border-slate-400/30 pt-2 text-base font-semibold" : ""}`}>
      <span>{label}</span>
      <span className="tabular-nums">{formatINR(value)}</span>
    </div>
  );
  return (
    <div className="text-sm">
      {row("Development subtotal", quote.subtotal)}
      {row("Discount", quote.discount > 0 ? -quote.discount : 0)}
      {row("Taxable value", quote.taxable)}
      {quote.gst.mode === "intra" && (
        <>
          {row(`CGST @ ${quote.gst.rate / 2}%`, quote.gst.cgst)}
          {row(`SGST @ ${quote.gst.rate / 2}%`, quote.gst.sgst)}
        </>
      )}
      {quote.gst.mode === "inter" && row(`IGST @ ${quote.gst.rate}%`, quote.gst.igst)}
      {quote.gst.mode === "export" && (
        <div className="flex justify-between py-1 text-xs opacity-70">
          <span>GST: export of services (zero-rated, under LUT)</span>
          <span>{formatINR(0)}</span>
        </div>
      )}
      {quote.roundOff !== 0 && row("Round off", quote.roundOff)}
      {row("Grand total", quote.grandTotal, true)}
      <div className="mt-2 space-y-0.5 border-t border-current/10 pt-2 text-xs opacity-75">
        <div className="flex justify-between gap-3"><span>Domain name</span><span>Not included</span></div>
        <div className="flex justify-between gap-3"><span>Hosting</span><span>Not included</span></div>
        <p className="pt-1 text-[11px] opacity-80">Buy separately, for example from Hostinger or GoDaddy.</p>
      </div>
    </div>
  );
}

/**
 * Printable quotation. Light colours on purpose: it is what the client sees
 * and what "Print / Save as PDF" produces.
 */
export function QuotationDocument({ quotation, requirement: requested }: { quotation: Quotation; requirement: Requirement }) {
  const { business, client } = quotation;
  // The priced scope is the chosen proposal; older quotations only have the request.
  const requirement = quotation.requirement ?? requested;
  const seo = quotation.seo ?? seoAdvice(requirement);
  return (
    <article className="print-area rounded-2xl bg-white p-6 text-slate-800 shadow-xl sm:p-10">
      <header className="flex flex-wrap items-start justify-between gap-6 border-b border-slate-200 pb-6">
        <div>
          <h2 className="text-xl font-bold text-slate-900">{business.name}</h2>
          {business.address && <p className="mt-1 max-w-xs whitespace-pre-line text-xs text-slate-500">{business.address}</p>}
          <p className="mt-1 text-xs text-slate-500">
            {[business.email, business.phone].filter(Boolean).join(" · ")}
          </p>
          {business.gstin && <p className="mt-1 text-xs text-slate-500">GSTIN: {business.gstin}</p>}
        </div>
        <div className="text-right">
          <p className="text-[11px] font-semibold uppercase tracking-[.2em] text-violet-600">Quotation</p>
          <p className="mt-1 text-lg font-semibold text-slate-900">{quotation.number}</p>
          <p className="mt-1 text-xs text-slate-500">Date: {date(quotation.createdAt)}</p>
          <p className="text-xs text-slate-500">Valid until: {date(quotation.validUntil)}</p>
        </div>
      </header>

      <section className="grid gap-6 border-b border-slate-200 py-6 sm:grid-cols-2">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[.15em] text-slate-400">Bill to</p>
          <p className="mt-2 font-semibold text-slate-900">{client.company || client.name}</p>
          {client.company && <p className="text-sm">{client.name}</p>}
          {client.address && <p className="whitespace-pre-line text-sm text-slate-600">{client.address}</p>}
          <p className="text-sm text-slate-600">{client.email} · {client.phone}</p>
          <p className="text-sm text-slate-600">Place of supply: {client.state}</p>
          {client.gstin && <p className="text-sm text-slate-600">GSTIN: {client.gstin}</p>}
        </div>
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[.15em] text-slate-400">Project</p>
          <p className="mt-2 font-semibold text-slate-900">{requirement.title}</p>
          {quotation.tier && <p className="text-sm font-medium capitalize text-violet-700">{quotation.tier} proposal</p>}
          <p className="text-sm text-slate-600">Estimated delivery: about {quotation.estimatedWeeks} week{quotation.estimatedWeeks === 1 ? "" : "s"} after the advance{quotation.totalHours ? ` (${quotation.totalHours} development hours)` : ""}</p>
          {requirement.pages.length > 0 && <p className="mt-1 text-sm text-slate-600">Pages: {requirement.pages.join(", ")}</p>}
        </div>
      </section>

      {quotation.proposals && quotation.proposals.length > 0 && (
        <section className="border-b border-slate-200 py-6">
          <p className="text-[11px] font-semibold uppercase tracking-[.15em] text-slate-400">Proposals to choose from</p>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            {quotation.proposals.map((p) => (
              <div key={p.tier} className={`rounded-xl border p-3 text-sm ${p.tier === quotation.tier ? "border-violet-400 bg-violet-50" : "border-slate-200"}`}>
                <p className="font-semibold text-slate-900">{p.title}{p.tier === quotation.tier && <span className="ml-1 text-xs font-normal text-violet-600">(detailed below)</span>}</p>
                <p className="text-xs text-slate-500">{p.tagline}</p>
                <p className="mt-2 text-base font-semibold tabular-nums text-slate-900">{formatINR(p.grandTotal)}</p>
                <p className="text-[11px] text-slate-500">incl. GST · about {p.estimatedWeeks} week{p.estimatedWeeks === 1 ? "" : "s"}</p>
                <p className="mt-2 text-xs text-slate-600">{p.pages.length} page{p.pages.length === 1 ? "" : "s"} · {p.features.slice(0, 4).join(", ")}{p.features.length > 4 ? "..." : ""}</p>
                {p.leftOut.length > 0 && <p className="mt-1 text-[11px] text-slate-400">Not included: {p.leftOut.join("; ")}</p>}
              </div>
            ))}
          </div>
          {quotation.comparison && quotation.comparison.length > 0 && (
            <div className="mt-4"><ComparisonTable rows={quotation.comparison} selected={quotation.tier} tone="light" /></div>
          )}
        </section>
      )}

      <p className="pt-6 text-[11px] font-semibold uppercase tracking-[.15em] text-violet-600">A. Website development estimation</p>
      <div className="overflow-x-auto pb-6 pt-2">
        <table className="w-full min-w-[520px] text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-[11px] uppercase tracking-wider text-slate-400">
              <th className="py-2 pr-3 font-semibold">#</th>
              <th className="py-2 pr-3 font-semibold">Description</th>
              <th className="py-2 pr-3 text-right font-semibold">Qty</th>
              <th className="py-2 pr-3 text-right font-semibold">Rate</th>
              <th className="py-2 text-right font-semibold">Amount</th>
            </tr>
          </thead>
          <tbody>
            {quotation.items.map((item, i) => (
              <tr key={i} className="border-b border-slate-100">
                <td className="py-2.5 pr-3 text-slate-400">{i + 1}</td>
                <td className="py-2.5 pr-3">
                  {item.description}
                  <span className="ml-2 text-[10px] uppercase tracking-wider text-slate-400">{item.category}</span>
                  {item.detail && <span className="mt-0.5 block text-xs text-slate-500">{item.detail}</span>}
                </td>
                <td className="py-2.5 pr-3 text-right tabular-nums">{item.qty} {item.unit}{item.qty > 1 ? "s" : ""}</td>
                <td className="py-2.5 pr-3 text-right tabular-nums">{formatINR(item.rate)}</td>
                <td className="py-2.5 text-right tabular-nums">{formatINR(item.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid gap-8 sm:grid-cols-2">
        <div className="text-sm">
          <p className="text-[11px] font-semibold uppercase tracking-[.15em] text-slate-400">Recommended technology</p>
          <ul className="mt-2 space-y-0.5 text-slate-700">
            {quotation.stack.approach && <li>Approach: {quotation.stack.approach}</li>}
            <li>Frontend: {quotation.stack.frontend}</li>
            <li>Backend: {quotation.stack.backend}</li>
            <li>Database: {quotation.stack.database}</li>
            <li>Styling: {quotation.stack.styling}</li>
          </ul>
          {quotation.stack.notes.length > 0 && (
            <ul className="mt-2 list-disc space-y-0.5 pl-4 text-xs text-slate-500">
              {quotation.stack.notes.map((note) => <li key={note}>{note}</li>)}
            </ul>
          )}
        </div>
        <div>
          <QuoteTotals quote={quotation} />
          <p className="mt-1 text-right text-[11px] text-slate-500">Development total. Domain and hosting are not included.</p>
        </div>
      </div>

      {quotation.services && (
        <section className="mt-8">
          <ServicesSummary services={quotation.services} tone="light" />
        </section>
      )}

      <section className="mt-8 text-sm">
        <p className="text-[11px] font-semibold uppercase tracking-[.15em] text-slate-400">SEO</p>
        <div className="mt-2 grid gap-4 sm:grid-cols-2">
          <div>
            <p className="text-xs font-semibold text-slate-700">Included in every website</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-slate-600">{seo.included.map((i) => <li key={i}>{i}</li>)}</ul>
          </div>
          <div>
            <p className="text-xs font-semibold text-slate-700">Recommended for this project</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-slate-600">{seo.recommended.map((i) => <li key={i}>{i}</li>)}</ul>
          </div>
        </div>
        {seo.keywords.length > 0 && <p className="mt-2 text-xs text-slate-600">Target search phrases: {seo.keywords.join(", ")}</p>}
      </section>

      {quotation.deferred && (
        <section className="mt-8 rounded-xl border border-dashed border-slate-300 p-4 text-sm">
          <p className="text-[11px] font-semibold uppercase tracking-[.15em] text-slate-400">Phase 2 (not in this quotation)</p>
          <p className="mt-2 text-slate-700">{quotation.deferred.modules.join(", ")}</p>
          <p className="mt-1 text-xs text-slate-500">Estimated about {formatINR(quotation.deferred.amount)} + GST, quoted separately when you are ready.</p>
        </section>
      )}

      <section className="mt-8 rounded-xl bg-slate-50 p-4 text-sm">
        <p className="text-[11px] font-semibold uppercase tracking-[.15em] text-slate-400">Development payment schedule</p>
        {quotation.schedule.map((step) => (
          <div key={step.label} className="mt-2 flex justify-between gap-4">
            <span>{step.percent}% · {step.label}</span>
            <span className="font-semibold tabular-nums">{formatINR(step.amount)}</span>
          </div>
        ))}
        <ul className="mt-4 list-disc space-y-1 pl-4 text-xs text-slate-500">
          <li>Work starts once the advance is received. Every page is tested automatically and shown in a demo before the balance is due.</li>
          <li>Source code, build files and hosting set-up are handed over after full payment.</li>
          <li>Domain registration and hosting are not part of this quotation. The client buys them directly from a provider (for example Hostinger or GoDaddy) in the client&apos;s own name, at the provider&apos;s rates; both renew yearly. We help connect the domain and deploy the website.</li>
        </ul>
      </section>
    </article>
  );
}
