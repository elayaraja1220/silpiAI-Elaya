"use client";

import { useEffect, useState } from "react";

import type { ApprovalRecord } from "@/lib/business/store";
import { formatMoney } from "@/lib/business/money";
import { Card, jsonFetch } from "./ui";

const CHANNEL = { "client-link": "by the client on the link", team: "by the team", "before-records": "before approval records existed" } as const;

/** Every version of this quotation and every approval, with what was agreed. Read only: an approved quotation is never edited. */
export function ApprovalRecordCard({ leadId, refreshKey }: { leadId: string; refreshKey: string }) {
  const [rec, setRec] = useState<ApprovalRecord | null>(null);
  useEffect(() => { jsonFetch<ApprovalRecord>(`/api/business/leads/${leadId}/approvals`).then(setRec).catch(() => setRec(null)); }, [leadId, refreshKey]);
  if (!rec || (rec.versions.length === 0 && rec.approvals.length === 0)) return null;
  return (
    <Card>
      <p className="text-xs font-semibold text-slate-300">Versions and approvals</p>
      {rec.pending && (
        <p className="mt-2 rounded-lg border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-100" data-testid="approval-pending">
          Version {rec.pending.versionNo} ({rec.pending.number}) has not been approved. {rec.pending.changes.length ? `It changes: ${rec.pending.changes.join(", ")}.` : "None of the agreed terms moved."} It must be approved again before work depends on it.
        </p>
      )}
      <ol className="mt-3 space-y-2 text-xs" data-testid="approvals">
        {rec.approvals.map((a) => {
          const money = { code: a.terms.currency, unit: a.terms.inrPerUnit };
          return (
            <li key={a.id} className="rounded-lg border border-emerald-400/20 bg-emerald-500/[.05] px-3 py-2">
              <p className="text-emerald-100">Approved {a.number} (version {a.versionNo || "?"}) {CHANNEL[a.channel]} · {a.approvedBy}</p>
              <p className="text-slate-400">{new Date(a.approvedAt).toLocaleString("en-IN")}{a.note && ` · "${a.note}"`}</p>
              <p className="mt-1 text-slate-300">
                Agreed: {a.terms.hourly ? `${formatMoney(a.terms.hourly.rate, money)} an hour, ${a.terms.hourly.expectedHours} h expected, not to exceed ${a.terms.hourly.capHours} h (${formatMoney(a.terms.hourly.capTotal, money)})` : `${formatMoney(a.terms.grandTotal, money)} fixed price`}
                {" · "}{a.terms.tax.mode === "export" ? "no GST (export)" : `${a.terms.tax.rate}% GST`}
                {a.terms.market && ` · rate from ${a.terms.market.source} (${a.terms.market.effectiveDate})`}
              </p>
              {!a.intact && <p className="mt-1 text-rose-300">{a.problem}</p>}
            </li>
          );
        })}
      </ol>
      <p className="mt-3 text-[11px] text-slate-500">{rec.versions.length} version{rec.versions.length === 1 ? "" : "s"}: {rec.versions.map((v) => `${v.number}${v.reason ? ` (${v.reason})` : ""}`).join(" → ")}</p>
    </Card>
  );
}
