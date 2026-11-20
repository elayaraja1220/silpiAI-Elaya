import { Check, Minus } from "lucide-react";

import { TIERS, type ComparisonRow, type Tier } from "@/lib/business/types";

const TITLES: Record<Tier, string> = { basic: "Basic", standard: "Standard", premium: "Premium" };

/** ✓ / ✗ table of what each package includes. Light for client documents, dark for the team screen. */
export function ComparisonTable({ rows, selected, tone }: { rows: ComparisonRow[]; selected?: Tier; tone: "light" | "dark" }) {
  const dark = tone === "dark";
  const cell = (v: string | boolean) =>
    v === true ? (
      <Check size={15} className={dark ? "text-emerald-300" : "text-emerald-600"} aria-label="Included" />
    ) : v === false ? (
      <Minus size={15} className={dark ? "text-slate-600" : "text-slate-300"} aria-label="Not included" />
    ) : (
      <span>{v}</span>
    );
  return (
    <div className="overflow-x-auto">
      <table className={`w-full min-w-[520px] text-xs ${dark ? "text-slate-300" : "text-slate-700"}`}>
        <thead>
          <tr className={`text-left text-[11px] uppercase tracking-wider ${dark ? "text-slate-500" : "text-slate-400"}`}>
            <th className="py-2 pr-3 font-medium">What&apos;s included</th>
            {TIERS.map((t) => (
              <th key={t} className={`py-2 pr-3 font-semibold ${t === selected ? (dark ? "text-violet-200" : "text-violet-700") : ""}`}>
                {TITLES[t]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label} className={`border-t ${dark ? "border-white/[.05]" : "border-slate-100"}`}>
              <td className="py-1.5 pr-3">{row.label}</td>
              {TIERS.map((t) => (
                <td key={t} className={`py-1.5 pr-3 ${t === selected ? (dark ? "bg-violet-500/[.06]" : "bg-violet-50") : ""}`}>{cell(row.values[t])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
