"use client";

import { useEffect, useState } from "react";
import { Loader2, Printer } from "lucide-react";
import { useSearchParams } from "next/navigation";

import { formatAmount, isCurrency } from "@/lib/currencies";
import { api, Button, Card, Notice } from "./light";

type Doc = {
  kind: "invoice" | "topup"; number: string; status: string; currency: string; issuedAt: string; paidAt: string | null;
  seller: { legalName: string; address: string; country: string; taxId: string; taxIdType: string; email: string };
  billTo: { legalName: string; country: string; addressLine1: string; addressLine2: string; city: string; region: string; postalCode: string; taxId: string; taxIdType: string } | null;
  lines: { description: string; amountMinor: number }[];
  discountMinor: number; couponCode: string | null; subtotalMinor: number; taxLabel: string; taxBasisPoints: number; taxMinor: number; totalMinor: number;
};
const money = (n: number, c: string) => (isCurrency(c) ? formatAmount(n, c) : `${n} ${c}`);
const day = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });

/** An invoice or credit-pack order as a clean page the customer can print or save as PDF from the browser. */
export function TaxDocumentPage() {
  const params = useSearchParams();
  const [doc, setDoc] = useState<Doc | null>(null);
  const [error, setError] = useState("");
  const kind = params.get("kind") ?? "";
  const id = params.get("id") ?? "";
  useEffect(() => {
    api<{ document: Doc }>(`/api/workspace/billing/document?kind=${encodeURIComponent(kind)}&id=${encodeURIComponent(id)}`).then((r) => setDoc(r.document)).catch((e: Error) => setError(e.message));
  }, [kind, id]);
  if (error) return <Notice tone="red">{error}</Notice>;
  if (!doc) return <Card className="flex items-center gap-2 text-sm text-slate-500"><Loader2 size={15} className="animate-spin" /> Loading...</Card>;
  const b = doc.billTo;
  const title = doc.kind === "invoice" ? "Invoice" : doc.status === "paid" ? "Credit pack receipt" : "Credit pack order";
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="flex items-center justify-between print:hidden">
        <a href="/ai/billing" className="text-sm text-indigo-700 hover:underline">Back to billing</a>
        <Button onClick={() => window.print()}><Printer size={15} /> Print or save as PDF</Button>
      </div>
      <Card className="space-y-6 p-6 print:border-0 print:shadow-none sm:p-8">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold text-slate-900">{title}</h1>
            <p className="mt-1 text-sm text-slate-600">No. <b>{doc.number}</b></p>
            <p className="text-sm text-slate-600">Date: {day(doc.issuedAt)}{doc.paidAt ? ` · Paid: ${day(doc.paidAt)}` : ""}</p>
            <p className="text-sm text-slate-600">Status: {doc.status}</p>
          </div>
          <div className="text-right text-sm text-slate-700">
            <p className="font-semibold text-slate-900">{doc.seller.legalName || "SILPI AI"}</p>
            {doc.seller.address && <p className="whitespace-pre-line">{doc.seller.address}</p>}
            {doc.seller.taxId && <p>{doc.seller.taxIdType || "Tax no."}: {doc.seller.taxId}</p>}
            {doc.seller.email && <p>{doc.seller.email}</p>}
          </div>
        </div>
        <div className="text-sm text-slate-700">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Billed to</p>
          {b ? (
            <>
              <p className="font-semibold text-slate-900">{b.legalName}</p>
              <p>{[b.addressLine1, b.addressLine2].filter(Boolean).join(", ")}</p>
              <p>{[b.city, b.region, b.postalCode].filter(Boolean).join(", ")} {b.country}</p>
              {b.taxId && <p>{b.taxIdType || "Tax no."}: {b.taxId}</p>}
            </>
          ) : <p className="text-slate-500">No billing details were saved when this was issued.</p>}
        </div>
        <table className="w-full text-sm">
          <thead><tr className="border-b border-slate-300 text-left text-xs text-slate-500"><th className="py-2 font-medium">Description</th><th className="py-2 text-right font-medium">Amount</th></tr></thead>
          <tbody>
            {doc.lines.map((l) => <tr key={l.description} className="border-b border-slate-100"><td className="py-2.5">{l.description}</td><td className="py-2.5 text-right tabular-nums">{money(l.amountMinor, doc.currency)}</td></tr>)}
            {doc.discountMinor > 0 && <tr className="border-b border-slate-100"><td className="py-2.5 text-emerald-700">Discount{doc.couponCode ? ` (${doc.couponCode})` : ""}</td><td className="py-2.5 text-right tabular-nums text-emerald-700">-{money(doc.discountMinor, doc.currency)}</td></tr>}
          </tbody>
          <tfoot className="tabular-nums">
            <tr><td className="pt-3 text-right text-slate-600">{doc.taxMinor > 0 ? "Amount before tax" : "Amount"}</td><td className="pt-3 text-right">{money(doc.subtotalMinor, doc.currency)}</td></tr>
            {doc.taxMinor > 0 && <tr><td className="pt-1 text-right text-slate-600">{doc.taxLabel || "Tax"} ({doc.taxBasisPoints / 100}%)</td><td className="pt-1 text-right">{money(doc.taxMinor, doc.currency)}</td></tr>}
            <tr><td className="pt-2 text-right font-semibold text-slate-900">Total</td><td className="pt-2 text-right text-base font-semibold text-slate-900">{money(doc.totalMinor, doc.currency)}</td></tr>
          </tfoot>
        </table>
        {doc.taxMinor === 0 && <p className="text-xs text-slate-500">No tax has been charged on this document.</p>}
      </Card>
    </div>
  );
}
