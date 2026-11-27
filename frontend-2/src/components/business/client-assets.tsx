"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, CheckCircle2, ChevronLeft, FileText, FolderInput, Images, Info, Loader2, Palette, Trash2, Type, Upload, type LucideIcon } from "lucide-react";

import { DOT, entriesOf, entryStatus, GROUP_ICON, GROUP_LABEL, hasContent, PILL, type Entry } from "@/components/business/assets-layout";
import { BrandStyleEditor, BrandStyleSummary } from "@/components/business/brand-style-editor";
import {
  ACCEPT_ATTRIBUTE,
  ASSET_GROUPS,
  ASSET_STATUS_LABELS,
  MAX_FILE_BYTES,
  MIN_BRAND_COLORS,
  assetProgress,
  extensionOf,
  formatBytes,
  isBrandStyleText,
  parseBrandStyle,
  type ClientAsset,
} from "@/lib/business/assets";
import { cn } from "@/lib/utils";

type Reply = { success?: boolean; error?: string; available?: boolean; assets?: ClientAsset[] };
type Actions = { busy: string; onUpload: (assetId: string, files: FileList) => void; onText: (assetId: string, text: string) => void; onRemove: (assetId: string, fileId: string) => void };

/**
 * The client's side of "Client files & design", after approval: the same layout as the team's tab (a content menu on the left, the item in the middle, a
 * status box on the right), with only what a client does: send files, type content, remove a file they sent. Checking and marking received stay with the team.
 */
