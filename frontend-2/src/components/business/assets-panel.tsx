"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  Building2,
  Check,
  ChevronLeft,
  Download,
  FileText,
  FolderInput,
  Images,
  Info,
  Loader2,
  Palette,
  Paperclip,
  RotateCcw,
  Trash2,
  Upload,
  type LucideIcon,
} from "lucide-react";

import { BrandStyleEditor } from "@/components/business/brand-style-editor";
import { Card, jsonFetch } from "@/components/business/ui";
import {
  ACCEPT_ATTRIBUTE,
  ASSET_GROUPS,
  ASSET_STATUS_LABELS,
  assetProgress,
  extensionOf,
  formatBytes,
  isInlineImage,
  type AssetGroup,
  type AssetStatus,
  type ClientAsset,
} from "@/lib/business/assets";
import { cn, formatRelativeTime } from "@/lib/utils";

type Reply = { available: boolean; assets: ClientAsset[] };

const GROUP_ICON: Record<AssetGroup, LucideIcon> = { Brand: Palette, "Business details": Building2, "Page content": FileText, Images: Images, Other: Paperclip };
const PILL: Record<AssetStatus, string> = {
  pending: "border-white/10 bg-white/[.05] text-slate-400",
  submitted: "border-sky-400/30 bg-sky-400/10 text-sky-300",
  received: "border-emerald-400/30 bg-emerald-400/10 text-emerald-300",
  redo: "border-amber-400/30 bg-amber-400/10 text-amber-300",
};
const DOT: Record<AssetStatus, string> = { pending: "bg-slate-600", submitted: "bg-sky-400", received: "bg-emerald-400", redo: "bg-amber-400" };

const hasContent = (a: ClientAsset) => a.files.length > 0 || a.text.trim().length > 0;

/**
 * A menu entry. Most entries are one checklist item. The brand items (logo, mobile logo, favicon, colours and fonts)
 * are one entry, "Brand identity", so they are handled in a single place.
 */
type Entry = { key: string; group: AssetGroup; label: string; assets: ClientAsset[] };

function entriesOf(list: ClientAsset[]): Entry[] {
  const out: Entry[] = [];
  const brand = list.filter((a) => a.group === "Brand");
  for (const a of list) {
    if (a.group === "Brand") {
      if (!out.some((e) => e.key === "brand")) out.push({ key: "brand", group: "Brand", label: "Brand identity", assets: brand });
    } else {
      out.push({ key: a.key, group: a.group, label: a.label.replace(/ page: original content$/, ""), assets: [a] });
    }
  }
  return out;
}

/** One status for several items: needs attention first, then waiting for a check, then done. */
function entryStatus(assets: ClientAsset[]): AssetStatus {
  if (assets.some((a) => a.status === "redo")) return "redo";
  const filled = assets.filter(hasContent);
  if (filled.length === 0) return "pending";
  if (filled.some((a) => a.status === "submitted" || a.status === "pending")) return "submitted";
  return "received";
}

/**
 * Team side of the client's originals, laid out like a CMS dashboard: a content menu on the left, the item's editor and
 * media library in the middle, and a "Status" box (like WordPress' Publish box) on the right.
 */
