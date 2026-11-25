"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Cpu, Database, Loader2, Monitor, Palette, Server, Sparkles, X } from "lucide-react";

import { previewTech, techChoices, type TechChoiceLayer, type TechPreview, type TechSelection } from "@/lib/business/client-tech";
import { formatINR } from "@/lib/business/pricing";
import type { Client, RateCard, Requirement, Tier } from "@/lib/business/types";

const LAYER_ICON = { frontend: Monitor, backend: Server, database: Database, styling: Palette } as const;
const LAYER_SHORT = { frontend: "Frontend", backend: "Backend", database: "Database", styling: "Styling" } as const;

// Frontend and its styling / UI library share one tab: the libraries depend on the frontend.
const TABS: { id: "frontend" | "backend" | "database"; label: string; layers: TechChoiceLayer["layer"][] }[] = [
  { id: "frontend", label: "Frontend & UI library", layers: ["frontend", "styling"] },
  { id: "backend", label: "Backend", layers: ["backend"] },
  { id: "database", label: "Database", layers: ["database"] },
];
type TabId = (typeof TABS)[number]["id"];

type Choices = { tier: Tier; total: number; layers: TechChoiceLayer[] };

const money = (delta: number) => (delta === 0 ? "Same price" : delta > 0 ? `+ ${formatINR(delta)}` : `− ${formatINR(-delta)}`);
const tone = (delta: number) => (delta === 0 ? "text-slate-500" : delta > 0 ? "text-amber-700" : "text-emerald-700");

/**
 * "Choose your technology": frontend, backend and database, each option with what it does to the price.
 * The prices come from the server; picking something only previews the new total. It is saved when the client approves.
 */