export function ClientAssets({ token }: { token: string }) {
  const base = `/api/client/${encodeURIComponent(token)}/assets`;
  const [assets, setAssets] = useState<ClientAsset[] | null>(null);
  const [available, setAvailable] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [selected, setSelected] = useState("");

  const apply = (r: Reply) => {
    if (!r.success) throw new Error(r.error || "Something went wrong. Please try again.");
    setAvailable(r.available === true);
    setAssets(r.assets ?? []);
    setError("");
  };
  const load = useCallback(() => {
    fetch(base, { cache: "no-store" }).then((r) => r.json()).then((r: Reply) => apply(r)).catch((e: Error) => setError(e.message));
  }, [base]);
  useEffect(load, [load]);

  const send = async (assetId: string, init: RequestInit, url = base) => {
    setBusy(assetId);
    setError("");
    try {
      const res = await fetch(url, init);
      apply((await res.json().catch(() => ({}))) as Reply);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  const actions: Actions = {
    busy,
    onUpload: (assetId, files) => {
      const big = Array.from(files).find((f) => f.size > MAX_FILE_BYTES);
      if (big) { setError(`"${big.name}" is larger than ${MAX_FILE_BYTES / 1048576} MB. Please send a smaller file, or put the link in the text.`); return; }
      const form = new FormData();
      form.append("assetId", assetId);
      Array.from(files).forEach((f) => form.append("files", f));
      void send(assetId, { method: "POST", body: form });
    },
    onText: (assetId, text) => void send(assetId, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ assetId, text }) }),
    onRemove: (assetId, fileId) => void send(assetId, { method: "DELETE" }, `${base}?fileId=${encodeURIComponent(fileId)}`),
  };

  if (!assets || !available || assets.length === 0) return null;
  const entries = entriesOf(assets);
  const index = Math.max(0, entries.findIndex((e) => e.key === selected));
  const current = entries[index];
  const progress = assetProgress(assets);
  const glance = [
    { label: "Sent", value: progress.sent, tone: "text-sky-300" },
    { label: "Received", value: progress.received, tone: "text-emerald-300" },
    { label: "Send again", value: assets.filter((a) => a.status === "redo").length, tone: "text-amber-300" },
    { label: "Waiting", value: assets.filter((a) => !hasContent(a)).length, tone: "text-slate-300" },
  ];
  const pager = { hasPrev: index > 0, hasNext: index < entries.length - 1, onPrev: () => setSelected(entries[index - 1].key), onNext: () => setSelected(entries[index + 1].key) };

  return (
    <section id="send-files" className="space-y-4" data-testid="client-files">
     {/* The summary is a card of its own, above the panel with the files. */}
     <div className="overflow-hidden rounded-2xl border border-white/[.08] bg-gradient-to-br from-[#171b2e] to-[#10131f]">
      <div className="flex flex-wrap items-center justify-between gap-4 px-5 py-4">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-violet-500/15 text-violet-300"><FolderInput size={18} /></span>
          <div>
            <h2 className="text-sm font-semibold text-slate-100">Your files, designs and content</h2>
            <p className="mt-0.5 text-xs text-slate-400">{progress.sent} of {progress.total} items sent. Nothing is mandatory: send what you have, one item at a time, and come back any time for the rest.</p>
          </div>
        </div>
        <dl className="flex flex-wrap gap-2">
          {glance.map((g) => (
            <div key={g.label} className="min-w-[72px] rounded-lg border border-white/[.07] bg-white/[.03] px-3 py-1.5 text-center">
              <dd className={cn("text-base font-semibold tabular-nums", g.tone)}>{g.value}</dd>
              <dt className="text-[10px] uppercase tracking-wider text-slate-500">{g.label}</dt>
            </div>
          ))}
        </dl>
      </div>
      <div className="h-1 bg-white/[.06]"><div className="h-full bg-gradient-to-r from-violet-500 to-emerald-400 transition-all" style={{ width: `${progress.percent}%` }} /></div>
     </div>
     <div className="overflow-hidden rounded-2xl border border-white/[.08] bg-white/[.03]">
      {error && <p className="m-4 rounded-lg border border-rose-400/20 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">{error}</p>}

      <div className="grid lg:grid-cols-[240px_1fr]">
        <nav aria-label="Your files" className="border-b border-white/[.07] bg-black/25 lg:border-b-0 lg:border-r">
          <label className="block p-3 lg:hidden">
            <span className="sr-only">Choose an item</span>
            <select value={current.key} onChange={(e) => setSelected(e.target.value)} className="w-full rounded-lg border border-white/[.1] bg-[#121620] px-3 py-2 text-sm text-slate-100 outline-none">
              {entries.map((e) => <option key={e.key} value={e.key}>{GROUP_LABEL[e.group] ?? e.group}: {e.label} ({ASSET_STATUS_LABELS[entryStatus(e.assets)]})</option>)}
            </select>
          </label>
          <div className="hidden max-h-[640px] overflow-y-auto py-2 lg:block">
            {ASSET_GROUPS.map((group) => {
              const items = entries.filter((e) => e.group === group);
              if (!items.length) return null;
              const Icon = GROUP_ICON[group];
              return (
                <div key={group} className="mb-1">
                  <p className="flex items-center gap-2 px-4 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-[.14em] text-slate-500"><Icon size={12} /> {GROUP_LABEL[group] ?? group}</p>
                  {items.map((e) => {
                    const on = e.key === current.key;
                    const status = entryStatus(e.assets);
                    const files = e.assets.reduce((n, a) => n + a.files.length, 0);
                    return (
                      <button
                        key={e.key}
                        type="button"
                        onClick={() => setSelected(e.key)}
                        aria-current={on ? "true" : undefined}
                        className={cn("flex w-full items-center gap-2.5 border-l-[3px] px-4 py-2 text-left text-[13px] transition", on ? "border-violet-400 bg-violet-500/10 font-medium text-white" : "border-transparent text-slate-400 hover:bg-white/[.04] hover:text-slate-100")}
                      >
                        <span className={cn("h-2 w-2 shrink-0 rounded-full", DOT[status])} title={ASSET_STATUS_LABELS[status]} />
                        <span className="min-w-0 flex-1 truncate">{e.label}</span>
                        {files > 0 && <span className="rounded-full bg-white/10 px-1.5 text-[10px] text-slate-300">{files}</span>}
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </nav>

        {current.key === "brand" ? (
          <BrandIdentity key={`brand-${current.assets.map((a) => a.updatedAt).join("|")}`} assets={current.assets} actions={actions} pager={pager} />
        ) : current.page ? (
          <PageEditor key={`page-${current.assets.map((a) => `${a.id}-${a.updatedAt}`).join("|")}`} page={current.page} name={current.label} actions={actions} pager={pager} />
        ) : (
          <ItemEditor key={`${current.assets[0].id}-${current.assets[0].updatedAt}`} asset={current.assets[0]} actions={actions} pager={pager} />
        )}
      </div>
     </div>
    </section>
  );
}

type Pager = { hasPrev: boolean; hasNext: boolean; onPrev: () => void; onNext: () => void };

function PagerBar({ hasPrev, hasNext, onPrev, onNext }: Pager) {
  return (
    <footer className="flex items-center justify-between border-t border-white/[.07] pt-4">
      <button type="button" disabled={!hasPrev} onClick={onPrev} className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs text-slate-400 hover:bg-white/5 hover:text-white disabled:opacity-30"><ChevronLeft size={14} /> Previous item</button>
      <button type="button" disabled={!hasNext} onClick={onNext} className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs text-slate-300 hover:bg-white/5 hover:text-white disabled:opacity-30">Next item <ArrowRight size={14} /></button>
    </footer>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex gap-3 rounded-lg border border-white/[.07] border-l-[3px] border-l-sky-400 bg-sky-400/[.06] px-4 py-3 text-xs leading-5 text-slate-300">
      <Info size={15} className="mt-0.5 shrink-0 text-sky-300" />
      <p>{children}</p>
    </div>
  );
}

const Pill = ({ asset: a }: { asset: ClientAsset }) => (
  <span className={cn("inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium", PILL[a.status])}>{a.status === "received" && <CheckCircle2 size={11} />} {ASSET_STATUS_LABELS[a.status]}</span>
);

/** What the team asked to be sent again, or that a received item is closed. */
function ItemNotes({ asset: a }: { asset: ClientAsset }) {
  if (a.status === "redo" && a.note) return <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs leading-5 text-amber-200"><b>Please send again:</b> {a.note}</p>;
  if (a.status === "received") return <p className="rounded-lg bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200">Received and checked. Thank you! If something has changed, tell us in the chat.</p>;
  return null;
}

/** The files the client sent, and a drop zone to add more (not once the item is received). */
function DropZone({ asset: a, busy, compact = false, onUpload, onRemove }: { asset: ClientAsset; busy: boolean; compact?: boolean; onUpload: (f: FileList) => void; onRemove: (fileId: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const locked = a.status === "received";
  return (
    <div className="space-y-2">
      <input ref={input} type="file" multiple accept={ACCEPT_ATTRIBUTE} hidden onChange={(e) => { if (e.target.files?.length) onUpload(e.target.files); e.target.value = ""; }} />
      {a.files.length > 0 && (
        <ul className="grid gap-2 sm:grid-cols-2">
          {a.files.map((f) => (
            <li key={f.id} className="flex items-center gap-2.5 rounded-lg border border-white/[.08] bg-black/25 px-3 py-2">
              <span className="flex h-9 w-9 shrink-0 flex-col items-center justify-center rounded-md bg-white/[.05] text-slate-400"><FileText size={15} /><span className="text-[8px] font-semibold uppercase">{extensionOf(f.name) || "file"}</span></span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium text-slate-200" title={f.name}>{f.name}</span>
                <span className="block text-[10px] text-slate-500">{formatBytes(f.size)}{f.by === "client" ? "" : " · added by us"}</span>
              </span>
              {!locked && <button type="button" aria-label={`Remove ${f.name}`} disabled={busy} onClick={() => onRemove(f.id)} className="rounded-md p-1.5 text-slate-500 hover:bg-rose-500/15 hover:text-rose-300 disabled:opacity-40"><Trash2 size={14} /></button>}
            </li>
          ))}
        </ul>
      )}
      {!locked && (
        <div
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => { e.preventDefault(); setDragging(false); if (e.dataTransfer.files.length) onUpload(e.dataTransfer.files); }}
          className={cn("rounded-xl border-2 border-dashed transition", dragging ? "border-violet-400 bg-violet-500/10" : "border-white/[.1] bg-white/[.015]")}
        >
          <button type="button" disabled={busy} onClick={() => input.current?.click()} className={cn("flex w-full flex-col items-center gap-2 text-center text-xs text-slate-500 hover:text-slate-300 disabled:opacity-50", compact ? "py-5" : "py-8")}>
            {busy ? <Loader2 size={20} className="animate-spin text-violet-300" /> : <Upload size={compact ? 18 : 22} className="text-slate-600" />}
            <span><b className="text-slate-300">{a.files.length ? "Add more files" : "Drop a file here"}</b> or click to choose</span>
            {!compact && <span className="text-[11px]">Images, PDF, Word, Excel, design files, fonts or ZIP · up to {MAX_FILE_BYTES / 1048576} MB each</span>}
          </button>
        </div>
      )}
    </div>
  );
}

/** A text box with a word count and a save button. */
function TextBox({ asset: a, busy, rows, label, onSave }: { asset: ClientAsset; busy: boolean; rows: number; label: string; onSave: (t: string) => void }) {
  const [text, setText] = useState(a.text);
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  if (a.status === "received") return a.text.trim() ? <p className="line-clamp-6 whitespace-pre-wrap rounded-lg border border-white/[.07] bg-black/20 px-3 py-2 text-xs text-slate-400">{a.text}</p> : null;
  return (
    <div>
      <div className="overflow-hidden rounded-lg border border-white/[.09] bg-white/[.02] focus-within:border-violet-400/60">
        <div className="flex items-center justify-between border-b border-white/[.07] bg-black/20 px-3 py-1.5 text-[11px] text-slate-500"><span>{label}</span><span>{words} word{words === 1 ? "" : "s"}</span></div>
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={rows} maxLength={20000} aria-label={`${a.label}: ${label}`} placeholder="Type or paste here" className="w-full resize-y bg-transparent px-3 py-2 text-sm leading-6 text-slate-100 outline-none placeholder:text-slate-600" />
      </div>
      <button type="button" disabled={busy || text === a.text || !text.trim()} onClick={() => onSave(text)} className="mt-2 flex items-center gap-2 rounded-lg bg-violet-500 px-4 py-2 text-xs font-semibold text-white hover:bg-violet-400 disabled:opacity-40">
        {busy && <Loader2 size={13} className="animate-spin" />} Save text
      </button>
    </div>
  );
}

/** The right-hand status box for one item. */
function StatusBox({ asset: a }: { asset: ClientAsset }) {
  return (
    <aside className="border-t border-white/[.07] bg-black/15 p-4 xl:border-l xl:border-t-0">
      <section className="overflow-hidden rounded-lg border border-white/[.09] bg-[#121620]">
        <h3 className="border-b border-white/[.07] bg-black/20 px-4 py-2.5 text-xs font-semibold text-slate-200">Status</h3>
        <dl className="space-y-2.5 px-4 py-3 text-xs">
          <div className="flex items-center justify-between gap-2"><dt className="text-slate-500">Status</dt><dd><Pill asset={a} /></dd></div>
          <div className="flex justify-between gap-2"><dt className="text-slate-500">Files</dt><dd className="text-slate-200">{a.files.length}</dd></div>
          {a.kind !== "files" && <div className="flex justify-between gap-2"><dt className="text-slate-500">Text</dt><dd className="text-slate-200">{a.text.trim() ? `${a.text.trim().length} characters` : "None"}</dd></div>}
        </dl>
        <p className="border-t border-white/[.07] bg-black/15 px-4 py-3 text-[11px] leading-4 text-slate-500">
          {a.status === "received" ? "We have checked this item." : hasContent(a) ? "Sent. We will check it and mark it received." : "Nothing sent yet. If you do not have it, we use a placeholder."}
        </p>
      </section>
    </aside>
  );
}

function ItemEditor({ asset: a, actions, pager }: { asset: ClientAsset; actions: Actions; pager: Pager }) {
  const busy = actions.busy === a.id;
  return (
    <div className="grid min-w-0 xl:grid-cols-[1fr_250px]">
      <article className="min-w-0 space-y-5 p-5 sm:p-6">
        <header>
          <p className="text-[11px] uppercase tracking-[.16em] text-slate-500">{GROUP_LABEL[a.group] ?? a.group}</p>
          <h3 className="mt-1 text-xl font-semibold tracking-tight text-slate-50">{a.label}</h3>
        </header>
        <Notice>{a.hint}</Notice>
        <ItemNotes asset={a} />
        {a.kind !== "files" && <TextBox asset={a} busy={busy} rows={a.kind === "text" ? 8 : 5} label={a.kind === "text" ? "Content" : "Or type the text here"} onSave={(t) => actions.onText(a.id, t)} />}
        {a.kind !== "text" && <DropZone asset={a} busy={busy} onUpload={(f) => actions.onUpload(a.id, f)} onRemove={(fid) => actions.onRemove(a.id, fid)} />}
        <PagerBar {...pager} />
      </article>
      <StatusBox asset={a} />
    </div>
  );
}

/** One column of a page: its design, or its content document (with a text box). */
function PageColumn({ title, asset: a, withText, actions }: { title: string; asset: ClientAsset; withText?: boolean; actions: Actions }) {
  const busy = actions.busy === a.id;
  return (
    <section className={cn("min-w-0 overflow-hidden rounded-xl border", a.status === "received" ? "border-emerald-400/20" : a.status === "redo" ? "border-amber-400/30" : "border-white/[.09]")} data-testid="page-column">
      <div className="flex items-center justify-between gap-2 border-b border-white/[.07] bg-black/20 px-4 py-2.5">
        <h4 className="truncate text-sm font-semibold text-slate-100">{title}</h4>
        <Pill asset={a} />
      </div>
      <div className="space-y-3 p-4">
        <p className="text-xs leading-5 text-slate-400">{a.hint}</p>
        <ItemNotes asset={a} />
        {withText && <TextBox asset={a} busy={busy} rows={5} label="Typed content" onSave={(t) => actions.onText(a.id, t)} />}
        <DropZone asset={a} busy={busy} compact onUpload={(f) => actions.onUpload(a.id, f)} onRemove={(fid) => actions.onRemove(a.id, fid)} />
      </div>
    </section>
  );
}

function PageEditor({ page, name, actions, pager }: { page: NonNullable<Entry["page"]>; name: string; actions: Actions; pager: Pager }) {
  const { content, design } = page;
  return (
    <article className="min-w-0 space-y-5 p-5 sm:p-6">
      <header>
        <p className="text-[11px] uppercase tracking-[.16em] text-slate-500">Page</p>
        <h3 className="mt-1 text-xl font-semibold tracking-tight text-slate-50">{name}</h3>
      </header>
      <div className={cn("grid gap-5", design && "xl:grid-cols-2")}>
        {design && <PageColumn title="Design" asset={design} actions={actions} />}
        <PageColumn title="Content document" withText asset={content} actions={actions} />
      </div>
      <PagerBar {...pager} />
    </article>
  );
}

type BrandTab = "logos" | "fonts" | "colors";

/** Logos, fonts and colours as three tabs, with an overall status box. */
function BrandIdentity({ assets, actions, pager }: { assets: ClientAsset[]; actions: Actions; pager: Pager }) {
  const [tab, setTab] = useState<BrandTab>("logos");
  const status = entryStatus(assets);
  const logos = assets.filter((a) => a.key !== "brand-style");
  const style = assets.find((a) => a.key === "brand-style");
  const parsed = style && isBrandStyleText(style.text) ? parseBrandStyle(style.text) : null;
  const colorCount = parsed ? parsed.colors.slice(0, MIN_BRAND_COLORS).filter(Boolean).length : 0;
  const fontCount = parsed ? parsed.fonts.filter((f) => f.name).length : 0;
  // Font files only matter for an imported font; they are offered there, not as a general upload.
  const showFontFiles = !!style && (style.files.length > 0 || !!parsed?.fonts.some((f) => f.source === "imported"));
  const tabs: { id: BrandTab; label: string; icon: LucideIcon; note: string }[] = [
    { id: "logos", label: "Logos", icon: Images, note: `${logos.filter(hasContent).length}/${logos.length}` },
    { id: "fonts", label: "Fonts", icon: Type, note: fontCount ? String(fontCount) : "none" },
    { id: "colors", label: "Colours", icon: Palette, note: `${colorCount}/${MIN_BRAND_COLORS}` },
  ];

  return (
    <div className="grid min-w-0 xl:grid-cols-[1fr_250px]">
      <article className="min-w-0 space-y-5 p-5 sm:p-6">
        <header>
          <p className="text-[11px] uppercase tracking-[.16em] text-slate-500">Brand</p>
          <h3 className="mt-1 text-xl font-semibold tracking-tight text-slate-50">Brand identity</h3>
        </header>
        <div role="tablist" aria-label="Brand identity" className="flex gap-1 rounded-xl border border-white/[.08] bg-black/20 p-1">
          {tabs.map((t) => {
            const on = t.id === tab;
            return (
              <button key={t.id} role="tab" aria-selected={on} type="button" onClick={() => setTab(t.id)} className={cn("flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs font-medium transition", on ? "bg-violet-500/20 text-white ring-1 ring-violet-400/40" : "text-slate-400 hover:bg-white/5 hover:text-slate-200")}>
                <t.icon size={14} /> {t.label}
                <span className={cn("rounded-full px-1.5 text-[10px]", on ? "bg-violet-400/30" : "bg-white/10")}>{t.note}</span>
              </button>
            );
          })}
        </div>

        {tab === "logos" && (
          <div className="space-y-4">
            {logos.map((a) => <PageColumn key={a.id} title={a.label} asset={a} actions={actions} />)}
          </div>
        )}

        {tab !== "logos" && style && (
          <section className="overflow-hidden rounded-xl border border-white/[.09]">
            <div className="flex items-center justify-between gap-2 border-b border-white/[.07] bg-black/20 px-4 py-2.5">
              <h4 className="text-sm font-semibold text-slate-100">{tab === "fonts" ? "Fonts" : "Colours"}</h4>
              <Pill asset={style} />
            </div>
            <div className="space-y-4 p-4">
              <p className="text-xs leading-5 text-slate-400">{tab === "fonts" ? "Pick fonts from Google Fonts or Adobe Fonts, or give your own font as @font-face CSS. Add another font with the button." : `Give at least ${MIN_BRAND_COLORS} colour codes, like #0B3D91. Add more if your brand has them.`}</p>
              <ItemNotes asset={style} />
              {style.status === "received" ? (
                <BrandStyleSummary value={style.text} tone="dark" />
              ) : (
                <BrandStyleEditor key={style.updatedAt} value={style.text} busy={actions.busy === style.id} tone="dark" part={tab} onSave={(t) => actions.onText(style.id, t)} />
              )}
              {tab === "fonts" && showFontFiles && (
                <div className="space-y-1.5">
                  <p className="text-xs font-medium text-slate-300">Font files <span className="font-normal text-slate-500">(for an imported font: WOFF2, WOFF, TTF or OTF)</span></p>
                  <DropZone asset={style} busy={actions.busy === style.id} compact onUpload={(f) => actions.onUpload(style.id, f)} onRemove={(fid) => actions.onRemove(style.id, fid)} />
                </div>
              )}
            </div>
          </section>
        )}
        <PagerBar {...pager} />
      </article>

      <aside className="border-t border-white/[.07] bg-black/15 p-4 xl:border-l xl:border-t-0">
        <section className="overflow-hidden rounded-lg border border-white/[.09] bg-[#121620]">
          <h3 className="border-b border-white/[.07] bg-black/20 px-4 py-2.5 text-xs font-semibold text-slate-200">Status</h3>
          <div className="space-y-2.5 px-4 py-3 text-xs">
            <div className="flex items-center justify-between gap-2"><span className="text-slate-500">Brand identity</span><span className={cn("rounded-full border px-2.5 py-0.5 text-[10px] font-medium", PILL[status])}>{ASSET_STATUS_LABELS[status]}</span></div>
            <div className="flex justify-between gap-2"><span className="text-slate-500">Sent</span><span className="text-slate-200">{assets.filter(hasContent).length} of {assets.length}</span></div>
          </div>
          <ul className="space-y-1.5 border-t border-white/[.07] px-4 py-3">
            {assets.map((a) => (
              <li key={a.id} className="flex items-center gap-2 text-[11px]">
                <span className={cn("h-2 w-2 shrink-0 rounded-full", DOT[a.status])} />
                <span className="min-w-0 flex-1 truncate text-slate-300">{a.key === "brand-style" ? "Fonts and colours" : a.label.replace(/ \(browser tab icon\)$/, "")}</span>
                <span className="text-slate-500">{hasContent(a) ? ASSET_STATUS_LABELS[a.status] : "Nothing yet"}</span>
              </li>
            ))}
          </ul>
        </section>
      </aside>
    </div>
  );
}
