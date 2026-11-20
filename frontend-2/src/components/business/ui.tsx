import { Check } from "lucide-react";
import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";

import { STAGE_LABELS, type Stage } from "@/lib/business/types";
import { cn } from "@/lib/utils";

/** Small form primitives shared by the business screens. */

const control =
  "w-full rounded-xl border border-white/[.08] bg-white/[.03] px-3.5 py-2.5 text-sm text-slate-100 placeholder:text-slate-600 outline-none transition focus:border-violet-400/60 focus:bg-white/[.05] focus:ring-4 focus:ring-violet-500/10";

export function Field({ label, hint, children, className }: { label: string; hint?: string; children: ReactNode; className?: string }) {
  return (
    <label className={cn("block", className)}>
      <span className="mb-1.5 block text-xs font-medium text-slate-300">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-slate-500">{hint}</span>}
    </label>
  );
}

export const Input = (props: InputHTMLAttributes<HTMLInputElement>) => <input {...props} className={cn(control, props.className)} />;
export const Textarea = (props: TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...props} className={cn(control, "min-h-24", props.className)} />;
export const Select = (props: SelectHTMLAttributes<HTMLSelectElement>) => (
  <select {...props} className={cn(control, "[&>option]:bg-[#121620]", props.className)} />
);

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("rounded-2xl border border-white/[.07] bg-gradient-to-b from-[#141927] to-[#10141f] p-6 shadow-[0_8px_30px_-12px_rgba(0,0,0,.6)]", className)}>{children}</div>;
}

/** A titled block inside a form card: optional step number, title, helper text and a right-hand slot. */
export function Section({ title, hint, aside, children, className }: { title: string; hint?: string; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("space-y-3 border-t border-white/[.06] pt-6 first:border-t-0 first:pt-0", className)}>
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h3 className="text-[15px] font-semibold tracking-tight text-slate-100">{title}</h3>
          {hint && <p className="mt-0.5 max-w-2xl text-xs leading-5 text-slate-500">{hint}</p>}
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** A selectable tile (radio or checkbox style). */
export function Choice({ active, onClick, title, detail }: { active: boolean; onClick: () => void; title: string; detail?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "group relative flex h-full flex-col rounded-xl border px-3.5 py-3 text-left transition",
        active ? "border-violet-400/60 bg-violet-500/[.12] text-white shadow-[0_0_0_1px_rgba(167,139,250,.25)]" : "border-white/[.08] bg-white/[.02] text-slate-300 hover:-translate-y-px hover:border-white/20 hover:bg-white/[.04]",
      )}
    >
      <span className={cn("absolute right-2.5 top-2.5 flex h-4 w-4 items-center justify-center rounded-full border transition", active ? "border-violet-400 bg-violet-500 text-white" : "border-white/15 text-transparent")}>
        <Check size={10} strokeWidth={3} />
      </span>
      <span className="block pr-6 text-[13px] font-medium leading-snug">{title}</span>
      {detail && <span className="mt-1 block text-[11px] leading-4 text-slate-500 line-clamp-2">{detail}</span>}
    </button>
  );
}

const stageStyles: Partial<Record<Stage, string>> = {
  requirement: "border-slate-500/20 bg-slate-500/10 text-slate-300",
  quoted: "border-sky-400/20 bg-sky-400/10 text-sky-300",
  approved: "border-violet-400/20 bg-violet-400/10 text-violet-300",
  delivered: "border-emerald-400/20 bg-emerald-400/10 text-emerald-300",
  lost: "border-rose-400/20 bg-rose-400/10 text-rose-300",
};

export function StageBadge({ stage }: { stage: Stage }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-medium", stageStyles[stage] ?? "border-amber-400/20 bg-amber-400/10 text-amber-300")}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {STAGE_LABELS[stage]}
    </span>
  );
}

export async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...init?.headers } });
  const body = (await response.json().catch(() => ({}))) as { success?: boolean; error?: string } & T;
  if (!response.ok || body.success === false) throw new Error(body.error || `Request failed (${response.status}).`);
  return body;
}