export function TechnologyChooser({ endpoint, local, tier, value, onApply, onClose, intro = "Pick the frontend, backend, database and styling (UI library) you prefer. Each option shows how it changes the price compared with this quotation. Nothing is saved until you approve.", applyLabel = "Use this technology", applying = false }: {
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
  const [tab, setTab] = useState<TabId>("frontend");
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

  // UI libraries that work with the frontend picked above (no frontend picked = our standard, Next.js).
  const fits = (o: TechChoiceLayer["options"][number], frontend: string | undefined) => !o.frameworks?.length || o.frameworks.includes(frontend || "next");

  const pick = (layer: TechChoiceLayer["layer"], id: string) => setTech((t) => {
    const next = { ...t };
    if (id) next[layer] = id;
    else delete next[layer];
    // Changing the frontend drops a UI library that does not work with the new one.
    if (layer === "frontend" && next.styling) {
      const chosen = choices?.layers.find((l) => l.layer === "styling")?.options.find((o) => o.id === next.styling);
      if (chosen && !fits(chosen, next.frontend)) delete next.styling;
    }
    return next;
  });

  const layerOptions = (layer: TechChoiceLayer) => layer.options.filter((o) => layer.layer !== "styling" || fits(o, tech.frontend));
  const chosenLabel = (layer: TechChoiceLayer) => {
    const id = tech[layer.layer] ?? "";
    return id ? layer.options.find((o) => o.id === id)?.label ?? id : "Our standard";
  };

  const renderOption = (layer: TechChoiceLayer, o: TechChoiceLayer["options"][number]) => {
    const on = (tech[layer.layer] ?? "") === o.id;
    return (
      <button
        key={o.id || "default"}
        type="button"
        role="radio"
        aria-checked={on}
        onClick={() => pick(layer.layer, o.id)}
        className={`group relative flex h-full flex-col rounded-xl border p-3 text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 ${on ? "border-violet-500 bg-violet-50 shadow-sm ring-1 ring-violet-500" : "border-slate-200 bg-white hover:border-violet-300 hover:bg-violet-50/40"}`}
        data-testid={`tech-${layer.layer}-${o.id || "default"}`}
      >
        <span className={`absolute right-2.5 top-2.5 flex h-5 w-5 items-center justify-center rounded-full border transition ${on ? "border-violet-600 bg-violet-600 text-white" : "border-slate-300 bg-white text-transparent group-hover:border-violet-300"}`}><Check size={12} strokeWidth={3} /></span>
        <span className="block pr-7 text-sm font-semibold leading-snug text-slate-900">{o.id === "" ? "Our standard" : o.label}</span>
        {o.id === "" && <span className="mt-1 inline-flex w-fit items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-700"><Sparkles size={10} /> Recommended</span>}
        <span className="mt-1 block flex-1 text-xs leading-relaxed text-slate-500">{o.detail}</span>
        <span className={`mt-2 inline-flex w-fit rounded-full px-2 py-0.5 text-[11px] font-semibold tabular-nums ${o.delta === 0 ? "bg-slate-100 text-slate-500" : o.delta > 0 ? "bg-amber-100 text-amber-800" : "bg-emerald-100 text-emerald-800"}`}>{money(o.delta)}</span>
      </button>
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/60 p-0 backdrop-blur-sm sm:items-center sm:p-6" role="dialog" aria-modal="true" aria-label="Choose your technology" data-testid="tech-chooser">
      <div className="flex max-h-[94vh] w-full max-w-4xl flex-col overflow-hidden rounded-t-3xl bg-slate-50 shadow-2xl sm:rounded-3xl">
        <header className="border-b border-slate-200 bg-white px-5 pb-3 pt-4 sm:px-6">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500 to-indigo-600 text-white shadow"><Cpu size={20} /></span>
              <div>
                <h2 className="text-lg font-semibold text-slate-900">Choose your technology</h2>
                <p className="mt-0.5 max-w-xl text-xs leading-relaxed text-slate-500">{intro}</p>
              </div>
            </div>
            <button type="button" onClick={onClose} aria-label="Close" className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"><X size={18} /></button>
          </div>
        </header>

        {choices && (
          <div className="grid grid-cols-3 gap-2 border-b border-slate-200 bg-white px-4 py-3 sm:gap-3 sm:px-6" role="tablist" aria-label="Technology layers">
            {TABS.map((t) => {
              const Icon = LAYER_ICON[t.id];
              const on = tab === t.id;
              const group = choices.layers.filter((l) => t.layers.includes(l.layer));
              const applies = group.some((l) => l.applies);
              const summary = !applies ? "Not needed" : group.filter((l) => l.applies).map((l) => chosenLabel(l)).join(" · ");
              return (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  id={`tech-tab-${t.id}`}
                  aria-selected={on}
                  aria-controls={`tech-panel-${t.id}`}
                  onClick={() => setTab(t.id)}
                  className={`flex min-w-0 items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 ${on ? "border-violet-500 bg-violet-50 shadow-sm ring-1 ring-violet-500" : "border-slate-200 bg-white hover:border-violet-300 hover:bg-slate-50"} ${applies ? "" : "opacity-60"}`}
                  data-testid={`tech-tab-${t.id}`}
                >
                  <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition ${on ? "bg-violet-600 text-white" : "bg-slate-100 text-slate-500"}`}><Icon size={17} /></span>
                  <span className="min-w-0">
                    <span className={`block truncate text-sm font-semibold ${on ? "text-violet-800" : "text-slate-800"}`}>{t.label}</span>
                    <span className="block truncate text-[11px] text-slate-500">{summary}</span>
                  </span>
                </button>
              );
            })}
          </div>
        )}

        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4 sm:px-6" role="tabpanel" id={`tech-panel-${tab}`} aria-labelledby={`tech-tab-${tab}`}>
          {!choices && !error && <p className="flex items-center gap-2 py-8 text-sm text-slate-500"><Loader2 size={15} className="animate-spin" /> Loading options...</p>}
          {choices?.layers.filter((l) => TABS.find((t) => t.id === tab)!.layers.includes(l.layer)).map((layer) => {
            const options = layerOptions(layer);
            const plain = layer.layer === "styling" ? options.filter((o) => !o.frameworks?.length) : [];
            const libraries = layer.layer === "styling" ? options.filter((o) => o.frameworks?.length) : [];
            const heading = layer.layer === "styling" ? "Styling / UI library" : layer.label;
            return (
              <section key={layer.layer} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                <div>
                  <h3 className="text-sm font-semibold text-slate-900">{heading}</h3>
                  {layer.layer === "styling" && layer.applies && <p className="text-[11px] text-slate-500">Showing what works with {tech.frontend ? choices.layers.find((l) => l.layer === "frontend")?.options.find((o) => o.id === tech.frontend)?.label : "Next.js"}. Pick another frontend above to see its libraries.</p>}
                </div>
                {!layer.applies ? (
                  <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">This project needs no {layer.layer}, so there is nothing to choose.</p>
                ) : layer.layer === "styling" ? (
                  <div className="mt-3 space-y-3" role="radiogroup" aria-label={layer.label}>
                    <div>
                      <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-400">Styling approach</p>
                      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{plain.map((o) => renderOption(layer, o))}</div>
                    </div>
                    {libraries.length > 0 && (
                      <div>
                        <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-400">UI component libraries</p>
                        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{libraries.map((o) => renderOption(layer, o))}</div>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3" role="radiogroup" aria-label={layer.label}>
                    {options.map((o) => renderOption(layer, o))}
                  </div>
                )}
              </section>
            );
          })}
          {error && <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>}
        </div>

        <footer className="border-t border-slate-200 bg-white px-5 py-3.5 shadow-[0_-4px_12px_rgba(15,23,42,0.04)] sm:px-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            {preview ? (
              <div className="flex items-center gap-3" data-testid="tech-preview">
                <div>
                  <p className="text-[11px] text-slate-500">New total <span className="text-slate-400">(incl. GST)</span></p>
                  <p className="text-xl font-bold tabular-nums text-slate-900">{formatINR(preview.total)}{busy && <Loader2 size={13} className="ml-2 inline animate-spin text-slate-400" />}</p>
                </div>
                <span className={`rounded-full px-2.5 py-1 text-xs font-semibold tabular-nums ${preview.delta === 0 ? "bg-slate-100 text-slate-600" : preview.delta > 0 ? "bg-amber-100 text-amber-800" : "bg-emerald-100 text-emerald-800"}`}>
                  {preview.delta === 0 ? "Same as the quotation" : `${money(preview.delta)} vs the quotation`}
                </span>
              </div>
            ) : <span />}
            <div className="flex gap-2">
              <button type="button" onClick={onClose} disabled={applying} className="rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50">Cancel</button>
              <button type="button" disabled={!preview || busy || applying} onClick={() => preview && onApply(tech, preview)} className="flex items-center gap-2 rounded-xl bg-gradient-to-r from-violet-600 to-indigo-600 px-6 py-2.5 text-sm font-semibold text-white shadow-md shadow-violet-500/25 transition hover:brightness-110 disabled:opacity-50" data-testid="tech-apply">{applying && <Loader2 size={14} className="animate-spin" />}{applyLabel}</button>
            </div>
          </div>
        </footer>
      </div>
    </div>
  );
}
