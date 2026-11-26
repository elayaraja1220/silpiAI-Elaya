"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Search } from "lucide-react";

import { Input } from "@/components/business/ui";
import { FALLBACK_INR_PER_UNIT, currencyOf, searchCurrencies, toInr } from "@/lib/business/currency";
import { cn } from "@/lib/utils";

type Rates = { source: "live" | "approximate"; asOf: string; inrPerUnit: Record<string, number> };
const APPROXIMATE: Rates = { source: "approximate", asOf: "", inrPerUnit: FALLBACK_INR_PER_UNIT };

// One lookup per page load, shared by every budget box on the page.
const loading = new Map<string, Promise<Rates>>();
function loadRates(url: string): Promise<Rates> {
  const known = loading.get(url);
  if (known) return known;
  const started = fetch(url)
    .then((r) => r.json())
    .then((r: { success?: boolean } & Partial<Rates>) => (r.success && r.inrPerUnit ? ({ source: r.source ?? "approximate", asOf: r.asOf ?? "", inrPerUnit: { ...FALLBACK_INR_PER_UNIT, ...r.inrPerUnit } } as Rates) : APPROXIMATE))
    .catch(() => APPROXIMATE);
  loading.set(url, started);
  return started;
}

const rupees = (n: number) => `₹${n.toLocaleString("en-IN")}`;
const rateText = (n: number) => (n >= 1 ? n.toFixed(2) : n.toPrecision(2));

/**
 * The client's budget: pick the client's currency (search by country, currency or symbol), type the amount, and the next box shows
 * it in Indian rupees. Only the rupee figure is kept (`value`); every price and comparison in SILPI stays in rupees.
 */
export function BudgetInput({ value, onChange, label = "Client budget", hint, ratesUrl = "/api/business/exchange-rates" }: { value: number; onChange: (inr: number) => void; label?: string; hint?: string; ratesUrl?: string }) {
  const [code, setCode] = useState("INR");
  const [amount, setAmount] = useState(value ? String(value) : "");
  const [rates, setRates] = useState<Rates>(APPROXIMATE);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const emitted = useRef(value);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    void loadRates(ratesUrl).then((r) => { if (alive) setRates(r); });
    return () => { alive = false; };
  }, []);

  // A budget set from somewhere else (for example "Use ₹X" from the document) is shown in rupees.
  useEffect(() => {
    if (value === emitted.current) return;
    emitted.current = value;
    setCode("INR");
    setAmount(value ? String(value) : "");
  }, [value]);

  const inr = useMemo(() => toInr(Number(amount), code, rates.inrPerUnit), [amount, code, rates]);
  // The rupee figure follows the amount, the currency and the rate (when a live rate arrives it replaces the approximate one).
  useEffect(() => {
    if (inr !== emitted.current) {
      emitted.current = inr;
      onChange(inr);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inr]);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  const current = currencyOf(code);
  const matches = searchCurrencies(query);
  const choose = (c: string) => { setCode(c); setOpen(false); setQuery(""); };
  const rate = code === "INR" ? 1 : rates.inrPerUnit[code];

  return (
    <div className="space-y-2" data-testid="budget-input">
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <div>
          <span className="mb-1.5 block text-xs font-medium text-slate-300">{label}: currency and amount</span>
          <div className="flex gap-2" ref={box}>
            <div className="relative">
              <button
                type="button"
                onClick={() => setOpen((o) => !o)}
                aria-haspopup="listbox"
                aria-expanded={open}
                className="flex h-full min-w-[9.5rem] items-center justify-between gap-2 rounded-xl border border-white/[.08] bg-white/[.03] px-3.5 py-2.5 text-sm text-slate-100 outline-none transition hover:border-white/20 focus:border-violet-400/60 focus:ring-4 focus:ring-violet-500/10"
                data-testid="currency-button"
              >
                <span className="flex items-center gap-2"><b className="text-base">{current.symbol}</b><span>{current.code}</span><span className="hidden text-xs text-slate-500 lg:inline">{current.countries[0]}</span></span>
                <ChevronDown size={14} className="text-slate-500" />
              </button>
              {open && (
                <div className="absolute left-0 top-full z-30 mt-1.5 w-[19rem] max-w-[85vw] overflow-hidden rounded-xl border border-white/10 bg-[#121620] shadow-2xl" role="listbox" aria-label="Currency">
                  <label className="flex items-center gap-2 border-b border-white/[.07] px-3 py-2.5">
                    <Search size={14} className="text-slate-500" />
                    <input
                      autoFocus
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") setOpen(false);
                        if (e.key === "Enter" && matches[0]) { e.preventDefault(); choose(matches[0].code); }
                      }}
                      placeholder="Search country, currency or symbol"
                      className="w-full bg-transparent text-sm text-slate-100 outline-none placeholder:text-slate-600"
                      data-testid="currency-search"
                    />
                  </label>
                  <ul className="max-h-64 overflow-y-auto py-1">
                    {matches.length === 0 && <li className="px-3 py-3 text-xs text-slate-500">No currency matches &quot;{query}&quot;.</li>}
                    {matches.map((c) => (
                      <li key={c.code}>
                        <button
                          type="button"
                          role="option"
                          aria-selected={c.code === code}
                          onClick={() => choose(c.code)}
                          className={cn("flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-white/[.06]", c.code === code && "bg-violet-500/10")}
                        >
                          <span className="w-8 shrink-0 text-center text-base font-semibold text-slate-100">{c.symbol}</span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-slate-100">{c.code} · {c.name}</span>
                            <span className="block truncate text-[11px] text-slate-500">{c.countries.slice(0, 3).join(", ")}</span>
                          </span>
                          {c.code === code && <Check size={14} className="text-violet-300" />}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
            <Input
              type="number"
              min={0}
              step="any"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder={code === "INR" ? "e.g. 100000" : "e.g. 1500"}
              aria-label={`Budget in ${current.name}`}
              className="min-w-0 flex-1 text-base"
              data-testid="budget-amount"
            />
          </div>
        </div>
        <div>
          <span className="mb-1.5 block text-xs font-medium text-slate-300">In Indian rupees (₹)</span>
          <div className="flex h-[2.7rem] items-center rounded-xl border border-white/[.08] bg-black/20 px-3.5 text-base font-semibold tabular-nums text-emerald-200" data-testid="budget-inr" aria-live="polite">
            {inr > 0 ? rupees(inr) : <span className="text-sm font-normal text-slate-600">₹ converted amount</span>}
          </div>
        </div>
      </div>
      <p className="text-[11px] text-slate-500">
        {code !== "INR" && rate ? (
          <>
            1 {code} = ₹{rateText(rate)} · {rates.source === "live" ? `live rate${rates.asOf ? `, ${new Date(rates.asOf).toLocaleDateString("en-IN", { day: "2-digit", month: "short" })}` : ""}` : "approximate rate (the live rate could not be loaded)"}.{" "}
          </>
        ) : null}
        {hint ?? "The most the client can pay, including GST. Only the rupee amount is used; all prices stay in ₹. Leave empty if not known."}
      </p>
    </div>
  );
}

