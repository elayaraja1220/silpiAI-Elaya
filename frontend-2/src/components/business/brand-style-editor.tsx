"use client";

import { useState } from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";

import {
  BRAND_COLOR_ROLES,
  FONT_SOURCES,
  FONT_SOURCE_LABELS,
  FONT_USAGES,
  FONT_USAGE_LABELS,
  MAX_BRAND_COLORS,
  MAX_BRAND_FONTS,
  MAX_FONT_CSS,
  MIN_BRAND_COLORS,
  blankFont,
  isBrandStyleText,
  normalizeHex,
  parseBrandStyle,
  serializeBrandStyle,
  type BrandFont,
  type BrandStyle,
  type FontSource,
  type FontUsage,
} from "@/lib/business/assets";
import { cn } from "@/lib/utils";

type Tone = "light" | "dark";

const T = {
  light: {
    input: "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none placeholder:text-slate-400 focus:border-violet-500",
    label: "text-xs font-medium text-slate-600",
    muted: "text-xs text-slate-500",
    card: "rounded-xl border border-slate-200 bg-slate-50 p-3",
    heading: "text-sm font-semibold text-slate-800",
    ghost: "flex items-center gap-1.5 rounded-lg border border-dashed border-violet-400 bg-violet-50 px-3 py-2 text-sm font-medium text-violet-700 hover:bg-violet-100",
    primary: "flex items-center gap-2 rounded-lg bg-violet-600 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-500 disabled:opacity-50",
    remove: "rounded-md p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600",
    error: "rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700",
    option: "",
    swatchRing: "border-slate-300",
  },
  dark: {
    input: "w-full rounded-lg border border-white/[.08] bg-white/[.03] px-3 py-2 text-xs text-slate-100 outline-none placeholder:text-slate-600 focus:border-violet-400/60",
    label: "text-[11px] font-medium text-slate-400",
    muted: "text-[11px] text-slate-500",
    card: "rounded-xl border border-white/[.07] bg-black/20 p-3",
    heading: "text-xs font-semibold text-slate-200",
    ghost: "flex items-center gap-1.5 rounded-lg border border-dashed border-violet-400/50 bg-violet-500/10 px-3 py-2 text-xs font-medium text-violet-200 hover:bg-violet-500/20",
    primary: "flex items-center gap-2 rounded-lg bg-violet-500 px-4 py-2 text-xs font-semibold text-white hover:bg-violet-400 disabled:opacity-50",
    remove: "rounded-md p-1.5 text-slate-500 hover:bg-rose-500/10 hover:text-rose-300",
    error: "rounded-lg border border-rose-400/20 bg-rose-500/10 px-3 py-2 text-xs text-rose-200",
    option: "[&>option]:bg-[#121620]",
    swatchRing: "border-white/20",
  },
} as const;

const roleOf = (i: number) => (i < BRAND_COLOR_ROLES.length ? BRAND_COLOR_ROLES[i] : `Extra colour ${i - BRAND_COLOR_ROLES.length + 1}`);

/**
 * The brand colours and fonts form: nine colour fields (more can be added) and one or more fonts (a button adds another).
 * Each font comes from Google Fonts, Adobe Fonts, or is imported (the client's own @font-face CSS, or uploaded font files).
 * Nothing is mandatory; what is filled in is checked, and saved as one value.
 */
