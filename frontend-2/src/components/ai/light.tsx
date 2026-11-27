"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * Light-theme building blocks for the AI Gateway section only. The rest of the app is dark and is untouched: these
 * components never read the dark tokens, and the section's layout wraps itself in its own light surface.
 */

export const Card = ({ children, className, "data-testid": testId }: { children: ReactNode; className?: string; "data-testid"?: string }) => (
  <div className={cn("rounded-2xl border border-slate-200 bg-white p-5 shadow-sm", className)} data-testid={testId}>{children}</div>
);

export function Stat({ label, value, hint, tone = "default" }: { label: string; value: ReactNode; hint?: ReactNode; tone?: "default" | "good" | "warn" }) {
  return (
    <Card className="p-4">
      <p className="text-xs font-medium text-slate-500">{label}</p>
      <p className={cn("mt-1 text-2xl font-semibold tabular-nums", tone === "good" ? "text-emerald-700" : tone === "warn" ? "text-amber-700" : "text-slate-900")}>{value}</p>
      {hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
    </Card>
  );
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" | "danger" };
export function Button({ variant = "primary", className, ...props }: ButtonProps) {
  return (
    <button
      {...props}
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
        variant === "primary" && "bg-indigo-600 text-white hover:bg-indigo-500",
        variant === "ghost" && "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50",
        variant === "danger" && "bg-rose-600 text-white hover:bg-rose-500",
        className,
      )}
    />
  );
}

const tones = { green: "bg-emerald-50 text-emerald-700 ring-emerald-200", red: "bg-rose-50 text-rose-700 ring-rose-200", amber: "bg-amber-50 text-amber-800 ring-amber-200", slate: "bg-slate-100 text-slate-700 ring-slate-200", indigo: "bg-indigo-50 text-indigo-700 ring-indigo-200" };
export const Pill = ({ children, tone = "slate" }: { children: ReactNode; tone?: keyof typeof tones }) => (
  <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset", tones[tone])}>{children}</span>
);

export const inputClass = "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20";

export const Notice = ({ children, tone = "amber" }: { children: ReactNode; tone?: "amber" | "red" | "green" | "slate" }) => (
  <div role={tone === "red" ? "alert" : "status"} className={cn("rounded-lg border px-3 py-2 text-sm", tone === "amber" && "border-amber-200 bg-amber-50 text-amber-900", tone === "red" && "border-rose-200 bg-rose-50 text-rose-800", tone === "green" && "border-emerald-200 bg-emerald-50 text-emerald-800", tone === "slate" && "border-slate-200 bg-slate-50 text-slate-700")}>{children}</div>
);

// ---- formatting ----------------------------------------------------------------------------------------------------
/** Credit units (1 credit = 1000) as credits: whole numbers plain, small amounts with up to 3 decimals. */
export function credits(units: number): string {
  const c = units / 1000;
  if (Number.isInteger(c)) return c.toLocaleString("en-IN");
  return c.toLocaleString("en-IN", { maximumFractionDigits: 3 });
}
export const usd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: n < 1 ? 4 : 2, maximumFractionDigits: n < 1 ? 4 : 2 })}`;

// ---- tiny fetch helper -------------------------------------------------------------------------------------------------
export class ApiError extends Error {
  status: number;
  body: Record<string, unknown>;
  constructor(message: string, status: number, body: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.body = body;
  }
}
export async function api<T = Record<string, unknown>>(url: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<T> {
  const res = await fetch(url, { method: init.method ?? "GET", cache: "no-store", headers: { ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}), ...init.headers }, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || body.success === false) throw new ApiError(String(body.error ?? "Something went wrong."), res.status, body);
  return body as T;
}