export function AssetsPanel({ leadId }: { leadId: string }) {
  const base = `/api/business/leads/${leadId}/assets`;
  const [data, setData] = useState<Reply | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [selected, setSelected] = useState("");

  const load = useCallback(() => {
    jsonFetch<Reply>(base).then((r) => { setData(r); setError(""); }).catch((e: Error) => setError(e.message));
  }, [base]);
  useEffect(load, [load]);

  const run = async (label: string, fn: () => Promise<Reply>) => {
    setBusy(label);
    setError("");
    // Every reply keeps the section open: the checklist is only hidden before the client approves.
    try { setData({ assets: (await fn()).assets, available: true }); } catch (e) { setError((e as Error).message); } finally { setBusy(""); }
  };
  const send = (assetId: string, body: object) => jsonFetch<Reply>(base, { method: "PATCH", body: JSON.stringify({ assetId, ...body }) });
  const patch = (assetId: string, body: object) => run(assetId, () => send(assetId, body));
  /** Marks several items at once, one after the other; the last reply carries the final state. */
  const patchMany = (label: string, ids: string[], body: object) => run(label, async () => {
    let last: Reply | null = null;
    for (const id of ids) last = await send(id, body);
    return last ?? { available: true, assets: [] };
  });
  const upload = (assetId: string, files: FileList) =>
    run(assetId, async () => {
      const form = new FormData();
      form.append("assetId", assetId);
      Array.from(files).forEach((f) => form.append("files", f));
      const res = await fetch(base, { method: "POST", body: form });
      const r = (await res.json().catch(() => ({}))) as Reply & { success?: boolean; error?: string };
      if (!res.ok || r.success === false) throw new Error(r.error || "Upload failed.");
      return r;
    });
  const removeFile = (assetId: string, fileId: string) => run(assetId, () => jsonFetch<Reply>(`${base}?fileId=${fileId}`, { method: "DELETE" }));

  if (!data) {
    return <Card className="no-print flex items-center gap-2 text-sm text-slate-400">{error ? <span className="text-rose-300">{error}</span> : <><Loader2 size={15} className="animate-spin" /> Loading client files...</>}</Card>;
  }
  if (!data.available || data.assets.length === 0) return null;

  const list = data.assets;
  const entries = entriesOf(list);
  const index = Math.max(0, entries.findIndex((e) => e.key === selected));
  const current = entries[index];
  const progress = assetProgress(list);
  const glance = [
    { label: "Uploaded", value: progress.sent, tone: "text-sky-300" },
    { label: "To check", value: progress.toCheck, tone: "text-amber-300" },
    { label: "Received", value: progress.received, tone: "text-emerald-300" },
    { label: "Waiting", value: list.filter((a) => a.status === "pending" || a.status === "redo").length, tone: "text-slate-300" },
  ];

  return (
    <Card className="no-print overflow-hidden p-0">
      {/* Top bar */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-white/[.07] bg-black/20 px-5 py-4">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-violet-500/15 text-violet-300"><FolderInput size={18} /></span>
          <div>
            <h3 className="text-sm font-semibold text-slate-100">Client files and content</h3>
            <p className="mt-0.5 text-xs text-slate-400">{progress.sent} of {progress.total} items uploaded. Nothing is mandatory: missing items get a placeholder.</p>
          </div>
        </div>
        <dl className="flex gap-2">
          {glance.map((g) => (
            <div key={g.label} className="min-w-[72px] rounded-lg border border-white/[.07] bg-white/[.03] px-3 py-1.5 text-center">
              <dd className={cn("text-base font-semibold tabular-nums", g.tone)}>{g.value}</dd>
              <dt className="text-[10px] uppercase tracking-wider text-slate-500">{g.label}</dt>
            </div>
          ))}
        </dl>
      </div>
      <div className="h-1 bg-white/[.06]"><div className="h-full bg-gradient-to-r from-violet-500 to-emerald-400 transition-all" style={{ width: `${progress.percent}%` }} /></div>

      {error && <p className="m-4 rounded-lg border border-rose-400/20 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">{error}</p>}

      <div className="grid lg:grid-cols-[250px_1fr]">
        {/* Content menu, like a CMS sidebar */}
        <nav aria-label="Content" className="border-b border-white/[.07] bg-black/25 lg:border-b-0 lg:border-r">
          <label className="block p-3 lg:hidden">
            <span className="sr-only">Choose an item</span>
            <select value={current.key} onChange={(e) => setSelected(e.target.value)} className="w-full rounded-lg border border-white/[.1] bg-[#121620] px-3 py-2 text-sm text-slate-100 outline-none">
              {entries.map((e) => <option key={e.key} value={e.key}>{e.group}: {e.label} ({ASSET_STATUS_LABELS[entryStatus(e.assets)]})</option>)}
            </select>
          </label>
          <div className="hidden max-h-[640px] overflow-y-auto py-2 lg:block">
            {ASSET_GROUPS.map((group) => {
              const items = entries.filter((e) => e.group === group);
              if (!items.length) return null;
              const Icon = GROUP_ICON[group];
              return (
                <div key={group} className="mb-1">
                  <p className="flex items-center gap-2 px-4 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-[.14em] text-slate-500"><Icon size={12} /> {group}</p>
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

        {/* Editor + side boxes */}
        {current.key === "brand" ? (
          <BrandIdentity
            key={`brand-${current.assets.map((a) => a.updatedAt).join("|")}`}
            assets={current.assets}
            leadId={leadId}
            busy={busy}
            hasPrev={index > 0}
            hasNext={index < entries.length - 1}
            onPrev={() => setSelected(entries[index - 1].key)}
            onNext={() => setSelected(entries[index + 1].key)}
            onPatch={patch}
            onPatchMany={(ids, body) => patchMany("brand", ids, body)}
            onUpload={upload}
            onRemove={removeFile}
          />
        ) : (
          <Editor
            key={`${current.assets[0].id}-${current.assets[0].updatedAt}`}
            asset={current.assets[0]}
            leadId={leadId}
            busy={busy === current.assets[0].id}
            hasPrev={index > 0}
            hasNext={index < entries.length - 1}
            onPrev={() => setSelected(entries[index - 1].key)}
            onNext={() => setSelected(entries[index + 1].key)}
            onPatch={(b) => patch(current.assets[0].id, b)}
            onUpload={(f) => upload(current.assets[0].id, f)}
            onRemove={(fid) => removeFile(current.assets[0].id, fid)}
          />
        )}
      </div>
    </Card>
  );
}

// ---- pieces shared by the editors ----------------------------------------------------------------------------------------------------

/** Thumbnails of what was uploaded, a drop zone and an "Add media" button. */
function MediaLibrary({ asset: a, leadId, busy, onUpload, onRemove, compact = false }: { asset: ClientAsset; leadId: string; busy: boolean; onUpload: (f: FileList) => void; onRemove: (fileId: string) => void; compact?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h5 className="text-sm font-semibold text-slate-200">Media <span className="ml-1 text-xs font-normal text-slate-500">{a.files.length} file{a.files.length === 1 ? "" : "s"}</span></h5>
        <button type="button" disabled={busy} onClick={() => input.current?.click()} className="flex items-center gap-1.5 rounded-lg border border-violet-400/50 px-3 py-1.5 text-xs font-medium text-violet-200 hover:bg-violet-500/10 disabled:opacity-50">
          {busy ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />} Add media
        </button>
      </div>
      <input ref={input} type="file" multiple accept={ACCEPT_ATTRIBUTE} hidden onChange={(e) => { if (e.target.files?.length) onUpload(e.target.files); e.target.value = ""; }} />

      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); if (e.dataTransfer.files.length) onUpload(e.dataTransfer.files); }}
        className={cn("rounded-xl border-2 border-dashed p-3 transition", dragging ? "border-violet-400 bg-violet-500/10" : "border-white/[.1] bg-white/[.015]")}
      >
        {a.files.length === 0 ? (
          <button type="button" onClick={() => input.current?.click()} className={cn("flex w-full flex-col items-center gap-2 text-center text-xs text-slate-500 hover:text-slate-300", compact ? "py-5" : "py-8")}>
            <Upload size={compact ? 18 : 22} className="text-slate-600" />
            <span><b className="text-slate-300">Drop files here</b> or click to upload on the client&apos;s behalf</span>
            {!compact && <span className="text-[11px]">Images, PDF, Word, Excel, design files, fonts or ZIP · up to 15 MB each</span>}
          </button>
        ) : (
          <ul className={cn("grid gap-3", compact ? "grid-cols-2 sm:grid-cols-3 2xl:grid-cols-4" : "grid-cols-2 sm:grid-cols-3 2xl:grid-cols-4")}>
            {a.files.map((f) => (
              <li key={f.id} className="group relative overflow-hidden rounded-lg border border-white/[.08] bg-black/25">
                <div className="flex aspect-[4/3] items-center justify-center bg-white/[.03]">
                  {isInlineImage(f.name) ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={`/api/business/leads/${leadId}/assets/files/${f.id}?inline=1`} alt={f.name} className="h-full w-full object-cover" />
                  ) : (
                    <span className="flex flex-col items-center gap-1 text-slate-500"><FileText size={26} /><span className="text-[10px] font-semibold uppercase tracking-wider">{extensionOf(f.name) || "file"}</span></span>
                  )}
                </div>
                <div className="px-2.5 py-2">
                  <p className="truncate text-xs font-medium text-slate-200" title={f.name}>{f.name}</p>
                  <p className="text-[10px] text-slate-500">{formatBytes(f.size)} · {f.by === "client" ? "client" : "you"}</p>
                </div>
                <div className="absolute right-1.5 top-1.5 flex gap-1 opacity-100 transition sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
                  <a href={`/api/business/leads/${leadId}/assets/files/${f.id}`} aria-label={`Download ${f.name}`} className="rounded-md bg-black/70 p-1.5 text-slate-200 hover:bg-black"><Download size={13} /></a>
                  <button type="button" aria-label={`Remove ${f.name}`} disabled={busy} onClick={() => onRemove(f.id)} className="rounded-md bg-black/70 p-1.5 text-rose-300 hover:bg-rose-600 hover:text-white"><Trash2 size={13} /></button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

/** Mark received / reopen / ask again, with the note box. Used in the Status box and, for brand parts, in each part's header. */
function ReviewActions({ asset: a, busy, onPatch, compact = false }: { asset: ClientAsset; busy: boolean; onPatch: (b: object) => void; compact?: boolean }) {
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState(a.note);
  const filled = hasContent(a);
  const size = compact ? "px-2.5 py-1.5 text-[11px]" : "px-3 py-2 text-xs";
  return (
    <div className={cn("space-y-2", compact && "flex flex-wrap items-center gap-2 space-y-0")}>
      {a.status !== "received" ? (
        <button type="button" disabled={busy || !filled} onClick={() => onPatch({ status: "received", note: "" })} className={cn("flex items-center justify-center gap-1.5 rounded-lg bg-emerald-500 font-semibold text-white hover:bg-emerald-400 disabled:opacity-40", size, !compact && "w-full")}>
          <Check size={14} /> Mark as received
        </button>
      ) : (
        <button type="button" disabled={busy} onClick={() => onPatch({ status: "submitted" })} className={cn("flex items-center justify-center gap-1.5 rounded-lg border border-white/10 text-slate-300 hover:bg-white/5 disabled:opacity-50", size, !compact && "w-full")}>
          <RotateCcw size={13} /> Reopen for checking
        </button>
      )}
      {filled && a.status !== "redo" && (
        <button type="button" disabled={busy} onClick={() => setAsking(!asking)} className={cn("rounded-lg text-center text-amber-300 hover:bg-amber-500/10 disabled:opacity-50", compact ? "px-2.5 py-1.5 text-[11px]" : "w-full px-3 py-1.5 text-[11px]")}>Ask the client to send again</button>
      )}
      {asking && (
        <div className={cn("space-y-2", compact && "w-full")}>
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={500} placeholder="What should they send again? e.g. a higher resolution logo" className="w-full rounded-lg border border-white/[.08] bg-white/[.03] px-3 py-2 text-xs text-slate-100 outline-none focus:border-violet-400/60" />
          <button type="button" disabled={busy || note.trim().length < 3} onClick={() => { onPatch({ status: "redo", note }); setAsking(false); }} className="w-full rounded-lg bg-amber-500 px-3 py-2 text-xs font-semibold text-slate-900 hover:bg-amber-400 disabled:opacity-40">Send request</button>
        </div>
      )}
    </div>
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

function Pager({ hasPrev, hasNext, onPrev, onNext }: { hasPrev: boolean; hasNext: boolean; onPrev: () => void; onNext: () => void }) {
  return (
    <footer className="flex items-center justify-between border-t border-white/[.07] pt-4">
      <button type="button" disabled={!hasPrev} onClick={onPrev} className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs text-slate-400 hover:bg-white/5 hover:text-white disabled:opacity-30"><ChevronLeft size={14} /> Previous item</button>
      <button type="button" disabled={!hasNext} onClick={onNext} className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs text-slate-300 hover:bg-white/5 hover:text-white disabled:opacity-30">Next item <ArrowRight size={14} /></button>
    </footer>
  );
}

// ---- one ordinary item ---------------------------------------------------------------------------------------------------------------

function Editor({ asset: a, leadId, busy, hasPrev, hasNext, onPrev, onNext, onPatch, onUpload, onRemove }: {
  asset: ClientAsset; leadId: string; busy: boolean; hasPrev: boolean; hasNext: boolean; onPrev: () => void; onNext: () => void;
  onPatch: (b: object) => void; onUpload: (f: FileList) => void; onRemove: (fileId: string) => void;
}) {
  const [text, setText] = useState(a.text);
  const takesFiles = a.kind !== "text";
  const takesText = a.kind !== "files";
  const filled = hasContent(a);
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;

  return (
    <div className="grid min-w-0 xl:grid-cols-[1fr_270px]">
      <article className="min-w-0 space-y-5 p-5 sm:p-6">
        <header>
          <p className="text-[11px] uppercase tracking-[.16em] text-slate-500">{a.group}</p>
          <h4 className="mt-1 text-xl font-semibold tracking-tight text-slate-50">{a.label}</h4>
        </header>
        <Notice>{a.hint}</Notice>

        {takesText && (
          <section>
            <div className="overflow-hidden rounded-lg border border-white/[.09] bg-white/[.02] focus-within:border-violet-400/60">
              <div className="flex items-center justify-between border-b border-white/[.07] bg-black/20 px-3 py-1.5 text-[11px] text-slate-500">
                <span>Content</span>
                <span>{words} word{words === 1 ? "" : "s"}</span>
              </div>
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={a.kind === "text" ? 10 : 7}
                maxLength={20000}
                aria-label={`${a.label} content`}
                placeholder="Type or paste the content here. The client can also type it on their page."
                className="w-full resize-y bg-transparent px-4 py-3 text-sm leading-6 text-slate-100 outline-none placeholder:text-slate-600"
              />
            </div>
            <button type="button" disabled={busy || text === a.text} onClick={() => onPatch({ text })} className="mt-2 flex items-center gap-2 rounded-lg bg-violet-500 px-4 py-2 text-xs font-semibold text-white hover:bg-violet-400 disabled:opacity-40">
              {busy && <Loader2 size={13} className="animate-spin" />} Save content
            </button>
          </section>
        )}

        {takesFiles && <MediaLibrary asset={a} leadId={leadId} busy={busy} onUpload={onUpload} onRemove={onRemove} />}
        <Pager hasPrev={hasPrev} hasNext={hasNext} onPrev={onPrev} onNext={onNext} />
      </article>

      {/* Status box, like the CMS "Publish" box */}
      <aside className="border-t border-white/[.07] bg-black/15 p-4 xl:border-l xl:border-t-0">
        <section className="overflow-hidden rounded-lg border border-white/[.09] bg-[#121620]">
          <h5 className="border-b border-white/[.07] bg-black/20 px-4 py-2.5 text-xs font-semibold text-slate-200">Status</h5>
          <dl className="space-y-2.5 px-4 py-3 text-xs">
            <div className="flex items-center justify-between gap-2"><dt className="text-slate-500">Status</dt><dd><span className={cn("rounded-full border px-2.5 py-0.5 text-[10px] font-medium", PILL[a.status])}>{ASSET_STATUS_LABELS[a.status]}</span></dd></div>
            <div className="flex justify-between gap-2"><dt className="text-slate-500">Files</dt><dd className="text-slate-200">{a.files.length}</dd></div>
            {takesText && <div className="flex justify-between gap-2"><dt className="text-slate-500">Text</dt><dd className="text-slate-200">{a.text.trim() ? `${a.text.trim().length} characters` : "None"}</dd></div>}
            <div className="flex justify-between gap-2"><dt className="text-slate-500">Updated</dt><dd className="text-slate-200">{filled || a.status !== "pending" ? formatRelativeTime(a.updatedAt) : "Never"}</dd></div>
          </dl>
          {a.status === "redo" && a.note && <p className="mx-4 mb-3 rounded-lg bg-amber-500/10 px-3 py-2 text-[11px] leading-4 text-amber-200">You asked: {a.note}</p>}
          <div className="border-t border-white/[.07] bg-black/15 px-4 py-3">
            <ReviewActions asset={a} busy={busy} onPatch={onPatch} />
            {!filled && a.status !== "received" && <p className="mt-2 text-[11px] text-slate-500">Nothing to check yet. Upload a file or add text first.</p>}
          </div>
        </section>
      </aside>
    </div>
  );
}

// ---- Brand identity: logo, mobile logo, favicon, colours and fonts in one place ------------------------------------------------------

function BrandIdentity({ assets, leadId, busy, hasPrev, hasNext, onPrev, onNext, onPatch, onPatchMany, onUpload, onRemove }: {
  assets: ClientAsset[]; leadId: string; busy: string; hasPrev: boolean; hasNext: boolean; onPrev: () => void; onNext: () => void;
  onPatch: (assetId: string, body: object) => void; onPatchMany: (ids: string[], body: object) => void;
  onUpload: (assetId: string, files: FileList) => void; onRemove: (assetId: string, fileId: string) => void;
}) {
  const status = entryStatus(assets);
  const received = assets.filter((a) => a.status === "received" && hasContent(a)).length;
  const withContent = assets.filter(hasContent);
  const toMark = withContent.filter((a) => a.status !== "received");
  const brandBusy = busy === "brand";

  return (
    <div className="grid min-w-0 xl:grid-cols-[1fr_270px]">
      <article className="min-w-0 space-y-5 p-5 sm:p-6">
        <header>
          <p className="text-[11px] uppercase tracking-[.16em] text-slate-500">Brand</p>
          <h4 className="mt-1 text-xl font-semibold tracking-tight text-slate-50">Brand identity</h4>
        </header>
        <Notice>Your client&apos;s logo, mobile logo, favicon, colours and fonts, all in one place. Each part has its own status, so you can confirm one and ask for another again.</Notice>

        {assets.map((a, i) => (
          <section key={a.id} className={cn("overflow-hidden rounded-xl border", a.status === "received" ? "border-emerald-400/20" : a.status === "redo" ? "border-amber-400/30" : "border-white/[.09]")}>
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/[.07] bg-black/20 px-4 py-2.5">
              <div className="flex min-w-0 items-center gap-2.5">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-white/10 text-[11px] font-semibold text-slate-300">{i + 1}</span>
                <h5 className="truncate text-sm font-semibold text-slate-100">{a.label}</h5>
                <span className={cn("shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium", PILL[a.status])}>{ASSET_STATUS_LABELS[a.status]}</span>
              </div>
              <ReviewActions asset={a} busy={busy === a.id || brandBusy} onPatch={(b) => onPatch(a.id, b)} compact />
            </div>
            <div className="space-y-4 p-4">
              <p className="text-xs leading-5 text-slate-400">{a.hint}</p>
              {a.status === "redo" && a.note && <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-[11px] leading-4 text-amber-200">You asked: {a.note}</p>}
              {a.key === "brand-style" && <BrandStyleEditor key={a.updatedAt} value={a.text} busy={busy === a.id} tone="dark" onSave={(t) => onPatch(a.id, { text: t })} />}
              <MediaLibrary asset={a} leadId={leadId} busy={busy === a.id} compact onUpload={(f) => onUpload(a.id, f)} onRemove={(fid) => onRemove(a.id, fid)} />
            </div>
          </section>
        ))}

        <Pager hasPrev={hasPrev} hasNext={hasNext} onPrev={onPrev} onNext={onNext} />
      </article>

      {/* Overall status for the whole brand section */}
      <aside className="border-t border-white/[.07] bg-black/15 p-4 xl:border-l xl:border-t-0">
        <section className="overflow-hidden rounded-lg border border-white/[.09] bg-[#121620]">
          <h5 className="border-b border-white/[.07] bg-black/20 px-4 py-2.5 text-xs font-semibold text-slate-200">Status</h5>
          <div className="space-y-2.5 px-4 py-3 text-xs">
            <div className="flex items-center justify-between gap-2"><span className="text-slate-500">Brand identity</span><span className={cn("rounded-full border px-2.5 py-0.5 text-[10px] font-medium", PILL[status])}>{ASSET_STATUS_LABELS[status]}</span></div>
            <div className="flex justify-between gap-2"><span className="text-slate-500">Received</span><span className="text-slate-200">{received} of {assets.length}</span></div>
          </div>
          <ul className="space-y-1.5 border-t border-white/[.07] px-4 py-3">
            {assets.map((a) => (
              <li key={a.id} className="flex items-center gap-2 text-[11px]">
                <span className={cn("h-2 w-2 shrink-0 rounded-full", DOT[a.status])} />
                <span className="min-w-0 flex-1 truncate text-slate-300">{a.label.replace(/ \(browser tab icon\)$/, "")}</span>
                <span className="text-slate-500">{a.files.length + (a.text.trim() ? 1 : 0) > 0 ? ASSET_STATUS_LABELS[a.status] : "Nothing yet"}</span>
              </li>
            ))}
          </ul>
          <div className="border-t border-white/[.07] bg-black/15 px-4 py-3">
            <button type="button" disabled={brandBusy || toMark.length === 0} onClick={() => onPatchMany(toMark.map((a) => a.id), { status: "received", note: "" })} className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-emerald-500 px-3 py-2 text-xs font-semibold text-white hover:bg-emerald-400 disabled:opacity-40">
              {brandBusy ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Mark everything received
            </button>
            <p className="mt-2 text-[11px] text-slate-500">{withContent.length === 0 ? "Nothing to check yet. Upload a file or add colours first." : toMark.length === 0 ? "Everything that was sent is received." : `Marks the ${toMark.length} part${toMark.length === 1 ? "" : "s"} that have something uploaded.`}</p>
          </div>
        </section>
      </aside>
    </div>
  );
}
