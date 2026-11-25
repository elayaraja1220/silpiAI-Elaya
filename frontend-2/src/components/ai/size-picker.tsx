"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils";

export type SizeOption = { id: string; label: string; price: string; save: number };

/**
 * The "choose your credits" dropdown for a plan that comes in several sizes. Each option is a real plan: picking one changes the
 * price and the credits on the card. Works with the mouse and the keyboard (arrows, Enter, Escape) and is announced as a listbox.
 */
export function SizePicker({ options, value, onChange, label, suffix }: { options: SizeOption[]; value: string; onChange: (id: string) => void; label: string; suffix: string }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const current = options.find((o) => o.id === value) ?? options[0]!;

  useEffect(() => {
    if (!open) return;
    const outside = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", outside);
    return () => document.removeEventListener("mousedown", outside);
  }, [open]);

  const choose = (i: number) => { onChange(options[i]!.id); setOpen(false); };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { setOpen(false); return; }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) { setActive(options.findIndex((o) => o.id === value)); setOpen(true); return; }
      setActive((a) => (e.key === "ArrowDown" ? Math.min(options.length - 1, a + 1) : Math.max(0, a - 1)));
    } else if ((e.key === "Enter" || e.key === " ") && open) { e.preventDefault(); choose(active); }
  };

  return (
    <div ref={box} className="relative mt-4" onKeyDown={onKey}>
      <button type="button" aria-haspopup="listbox" aria-expanded={open} aria-label={label} onClick={() => { setActive(Math.max(0, options.findIndex((o) => o.id === value))); setOpen((v) => !v); }} className="flex w-full items-center justify-between gap-2 rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-left text-sm font-medium text-slate-900 transition hover:border-slate-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500">
        <span>{current.label} <span className="font-normal text-slate-500">{suffix}</span></span>
        <ChevronDown size={16} className={cn("shrink-0 text-slate-400 transition", open && "rotate-180")} />
      </button>
      {open && (
        <ul role="listbox" aria-label={label} className="absolute left-0 z-30 mt-1.5 max-h-80 w-[min(21rem,calc(100vw-2rem))] min-w-full overflow-auto rounded-2xl border border-slate-200 bg-white p-1.5 shadow-2xl">
          {options.map((o, i) => (
            <li key={o.id} role="option" aria-selected={o.id === value}>
              <button type="button" onClick={() => choose(i)} onMouseEnter={() => setActive(i)} className={cn("flex w-full items-center justify-between gap-2 rounded-xl px-3 py-2.5 text-left text-sm transition", i === active ? "bg-indigo-50" : "bg-white", o.id === value ? "font-semibold text-indigo-700" : "text-slate-800")}>
                <span className="flex items-center gap-1.5 whitespace-nowrap">{o.id === value && <Check size={14} />}{o.label}</span>
                <span className="flex shrink-0 items-center gap-2">
                  {o.save > 0 && <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">Save {o.save}%</span>}
                  <span className="tabular-nums text-slate-600">{o.price}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
