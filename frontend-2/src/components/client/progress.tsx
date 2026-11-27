import { Check } from "lucide-react";

import { PROGRESS_STEPS } from "@/lib/client-progress";

/** Where a project is, as a row of connected steps. `step` is the index reached (-1 for a closed request, which shows no progress). */
export function ProgressSteps({ step }: { step: number }) {
  if (step < 0) return <p className="text-xs text-slate-500">This request is closed.</p>;
  return (
    <ol className="grid grid-cols-3 gap-x-2 gap-y-4 sm:grid-cols-9" aria-label="Project progress" data-testid="progress">
      {PROGRESS_STEPS.map((s, i) => {
        const done = i < step;
        const current = i === step;
        return (
          <li key={s.stage} aria-current={current ? "step" : undefined} className="relative flex flex-col items-center text-center">
            {/* The line back to the step before: green once that step is done */}
            {i > 0 && <span aria-hidden className={`absolute right-1/2 top-[13px] hidden h-px w-[calc(100%+0.5rem)] sm:block ${i <= step ? "bg-emerald-400/50" : "bg-white/10"}`} />}
            <span className={`relative z-10 flex h-7 w-7 items-center justify-center rounded-full border text-[11px] font-semibold ${done ? "border-emerald-400/60 bg-[#12302b] text-emerald-300" : current ? "border-violet-300 bg-violet-500 text-white shadow-[0_0_16px_rgba(139,92,246,.75)]" : "border-white/15 bg-[#10131c] text-slate-500"}`}>
              {done ? <Check size={13} /> : i + 1}
            </span>
            <span className={`mt-1.5 text-[10px] leading-3 ${current ? "font-medium text-violet-200" : "text-slate-500"}`}>{s.label}</span>
          </li>
        );
      })}
    </ol>
  );
}
