import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";

import { STAGE_LABELS, type Stage } from "@/lib/business/types";
import { cn } from "@/lib/utils";

/** Small form primitives shared by the business screens. */

const control =
  "w-full rounded-lg border border-white/[.08] bg-white/[.03] px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 outline-none transition focus:border-violet-400/60 focus:bg-white/[.05]";

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
  return <div className={cn("rounded-2xl border border-white/[.07] bg-[#121620] p-5", className)}>{children}</div>;
}

/** A selectable tile (radio or checkbox style). */
export function Choice({ active, onClick, title, detail }: { active: boolean; onClick: () => void; title: string; detail?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "rounded-xl border px-3 py-2.5 text-left transition",
        active ? "border-violet-400/60 bg-violet-500/10 text-white" : "border-white/[.08] bg-white/[.02] text-slate-300 hover:border-white/20",
      )}
    >
      <span className="block text-[13px] font-medium">{title}</span>
      {detail && <span className="mt-0.5 block text-[11px] text-slate-500">{detail}</span>}
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
