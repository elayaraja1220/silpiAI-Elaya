import { formatINR } from "@/lib/business/pricing";
import type { PublicRunningServices } from "@/lib/business/running-services";

/**
 * What the client sees about domain, hosting, maintenance and other running services. Light colours: it prints with
 * the quotation. It only ever receives the client-safe object built on the server (see publicRunningServices).
 */
export function RunningServicesSection({ running }: { running: PublicRunningServices }) {
  return (
    <section className="mt-8 rounded-xl border border-slate-200 p-4 text-sm" data-testid="running-services">
      <p className="text-[11px] font-semibold uppercase tracking-[.15em] text-slate-400">Running services (billed separately from development)</p>
      <div className="mt-3 divide-y divide-slate-100">
        {running.services.map((s, i) => (
          <div key={`${s.service}-${i}`} className="grid gap-x-6 gap-y-1 py-2.5 sm:grid-cols-[1.2fr_1fr_auto]">
            <div className="min-w-0">
              <p className="font-semibold text-slate-800">{s.service}</p>
              <p className="text-xs text-slate-500">{s.statusLabel}</p>
              {s.renewalTerms && <p className="mt-0.5 text-xs text-slate-500">{s.renewalTerms}</p>}
            </div>
            <div className="text-xs text-slate-600">
              <p>{s.responsibility}</p>
              {s.frequency && <p className="text-slate-500">{s.frequency}</p>}
            </div>
            <p className="text-right tabular-nums sm:min-w-[7rem]">
              {s.amount !== null ? (
                <>
                  <span className="font-semibold text-slate-900">{formatINR(s.amount)}</span>
                  {s.amountNote && <span className="block text-[11px] text-slate-500">{s.amountNote}</span>}
                </>
              ) : s.status === "included" ? (
                <span className="font-semibold text-emerald-700">Included</span>
              ) : s.status === "billed-by-us" ? (
                <span className="text-xs text-slate-500">Amount to be confirmed</span>
              ) : (
                <span className="text-xs text-slate-400">No charge from us</span>
              )}
            </p>
          </div>
        ))}
      </div>
      <p className="mt-2 text-[11px] text-slate-500">{running.note}</p>
    </section>
  );
}
