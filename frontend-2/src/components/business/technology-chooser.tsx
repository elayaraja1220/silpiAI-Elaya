"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Loader2, X } from "lucide-react";

import { previewTech, techChoices, type TechChoiceLayer, type TechPreview, type TechSelection } from "@/lib/business/client-tech";
import { formatINR } from "@/lib/business/pricing";
import type { Client, RateCard, Requirement, Tier } from "@/lib/business/types";

type Choices = { tier: Tier; total: number; layers: TechChoiceLayer[] };

const money = (delta: number) => (delta === 0 ? "Same price" : delta > 0 ? `+ ${formatINR(delta)}` : `− ${formatINR(-delta)}`);
const tone = (delta: number) => (delta === 0 ? "text-slate-500" : delta > 0 ? "text-amber-700" : "text-emerald-700");

/**
 * "Choose your technology": frontend, backend and database, each option with what it does to the price.
 * The prices come from the server; picking something only previews the new total. It is saved when the client approves.
 */
export function TechnologyChooser({ endpoint, local, tier, value, onApply, onClose, intro = "Pick the frontend, backend and database you prefer. Each option shows how it changes the price compared with this quotation. Nothing is saved until you approve.", applyLabel = "Use this technology", applying = false }: {
  /** The route that lists the options (GET) and works out a price (POST). */
  endpoint?: string;
  /** Or price in the browser from the requirement itself (the new-quotation wizard, before anything is saved). */
  local?: { requirement: Requirement; client: Pick<Client, "state">; rates: RateCard };
  tier: Tier;
  value: TechSelection | null;
  onApply: (tech: TechSelection, preview: TechPreview) => void;
  onClose: () => void;
  intro?: string;
  applyLabel?: string;
  applying?: boolean;
}) {
  const base = endpoint ?? "";
  const [choices, setChoices] = useState<Choices | null>(null);
  const [tech, setTech] = useState<TechSelection>(value ?? {});
  const [preview, setPreview] = useState<TechPreview | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const asked = useRef(0);

  useEffect(() => {
    if (local) {
      const c = techChoices(local.requirement, local.client, local.rates, tier);
      setChoices(c);
      if (!value) setTech(Object.fromEntries(c.layers.filter((l) => l.current).map((l) => [l.layer, l.current])));
      return;
    }
    fetch(`${base}?tier=${tier}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((r: { success?: boolean; error?: string } & Partial<Choices>) => {
        if (!r.success || !r.layers) throw new Error(r.error || "Could not load the technology options.");
        setChoices({ tier: r.tier!, total: r.total!, layers: r.layers });
        // Start from what the quotation already uses, unless the client chose something before.
        if (!value) setTech(Object.fromEntries(r.layers.filter((l) => l.current).map((l) => [l.layer, l.current])));
      })
      .catch((e: Error) => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, tier, value]);

  // The new price for the current selection (the newest answer wins when the client clicks quickly).
  useEffect(() => {
    if (!choices) return;
    if (local) {
      setPreview(previewTech(local.requirement, local.client, local.rates, tier, tech));
      return;
    }
    const id = ++asked.current;
    setBusy(true);
    fetch(base, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tier, tech }) })
      .then((r) => r.json())
      .then((r: { success?: boolean; error?: string; preview?: TechPreview }) => {
        if (id !== asked.current) return;
        if (!r.success || !r.preview) throw new Error(r.error || "Could not work out the price.");
        setPreview(r.preview);
        setError("");
      })
      .catch((e: Error) => id === asked.current && setError(e.message))
      .finally(() => id === asked.current && setBusy(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, tier, tech, choices]);

  const pick = (layer: TechChoiceLayer["layer"], id: string) => setTech((t) => {
    const next = { ...t };
    if (id) next[layer] = id;
    else delete next[layer];
    return next;
  });

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/50 p-0 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-label="Choose your technology" data-testid="tech-chooser">
      <div className="flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-t-2xl bg-white shadow-2xl sm:rounded-2xl">
        <header className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-4">
          <div>
            <h2 className="font-semibold text-slate-900">Choose your technology</h2>
            <p className="mt-0.5 text-xs text-slate-500">{intro}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"><X size={18} /></button>
        </header>

        <div className="flex-1 space-y-6 overflow-y-auto px-5 py-4">
          {!choices && !error && <p className="flex items-center gap-2 text-sm text-slate-500"><Loader2 size={15} className="animate-spin" /> Loading options...</p>}
          {choices?.layers.map((layer) => (
            <section key={layer.layer}>
              <h3 className="text-sm font-semibold text-slate-900">{layer.label}</h3>
              {!layer.applies ? (
                <p className="mt-1 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">This project needs no {layer.layer}, so there is nothing to choose.</p>
              ) : (
                <div className="mt-2 grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label={layer.label}>
                  {layer.options.map((o) => {
                    const on = (tech[layer.layer] ?? "") === o.id;
                    return (
                      <button
                        key={o.id || "default"}
                        type="button"
                        role="radio"
                        aria-checked={on}
                        onClick={() => pick(layer.layer, o.id)}
                        className={`relative rounded-xl border p-3 text-left transition ${on ? "border-violet-500 bg-violet-50 ring-2 ring-violet-200" : "border-slate-200 hover:border-slate-300"}`}
                        data-testid={`tech-${layer.layer}-${o.id || "default"}`}
                      >
                        <span className={`absolute right-2.5 top-2.5 flex h-4 w-4 items-center justify-center rounded-full border ${on ? "border-violet-600 bg-violet-600 text-white" : "border-slate-300 text-transparent"}`}><Check size={10} strokeWidth={3} /></span>
                        <span className="block pr-6 text-sm font-medium text-slate-900">{o.label}</span>
                        <span className="mt-0.5 block text-xs text-slate-500">{o.detail}</span>
                        <span className={`mt-1.5 block text-xs font-semibold tabular-nums ${tone(o.delta)}`}>{money(o.delta)}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </section>
          ))}
          {error && <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>}
        </div>

        <footer className="space-y-3 border-t border-slate-200 bg-slate-50 px-5 py-4">
          {preview && (
            <div className="flex flex-wrap items-baseline justify-between gap-2" data-testid="tech-preview">
              <span className="text-sm text-slate-600">
                New total <b className="text-lg tabular-nums text-slate-900">{formatINR(preview.total)}</b> <span className="text-xs">incl. GST</span>
                {busy && <Loader2 size={13} className="ml-2 inline animate-spin text-slate-400" />}
              </span>
              <span className={`text-sm font-semibold tabular-nums ${tone(preview.delta)}`}>{preview.delta === 0 ? "Same as the quotation" : `${money(preview.delta)} compared with the quotation`}</span>
            </div>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" onClick={onClose} disabled={applying} className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm hover:bg-slate-100 disabled:opacity-50">Cancel</button>
            <button type="button" disabled={!preview || busy || applying} onClick={() => preview && onApply(tech, preview)} className="flex items-center gap-2 rounded-lg bg-violet-600 px-5 py-2 text-sm font-semibold text-white hover:bg-violet-500 disabled:opacity-50" data-testid="tech-apply">{applying && <Loader2 size={14} className="animate-spin" />}{applyLabel}</button>
          </div>
        </footer>
      </div>
    </div>
  );
}
