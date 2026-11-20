"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Download, FileText, FolderInput, Loader2, RotateCcw, Trash2, Upload } from "lucide-react";

import { BrandStyleEditor } from "@/components/business/brand-style-editor";
import { Card, jsonFetch } from "@/components/business/ui";
import {
  ACCEPT_ATTRIBUTE,
  ASSET_GROUPS,
  ASSET_STATUS_LABELS,
  assetProgress,
  formatBytes,
  isInlineImage,
  type AssetStatus,
  type ClientAsset,
} from "@/lib/business/assets";
import { cn } from "@/lib/utils";

type Reply = { available: boolean; assets: ClientAsset[] };

const STATUS_STYLE: Record<AssetStatus, string> = {
  pending: "border-white/10 bg-white/[.05] text-slate-400",
  submitted: "border-sky-400/30 bg-sky-400/10 text-sky-300",
  received: "border-emerald-400/30 bg-emerald-400/10 text-emerald-300",
  redo: "border-amber-400/30 bg-amber-400/10 text-amber-300",
};

/** Team side: what the client still has to send, what arrived, and a place to confirm or ask again. */
export function AssetsPanel({ leadId }: { leadId: string }) {
  const base = `/api/business/leads/${leadId}/assets`;
  const [data, setData] = useState<Reply | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");

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
  const patch = (assetId: string, body: object) => run(assetId, () => jsonFetch<Reply>(base, { method: "PATCH", body: JSON.stringify({ assetId, ...body }) }));
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
  if (!data.available) return null;

  const progress = assetProgress(data.assets);

  return (
    <Card className="no-print space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="flex items-center gap-2 text-sm font-semibold text-slate-100"><FolderInput size={16} className="text-violet-300" /> Collect client originals</p>
          <p className="mt-1 max-w-xl text-xs leading-5 text-slate-400">
            The client sees this list on their quotation link and uploads here. You can also add files they sent by WhatsApp or email. Nothing is mandatory: the project is built from whatever is uploaded, with placeholders for the rest. Mark an item <b className="text-slate-200">Received</b> once you have checked it.
          </p>
        </div>
        <div className="text-right text-xs">
          <p className="font-semibold text-slate-100">{progress.sent} of {progress.total} items uploaded</p>
          {progress.toCheck > 0 && <p className="mt-0.5 text-sky-300">{progress.toCheck} to check</p>}
        </div>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-white/10">
        <div className="h-full rounded-full bg-gradient-to-r from-violet-500 to-emerald-400 transition-all" style={{ width: `${progress.percent}%` }} />
      </div>

      {error && <p className="rounded-lg border border-rose-400/20 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">{error}</p>}

      {ASSET_GROUPS.map((group) => {
        const items = data.assets.filter((a) => a.group === group);
        if (!items.length) return null;
        return (
          <section key={group} className="space-y-2">
            <h4 className="text-[11px] font-semibold uppercase tracking-[.15em] text-slate-500">{group}</h4>
            {items.map((a) => (
              <AssetRow key={a.id + a.updatedAt} asset={a} leadId={leadId} busy={busy === a.id} onPatch={(b) => patch(a.id, b)} onUpload={(f) => upload(a.id, f)} onRemove={(fid) => removeFile(a.id, fid)} />
            ))}
          </section>
        );
      })}
    </Card>
  );
}

