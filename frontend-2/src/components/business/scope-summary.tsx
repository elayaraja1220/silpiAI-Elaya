import { scopeSummary } from "@/lib/business/scope";
import type { RateCard, Requirement } from "@/lib/business/types";

/** The scope grouped the way it is priced: billed pages, what comes free with the set-up, and what is left for later. */
export function ScopeSummary({ requirement, rates }: { requirement: Requirement; rates: RateCard }) {
  const s = scopeSummary(requirement, rates);
  const group = (title: string, items: string[], note?: string, tone = "text-slate-200") =>
    items.length > 0 && (
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
          {title} <span className="normal-case tracking-normal text-slate-600">({items.length}){note ? ` · ${note}` : ""}</span>
        </p>
        <ul className="mt-1 flex flex-wrap gap-1.5">
          {items.map((i) => <li key={i} className={`rounded-md bg-white/[.05] px-2 py-0.5 text-xs ${tone}`}>{i}</li>)}
        </ul>
      </div>
    );
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {group("Confirmed pages", s.pages, "billed")}
      {group("Supporting pages", s.supportingPages, "included in set-up, not billed", "text-slate-300")}
      {group("Shared components", s.sharedComponents, "included, not pages", "text-slate-300")}
      {group("Optional pages", s.optionalPages, "suggested, not included", "text-slate-400")}
      {group("Must-have features", s.includedFeatures)}
      {group("Optional features", s.optionalFeatures, "included in this quotation")}
      {group("Not in this package", s.notInPackage, "not priced", "text-slate-400")}
      {group("Phase 2", s.phase2, "kept on record, not priced", "text-amber-200")}
      {group("Quality", s.quality, "included", "text-slate-300")}
      {group("External services", s.externalServices, "price to be confirmed", "text-slate-300")}
    </div>
  );
}
