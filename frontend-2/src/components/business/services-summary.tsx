import { Globe, Server } from "lucide-react";

import { useMoney } from "./money-context";
import { CHOICE_LABELS } from "@/lib/business/services";
import type { SeparateServices, ServiceEstimate } from "@/lib/business/types";

export const SEPARATE_NOTICE = "Domain and hosting charges are not included in website development pricing. Buy them separately from a domain and hosting provider of your choice.";

/**
 * B. Domain and C. Hosting: separately billed services, visually distinct
 * from the development cost. Light for client documents, dark for team screens.
 */
export function ServicesSummary({ services, tone, compact = false }: { services: SeparateServices; tone: "light" | "dark"; compact?: boolean }) {
  const { fmt } = useMoney();
  const dark = tone === "dark";
  const box = (estimate: ServiceEstimate | undefined, kind: "domain" | "hosting", choice: string, letter: string) => {
    const Icon = kind === "domain" ? Globe : Server;
    const accent = kind === "domain" ? (dark ? "border-sky-400/30 bg-sky-500/[.06]" : "border-sky-200 bg-sky-50") : dark ? "border-teal-400/30 bg-teal-500/[.06]" : "border-teal-200 bg-teal-50";
    const iconColor = kind === "domain" ? (dark ? "text-sky-300" : "text-sky-600") : dark ? "text-teal-300" : "text-teal-600";
    return (
      <div className={`rounded-xl border p-3 ${accent}`}>
        <p className={`flex items-center gap-1.5 text-xs font-semibold ${dark ? "text-slate-200" : "text-slate-800"}`}>
          <Icon size={14} className={iconColor} /> {letter}. {kind === "domain" ? "Domain name" : "Web hosting"}
        </p>
        <p className={`mt-1 text-[11px] ${dark ? "text-slate-400" : "text-slate-600"}`}>{choice}</p>
        {estimate && (
          <>
            {!compact && (
              <dl className={`mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[11px] ${dark ? "text-slate-400" : "text-slate-600"}`}>
                {estimate.details.map((d) => (
                  <div key={d.label} className="contents">
                    <dt className={dark ? "text-slate-500" : "text-slate-400"}>{d.label}</dt>
                    <dd>{d.value}</dd>
                  </div>
                ))}
              </dl>
            )}
            <div className={`mt-2 space-y-0.5 border-t pt-2 text-[11px] ${dark ? "border-white/[.06] text-slate-300" : "border-slate-200 text-slate-700"}`}>
              {!compact && estimate.items.map((i) => (
                <div key={i.description} className="flex justify-between gap-3"><span>{i.description}</span><span className="tabular-nums">{fmt(i.amount)}</span></div>
              ))}
              {estimate.gst > 0 && <div className="flex justify-between gap-3"><span>GST</span><span className="tabular-nums">{fmt(estimate.gst)}</span></div>}
              <div className="flex justify-between gap-3 font-semibold"><span>Total now (separate bill)</span><span className="tabular-nums">{fmt(estimate.total)}</span></div>
              <div className={`flex justify-between gap-3 ${dark ? "text-slate-500" : "text-slate-500"}`}><span>Renewal</span><span className="tabular-nums">{fmt(estimate.renewal)} / year + GST</span></div>
            </div>
          </>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-2">
      <p className={`rounded-lg px-3 py-2 text-[11px] ${dark ? "bg-white/[.04] text-slate-300" : "bg-slate-100 text-slate-600"}`}>{SEPARATE_NOTICE}</p>
      <div className={compact ? "space-y-2" : "grid gap-2 sm:grid-cols-2"}>
        {box(services.domain.estimate, "domain", CHOICE_LABELS.domain[services.domain.choice], "B")}
        {box(services.hosting.estimate, "hosting", CHOICE_LABELS.hosting[services.hosting.choice], "C")}
      </div>
      {services.others && services.others.length > 0 && (
        <div className={`rounded-xl border p-3 text-[11px] ${dark ? "border-white/[.08] text-slate-300" : "border-slate-200 text-slate-700"}`}>
          <p className={`text-xs font-semibold ${dark ? "text-slate-200" : "text-slate-800"}`}>D. Other external services</p>
          <ul className="mt-1 space-y-0.5">
            {services.others.map((o) => (
              <li key={o} className="flex justify-between gap-3"><span>{o}</span><span className="opacity-70">To be confirmed</span></li>
            ))}
          </ul>
          <p className="mt-1 opacity-70">Billed by the provider (one-time or recurring); the price is confirmed before purchase.</p>
        </div>
      )}
      {services.total > 0 && (
        <p className={`text-right text-xs font-semibold ${dark ? "text-slate-200" : "text-slate-800"}`}>
          Separate services total: {fmt(services.total)} <span className="font-normal opacity-70">(not part of the development total)</span>
        </p>
      )}
    </div>
  );
}