function AssetRow({ asset: a, leadId, busy, onPatch, onUpload, onRemove }: { asset: ClientAsset; leadId: string; busy: boolean; onPatch: (b: object) => void; onUpload: (f: FileList) => void; onRemove: (fileId: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState(a.note);
  const [showText, setShowText] = useState(false);
  const takesFiles = a.kind !== "text";
  const brand = a.key === "brand-style";

  return (
    <div className={cn("rounded-xl border p-3.5", a.status === "received" ? "border-emerald-400/20 bg-emerald-500/[.04]" : "border-white/[.07] bg-white/[.025]")}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[13px] font-medium text-slate-100">{a.label}</p>
          <p className="mt-0.5 max-w-xl text-[11px] leading-4 text-slate-500">{a.hint}</p>
        </div>
        <span className={cn("shrink-0 rounded-full border px-2.5 py-1 text-[10px] font-medium", STATUS_STYLE[a.status])}>{ASSET_STATUS_LABELS[a.status]}</span>
      </div>

      {a.files.length > 0 && (
        <ul className="mt-3 grid gap-2 sm:grid-cols-2">
          {a.files.map((f) => (
            <li key={f.id} className="flex items-center gap-2.5 rounded-lg border border-white/[.06] bg-black/20 p-2">
              {isInlineImage(f.name) ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={`/api/business/leads/${leadId}/assets/files/${f.id}?inline=1`} alt="" className="h-10 w-10 shrink-0 rounded-md object-cover" />
              ) : (
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-white/[.06] text-slate-400"><FileText size={16} /></span>
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs text-slate-200">{f.name}</span>
                <span className="text-[10px] text-slate-500">{formatBytes(f.size)} · from {f.by === "client" ? "client" : "you"}</span>
              </span>
              <a href={`/api/business/leads/${leadId}/assets/files/${f.id}`} aria-label={`Download ${f.name}`} className="rounded-md p-1.5 text-slate-400 hover:bg-white/5 hover:text-white"><Download size={14} /></a>
              <button type="button" aria-label={`Remove ${f.name}`} disabled={busy} onClick={() => onRemove(f.id)} className="rounded-md p-1.5 text-slate-500 hover:bg-rose-500/10 hover:text-rose-300"><Trash2 size={14} /></button>
            </li>
          ))}
        </ul>
      )}

      {brand && <div className="mt-3"><BrandStyleEditor key={a.updatedAt} value={a.text} busy={busy} tone="dark" onSave={(text) => onPatch({ text })} /></div>}

      {!brand && a.text.trim() && (
        <div className="mt-3">
          <button type="button" onClick={() => setShowText(!showText)} className="text-[11px] font-medium text-violet-300 hover:text-white">{showText ? "Hide" : "Read"} the text the client typed ({a.text.trim().length} characters)</button>
          {showText && <p className="mt-1.5 max-h-56 overflow-y-auto whitespace-pre-wrap rounded-lg border border-white/[.06] bg-black/20 p-3 text-xs leading-5 text-slate-300">{a.text}</p>}
        </div>
      )}

      {a.status === "redo" && a.note && <p className="mt-3 rounded-lg bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200">You asked: {a.note}</p>}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {takesFiles && (
          <>
            <input ref={input} type="file" multiple accept={ACCEPT_ATTRIBUTE} hidden onChange={(e) => { if (e.target.files?.length) onUpload(e.target.files); e.target.value = ""; }} />
            <button type="button" disabled={busy} onClick={() => input.current?.click()} className="flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-1.5 text-[11px] text-slate-200 hover:bg-white/5 disabled:opacity-50">
              {busy ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />} Add files
            </button>
          </>
        )}
        {a.status !== "received" && (a.files.length > 0 || a.text.trim()) && (
          <button type="button" disabled={busy} onClick={() => onPatch({ status: "received", note: "" })} className="flex items-center gap-1.5 rounded-lg bg-emerald-500/90 px-3 py-1.5 text-[11px] font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"><Check size={13} /> Mark received</button>
        )}
        {a.status === "received" && (
          <button type="button" disabled={busy} onClick={() => onPatch({ status: "submitted" })} className="flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-1.5 text-[11px] text-slate-300 hover:bg-white/5 disabled:opacity-50"><RotateCcw size={13} /> Reopen</button>
        )}
        {(a.files.length > 0 || a.text.trim()) && a.status !== "redo" && (
          <button type="button" disabled={busy} onClick={() => setAsking(!asking)} className="rounded-lg px-3 py-1.5 text-[11px] text-amber-300 hover:bg-amber-500/10 disabled:opacity-50">Ask again</button>
        )}
      </div>

      {asking && (
        <div className="mt-2 flex flex-wrap gap-2">
          <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="What should the client send again? e.g. a higher resolution logo" className="min-w-0 flex-1 rounded-lg border border-white/[.08] bg-white/[.03] px-3 py-2 text-xs text-slate-100 outline-none focus:border-violet-400/60" />
          <button type="button" disabled={busy || note.trim().length < 3} onClick={() => { onPatch({ status: "redo", note }); setAsking(false); }} className="rounded-lg bg-amber-500 px-3 py-2 text-xs font-semibold text-slate-900 hover:bg-amber-400 disabled:opacity-50">Send request</button>
        </div>
      )}
    </div>
  );
}
