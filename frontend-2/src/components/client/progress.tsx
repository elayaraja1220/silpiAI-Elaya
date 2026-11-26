import { Check } from "lucide-react";

import { PROGRESS_STEPS } from "@/lib/client-progress";

/** Where a project is, as a row of steps. `step` is the index reached (-1 for a closed request, which shows no progress). */
export function ProgressSteps({ step }: { step: number }) {
  if (step < 0) return <p className="text-xs text-slate-500">This request is closed.</p>;
  return (
    <ol className="grid grid-cols-3 gap-x-2 gap-y-3 sm:grid-cols-9" aria-label="Project progress" data-testid="progress">
      {PROGRESS_STEPS.map((s, i) => {
        const done = i < step;
        const current = i === step;
        return (
          <li key={s.stage} aria-current={current ? "step" : undefined} className="flex flex-col items-center text-center">
            <span className={`flex h-7 w-7 items-center justify-center rounded-full border text-[11px] font-semibold ${done ? "border-emerald-400/50 bg-emerald-500/20 text-emerald-200" : current ? "border-violet-400 bg-violet-500 text-white" : "border-white/10 text-slate-500"}`}>
              {done ? <Check size={13} /> : i + 1}
            </span>
            <span className={`mt-1.5 text-[10px] leading-3 ${current ? "font-medium text-slate-100" : "text-slate-500"}`}>{s.label}</span>
          </li>
        );
      })}
    </ol>
  );
}
