"use client";

import { useState, type ReactNode } from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";

import {
  BRAND_COLOR_ROLES,
  FONT_SOURCES,
  FONT_SOURCE_LABELS,
  FONT_USAGES,
  FONT_USAGE_LABELS,
  FONT_WEIGHTS,
  FONT_WEIGHT_LABELS,
  MAX_BRAND_COLORS,
  MAX_BRAND_FONTS,
  MAX_COLOR_LABEL,
  MAX_FONT_CSS,
  MAX_TYPE_PX,
  MIN_BRAND_COLORS,
  MIN_TYPE_PX,
  MORE_COLORS,
  MORE_COLOR_GROUPS,
  STANDARD_TYPE_SCALE,
  TYPE_KEYS,
  TYPE_LABELS,
  blankFont,
  isBrandStyleText,
  normalizeHex,
  parseBrandStyle,
  serializeBrandStyle,
  type BrandFont,
  type BrandStyle,
  type FontSource,
  type FontUsage,
  type MoreColorKey,
  type TypeKey,
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

type TypeRow = { size: string; mobileSize: string; weight: string; lineHeight: string };
const emptyRow = (): TypeRow => ({ size: "", mobileSize: "", weight: "400", lineHeight: "" });
/** The form's text fields from saved text styles (a row that was not fixed stays empty). */
function rowsFrom(scale: Partial<Record<TypeKey, { size: number; mobileSize?: number; weight: number; lineHeight?: number }>> | undefined): Record<TypeKey, TypeRow> {
  return Object.fromEntries(TYPE_KEYS.map((k) => {
    const s = scale?.[k];
    return [k, s ? { size: String(s.size), mobileSize: s.mobileSize ? String(s.mobileSize) : "", weight: String(s.weight), lineHeight: s.lineHeight ? String(s.lineHeight) : "" } : emptyRow()];
  })) as Record<TypeKey, TypeRow>;
}
const rawScale = (rows: Record<TypeKey, TypeRow>) => Object.fromEntries(TYPE_KEYS.map((k) => [k, { size: rows[k].size, mobileSize: rows[k].mobileSize, weight: Number(rows[k].weight) || 400, lineHeight: rows[k].lineHeight }]));

const extraName = (style: BrandStyle, j: number) => style.labels?.[j]?.trim() || `Extra colour ${j + 1}`;

/**
 * The brand colours and fonts form: nine colour fields (more can be added) and one or more fonts (a button adds another).
 * Each font comes from Google Fonts, Adobe Fonts, or is imported (the client's own @font-face CSS, or uploaded font files).
 * Nothing is mandatory; what is filled in is checked, and saved as one value.
 */
export function BrandStyleEditor({ value, busy, tone, onSave, part = "all" }: { value: string; busy: boolean; tone: Tone; onSave: (text: string) => void; /** Show only the colours, only the fonts, or both. Both are always saved together. */ part?: "all" | "colors" | "fonts" }) {
  const t = T[tone];
  const stored = value.trim() && !isBrandStyleText(value) ? value.trim() : "";
  const [style, setStyle] = useState<BrandStyle>(() => parseBrandStyle(value));
  const [rows, setRows] = useState<Record<TypeKey, TypeRow>>(() => rowsFrom(parseBrandStyle(value).type));
  const [error, setError] = useState("");

  const initial = (() => { try { return serializeBrandStyle(parseBrandStyle(value)); } catch { return ""; } })();
  // The text styles are typed as text, so a half-typed number is never lost; they are checked when saved.
  const withType = (): BrandStyle => ({ ...style, type: rawScale(rows) } as unknown as BrandStyle);
  const current = (() => { try { return serializeBrandStyle(withType()); } catch { return null; } })();
  const changed = current === null || current !== initial;

  const setColor = (i: number, v: string) => { setError(""); setStyle((s) => ({ ...s, colors: s.colors.map((c, k) => (k === i ? v : c)) })); };
  const setMore = (k: MoreColorKey, v: string) => { setError(""); setStyle((s) => ({ ...s, more: { ...s.more, [k]: v } })); };
  const setLabel = (j: number, v: string) => { setError(""); setStyle((s) => { const labels = [...(s.labels ?? [])]; while (labels.length <= j) labels.push(""); labels[j] = v; return { ...s, labels }; }); };
  const addExtra = () => setStyle((s) => ({ ...s, colors: [...s.colors, ""], labels: [...(s.labels ?? []), ""] }));
  const removeExtra = (j: number) => setStyle((s) => ({ ...s, colors: s.colors.filter((_, k) => k !== MIN_BRAND_COLORS + j), labels: (s.labels ?? []).filter((_, k) => k !== j) }));
  const extras = style.colors.slice(MIN_BRAND_COLORS);

  /** One colour: a picker, the code, and (for your own colours) a name you can edit and a remove button. */
  const colorField = (id: string, label: string, value: string, onChange: (v: string) => void, opts?: { name?: ReactNode; onRemove?: () => void }) => {
    const hex = normalizeHex(value);
    return (
      <div key={id} className="space-y-1">
        {opts?.name ?? <label className={t.label} htmlFor={`brand-color-${tone}-${id}`}>{label}</label>}
        <div className="flex items-center gap-1.5">
          <input type="color" aria-label={`Pick ${label} colour`} value={hex ? hex.toLowerCase() : "#ffffff"} onChange={(e) => onChange(e.target.value.toUpperCase())} className={cn("h-9 w-9 shrink-0 cursor-pointer rounded-lg border bg-transparent p-0.5", t.swatchRing)} />
          <input id={`brand-color-${tone}-${id}`} value={value} onChange={(e) => onChange(e.target.value)} maxLength={7} placeholder="#0B3D91" spellCheck={false} aria-invalid={hex === null} className={cn(t.input, "font-mono", hex === null && "border-rose-400")} />
          {opts?.onRemove && <button type="button" aria-label={`Remove ${label}`} onClick={opts.onRemove} className={t.remove}><Trash2 size={14} /></button>}
        </div>
      </div>
    );
  };
  const setRow = (k: TypeKey, patch: Partial<TypeRow>) => { setError(""); setRows((r) => ({ ...r, [k]: { ...r[k], ...patch } })); };
  const setFont = (i: number, patch: Partial<BrandFont>) => { setError(""); setStyle((s) => ({ ...s, fonts: s.fonts.map((f, k) => (k === i ? { ...f, ...patch } : f)) })); };

  const save = () => {
    try {
      onSave(serializeBrandStyle(withType()));
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="space-y-4">
      {stored && <p className={cn(t.muted, "whitespace-pre-wrap rounded-lg border border-dashed border-current/20 p-2")}>Earlier note: {stored}</p>}

      {part !== "fonts" && (
      <div className="space-y-5" data-testid="colour-sections">
        {MORE_COLOR_GROUPS.map((group) => (
          <div key={group} className="space-y-2" data-testid={`colours-group-${group}`}>
            <p className={t.heading}>{group}</p>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {MORE_COLORS.filter((m) => m.group === group).map((m) => colorField(m.key, m.label, style.more?.[m.key] ?? "", (v) => setMore(m.key, v)))}
            </div>
          </div>
        ))}

        <div className="space-y-2">
          <p className={t.heading}>Colours <span className={cn("font-normal", t.muted)}>(at least {MIN_BRAND_COLORS}, use codes like #0B3D91)</span></p>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {style.colors.slice(0, MIN_BRAND_COLORS).map((c, i) => colorField(`core-${i}`, BRAND_COLOR_ROLES[i], c, (v) => setColor(i, v)))}
            {colorField("borders", "Borders and dividers", style.more?.borders ?? "", (v) => setMore("borders", v))}
          </div>
        </div>

        <div className="space-y-2" data-testid="colours-own">
          <p className={t.heading}>Your own colours <span className={cn("font-normal", t.muted)}>(give each one a name you can change)</span></p>
          {extras.length > 0 && (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {extras.map((c, j) => colorField(`extra-${j}`, extraName(style, j), c, (v) => setColor(MIN_BRAND_COLORS + j, v), {
                name: (
                  <input
                    aria-label={`Name of colour ${j + 1}`}
                    value={style.labels?.[j] ?? ""}
                    onChange={(e) => setLabel(j, e.target.value)}
                    maxLength={MAX_COLOR_LABEL}
                    placeholder={`Name, e.g. Sale badge`}
                    className={cn(t.input, "font-medium")}
                  />
                ),
                onRemove: () => removeExtra(j),
              }))}
            </div>
          )}
          <button type="button" disabled={style.colors.length >= MAX_BRAND_COLORS} onClick={addExtra} className={t.ghost} data-testid="add-colour">
            <Plus size={14} /> Add another colour
          </button>
        </div>
      </div>

      )}

      {part !== "colors" && (
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

      )}

      {part !== "colors" && (
      <div className="space-y-2" data-testid="type-scale">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className={t.heading}>Text sizes and weights <span className={cn("font-normal", t.muted)}>(optional: H1 to H6, paragraph and small text)</span></p>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => { setError(""); setRows(rowsFrom(STANDARD_TYPE_SCALE)); }} className={t.ghost} data-testid="type-standard">Use a standard scale</button>
            <button type="button" onClick={() => { setError(""); setRows(rowsFrom(undefined)); }} className={cn("rounded-lg px-3 py-2 text-xs", t.muted, "hover:underline")}>Clear</button>
          </div>
        </div>
        <p className={t.muted}>Give the size in px for a computer and, if you have it, for a phone. Leave a row empty if the brand does not fix it: the designer then chooses a size that fits.</p>
        <div className={cn(t.card, "space-y-3")}>
          <div className={cn("hidden gap-2 sm:grid sm:grid-cols-[1.15fr_0.85fr_0.85fr_1.7fr_0.85fr]", t.label)}>
            <span>Text</span><span>Computer (px)</span><span>Phone (px)</span><span>Weight</span><span>Line height</span>
          </div>
          {TYPE_KEYS.map((k) => {
            const r = rows[k];
            const size = Number(r.size);
            const sample = Number.isFinite(size) && size >= MIN_TYPE_PX ? Math.min(size, 56) : 0;
            // The preview uses the heading font for H1 to H6 and the body font for the rest, when they are named (quotes are removed so a name can never break the style).
            const family = (/^h[1-6]$/.test(k) ? style.fonts.find((f) => f.usage === "heading" && f.name) : style.fonts.find((f) => f.usage === "body" && f.name))?.name.replace(/[\\"']/g, "");
            return (
              <div key={k} className="space-y-1">
                <div className="grid items-center gap-2 sm:grid-cols-[1.15fr_0.85fr_0.85fr_1.7fr_0.85fr]">
                  <span className={cn("text-sm font-medium", tone === "light" ? "text-slate-800" : "text-slate-200")}>{TYPE_LABELS[k]}</span>
                  <input aria-label={`${TYPE_LABELS[k]} size on a computer in px`} type="number" min={MIN_TYPE_PX} max={MAX_TYPE_PX} value={r.size} onChange={(e) => setRow(k, { size: e.target.value })} placeholder="e.g. 32" className={t.input} />
                  <input aria-label={`${TYPE_LABELS[k]} size on a phone in px`} type="number" min={MIN_TYPE_PX} max={MAX_TYPE_PX} value={r.mobileSize} onChange={(e) => setRow(k, { mobileSize: e.target.value })} placeholder="optional" className={t.input} />
                  <select aria-label={`${TYPE_LABELS[k]} weight`} value={r.weight} onChange={(e) => setRow(k, { weight: e.target.value })} className={cn(t.input, t.option)}>
                    {FONT_WEIGHTS.map((w) => <option key={w} value={String(w)}>{FONT_WEIGHT_LABELS[w]} {w}</option>)}
                  </select>
                  <input aria-label={`${TYPE_LABELS[k]} line height`} type="number" step="0.05" min={0.8} max={3} value={r.lineHeight} onChange={(e) => setRow(k, { lineHeight: e.target.value })} placeholder="e.g. 1.2" className={t.input} />
                </div>
                {sample > 0 && (
                  <p className={cn("truncate", tone === "light" ? "text-slate-700" : "text-slate-300")} style={{ fontSize: sample, fontWeight: Number(r.weight) || 400, lineHeight: Number(r.lineHeight) || 1.3, ...(family ? { fontFamily: `"${family}", sans-serif` } : {}) }}>
                    The quick brown fox
                  </p>
                )}
              </div>
            );
          })}
        </div>
      </div>
      )}

      {error && <p className={t.error}>{error}</p>}
      <button type="button" disabled={busy || !changed} onClick={save} className={t.primary}>
        {busy && <Loader2 size={14} className="animate-spin" />} {part === "colors" ? "Save colours" : part === "fonts" ? "Save fonts and text styles" : "Save colours, fonts and text styles"}
      </button>
    </div>
  );
}

/** Read-only view of a saved brand style: the colour swatches and the fonts. */
export function BrandStyleSummary({ value, tone }: { value: string; tone: Tone }) {
  const t = T[tone];
  const style = parseBrandStyle(value);
  const colors = [
    ...style.colors.slice(0, MIN_BRAND_COLORS).map((c, i) => ({ c, role: BRAND_COLOR_ROLES[i] as string })),
    ...MORE_COLORS.map((m) => ({ c: style.more?.[m.key] ?? "", role: m.label })),
    ...style.colors.slice(MIN_BRAND_COLORS).map((c, j) => ({ c, role: extraName(style, j) })),
  ].filter((x) => x.c);
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