export function BrandStyleEditor({ value, busy, tone, onSave }: { value: string; busy: boolean; tone: Tone; onSave: (text: string) => void }) {
  const t = T[tone];
  const stored = value.trim() && !isBrandStyleText(value) ? value.trim() : "";
  const [style, setStyle] = useState<BrandStyle>(() => parseBrandStyle(value));
  const [error, setError] = useState("");

  const initial = (() => { try { return serializeBrandStyle(parseBrandStyle(value)); } catch { return ""; } })();
  const current = (() => { try { return serializeBrandStyle(style); } catch { return null; } })();
  const changed = current === null || current !== initial;

  const setColor = (i: number, v: string) => { setError(""); setStyle((s) => ({ ...s, colors: s.colors.map((c, k) => (k === i ? v : c)) })); };
  const setFont = (i: number, patch: Partial<BrandFont>) => { setError(""); setStyle((s) => ({ ...s, fonts: s.fonts.map((f, k) => (k === i ? { ...f, ...patch } : f)) })); };

  const save = () => {
    try {
      onSave(serializeBrandStyle(style));
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="space-y-4">
      {stored && <p className={cn(t.muted, "whitespace-pre-wrap rounded-lg border border-dashed border-current/20 p-2")}>Earlier note: {stored}</p>}

      <div className="space-y-2">
        <p className={t.heading}>Colours <span className={cn("font-normal", t.muted)}>(at least {MIN_BRAND_COLORS}, use codes like #0B3D91)</span></p>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {style.colors.map((c, i) => {
            const hex = normalizeHex(c);
            return (
              <div key={i} className="space-y-1">
                <label className={t.label} htmlFor={`brand-color-${tone}-${i}`}>{roleOf(i)}</label>
                <div className="flex items-center gap-1.5">
                  <input
                    type="color"
                    aria-label={`Pick ${roleOf(i)} colour`}
                    value={hex ? hex.toLowerCase() : "#ffffff"}
                    onChange={(e) => setColor(i, e.target.value.toUpperCase())}
                    className={cn("h-9 w-9 shrink-0 cursor-pointer rounded-lg border bg-transparent p-0.5", t.swatchRing)}
                  />
                  <input
                    id={`brand-color-${tone}-${i}`}
                    value={c}
                    onChange={(e) => setColor(i, e.target.value)}
                    maxLength={7}
                    placeholder="#0B3D91"
                    spellCheck={false}
                    aria-invalid={hex === null}
                    className={cn(t.input, "font-mono", hex === null && "border-rose-400")}
                  />
                  {i >= MIN_BRAND_COLORS && (
                    <button type="button" aria-label={`Remove ${roleOf(i)}`} onClick={() => setStyle((s) => ({ ...s, colors: s.colors.filter((_, k) => k !== i) }))} className={t.remove}><Trash2 size={14} /></button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        <button type="button" disabled={style.colors.length >= MAX_BRAND_COLORS} onClick={() => setStyle((s) => ({ ...s, colors: [...s.colors, ""] }))} className={t.ghost}>
          <Plus size={14} /> Add another colour
        </button>
      </div>

      <div className="space-y-2">
        <p className={t.heading}>Fonts <span className={cn("font-normal", t.muted)}>(Google Fonts, Adobe Fonts or your own font)</span></p>
        {style.fonts.map((f, i) => (
          <div key={i} className={cn(t.card, "space-y-2.5")}>
            <div className="flex items-center justify-between">
              <span className={t.label}>Font {i + 1}</span>
              {style.fonts.length > 1 && (
                <button type="button" aria-label={`Remove font ${i + 1}`} onClick={() => setStyle((s) => ({ ...s, fonts: s.fonts.filter((_, k) => k !== i) }))} className={t.remove}><Trash2 size={14} /></button>
              )}
            </div>
            <div className="grid gap-2 sm:grid-cols-3">
              <div className="space-y-1 sm:col-span-1">
                <label className={t.label} htmlFor={`brand-font-name-${tone}-${i}`}>Font name</label>
                <input id={`brand-font-name-${tone}-${i}`} value={f.name} onChange={(e) => setFont(i, { name: e.target.value })} maxLength={80} placeholder="e.g. Poppins" className={t.input} />
              </div>
              <div className="space-y-1">
                <label className={t.label} htmlFor={`brand-font-source-${tone}-${i}`}>Where it comes from</label>
                <select id={`brand-font-source-${tone}-${i}`} value={f.source} onChange={(e) => setFont(i, { source: e.target.value as FontSource })} className={cn(t.input, t.option)}>
                  {FONT_SOURCES.map((s) => <option key={s} value={s}>{FONT_SOURCE_LABELS[s]}</option>)}
                </select>
              </div>
              <div className="space-y-1">
                <label className={t.label} htmlFor={`brand-font-usage-${tone}-${i}`}>Used for</label>
                <select id={`brand-font-usage-${tone}-${i}`} value={f.usage} onChange={(e) => setFont(i, { usage: e.target.value as FontUsage })} className={cn(t.input, t.option)}>
                  {FONT_USAGES.map((u) => <option key={u} value={u}>{FONT_USAGE_LABELS[u]}</option>)}
                </select>
              </div>
            </div>

            {f.source === "google" && (
              <div className="space-y-1">
                <label className={t.label} htmlFor={`brand-font-link-${tone}-${i}`}>Google Fonts link (optional)</label>
                <input id={`brand-font-link-${tone}-${i}`} value={f.link} onChange={(e) => setFont(i, { link: e.target.value })} maxLength={500} placeholder="https://fonts.googleapis.com/css2?family=Poppins" className={t.input} />
                <p className={t.muted}>If you leave this empty, we load the font from Google Fonts by its name.</p>
              </div>
            )}
            {f.source === "adobe" && (
              <div className="space-y-1">
                <label className={t.label} htmlFor={`brand-font-link-${tone}-${i}`}>Adobe Fonts link or kit ID</label>
                <input id={`brand-font-link-${tone}-${i}`} value={f.link} onChange={(e) => setFont(i, { link: e.target.value })} maxLength={500} placeholder="https://use.typekit.net/abc1def.css  or  abc1def" className={t.input} />
                <p className={t.muted}>Adobe Fonts only work with the web project kit from your Adobe account, so please send the kit link or its ID.</p>
              </div>
            )}
            {f.source === "imported" && (
              <div className="space-y-1">
                <label className={t.label} htmlFor={`brand-font-css-${tone}-${i}`}>@font-face CSS (optional)</label>
                <textarea
                  id={`brand-font-css-${tone}-${i}`}
                  value={f.css}
                  onChange={(e) => setFont(i, { css: e.target.value })}
                  maxLength={MAX_FONT_CSS}
                  rows={5}
                  spellCheck={false}
                  placeholder={"@font-face {\n  font-family: 'MyFont';\n  src: url('MyFont.woff2') format('woff2');\n  font-weight: 400;\n}"}
                  className={cn(t.input, "font-mono")}
                />
                <p className={t.muted}>Paste your @font-face rule, and/or upload the font files (WOFF2, WOFF, TTF or OTF) with the upload button below.</p>
              </div>
            )}
          </div>
        ))}
        <button type="button" disabled={style.fonts.length >= MAX_BRAND_FONTS} onClick={() => setStyle((s) => ({ ...s, fonts: [...s.fonts, blankFont()] }))} className={t.ghost}>
          <Plus size={14} /> Add another font
        </button>
      </div>

      {error && <p className={t.error}>{error}</p>}
      <button type="button" disabled={busy || !changed} onClick={save} className={t.primary}>
        {busy && <Loader2 size={14} className="animate-spin" />} Save colours and fonts
      </button>
    </div>
  );
}

/** Read-only view of a saved brand style: the colour swatches and the fonts. */
export function BrandStyleSummary({ value, tone }: { value: string; tone: Tone }) {
  const t = T[tone];
  const style = parseBrandStyle(value);
  const colors = style.colors.map((c, i) => ({ c, role: roleOf(i) })).filter((x) => x.c);
  const fonts = style.fonts.filter((f) => f.name);
  return (
    <div className="mt-3 space-y-2">
      {colors.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {colors.map(({ c, role }) => (
            <span key={role + c} title={role} className={cn("flex items-center gap-1.5 rounded-full border px-2 py-1 text-[11px]", t.swatchRing, t.muted)}>
              <span className="h-3.5 w-3.5 rounded-full border border-black/10" style={{ background: c }} /> {c}
            </span>
          ))}
        </div>
      )}
      {fonts.length > 0 && <p className={t.muted}>{fonts.map((f) => `${f.name} (${FONT_SOURCE_LABELS[f.source]})`).join(" · ")}</p>}
    </div>
  );
}
