"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, FileText, FolderInput, Loader2, Trash2, Upload } from "lucide-react";

import { BrandStyleEditor, BrandStyleSummary } from "@/components/business/brand-style-editor";
import {
  ACCEPT_ATTRIBUTE,
  ASSET_GROUPS,
  ASSET_STATUS_LABELS,
  MAX_FILE_BYTES,
  assetProgress,
  formatBytes,
  type AssetStatus,
  type ClientAsset,
} from "@/lib/business/assets";

type Reply = { success?: boolean; error?: string; available?: boolean; assets?: ClientAsset[] };

const STATUS_STYLE: Record<AssetStatus, string> = {
  pending: "bg-slate-100 text-slate-600",
  submitted: "bg-sky-100 text-sky-800",
  received: "bg-emerald-100 text-emerald-800",
  redo: "bg-amber-100 text-amber-900",
};

/** Client side (light page): what we need from them after approval, with a simple upload for each item. */
export function ClientAssets({ token }: { token: string }) {
  const base = `/api/client/${encodeURIComponent(token)}/assets`;
  const [assets, setAssets] = useState<ClientAsset[] | null>(null);
  const [available, setAvailable] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");

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

  const send = async (assetId: string, init: RequestInit) => {
    setBusy(assetId);
    setError("");
    try {
      const res = await fetch(base, init);
      apply((await res.json().catch(() => ({}))) as Reply);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  const upload = (assetId: string, files: FileList) => {
    const big = Array.from(files).find((f) => f.size > MAX_FILE_BYTES);
    if (big) { setError(`"${big.name}" is larger than ${MAX_FILE_BYTES / 1048576} MB. Please send a smaller file, or put the link in the note.`); return; }
    const form = new FormData();
    form.append("assetId", assetId);
    Array.from(files).forEach((f) => form.append("files", f));
    void send(assetId, { method: "POST", body: form });
  };
  const saveText = (assetId: string, text: string) => send(assetId, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ assetId, text }) });
  const removeFile = async (assetId: string, fileId: string) => {
    setBusy(assetId);
    try {
      const res = await fetch(`${base}?fileId=${encodeURIComponent(fileId)}`, { method: "DELETE" });
      apply((await res.json().catch(() => ({}))) as Reply);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  };

  if (!assets || !available || assets.length === 0) return null;
  const progress = assetProgress(assets);

  return (
    <section className="rounded-2xl bg-white p-5 shadow-sm sm:p-6" id="send-files">
      <h2 className="flex items-center gap-2 font-semibold text-slate-900"><FolderInput size={18} className="text-violet-600" /> Send us your original files and content</h2>
      <p className="mt-1 text-sm text-slate-500">
        To build your website we need your own logo, images and the real content for every page. Add whatever you have below, one item at a time. Anything you do not have yet can be sent later: you can come back to this page any time.
      </p>
      <div className="mt-4 flex items-center gap-3">
        <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-200">
          <div className="h-full rounded-full bg-violet-600 transition-all" style={{ width: `${progress.percent}%` }} />
        </div>
        <span className="text-xs font-medium text-slate-600">{progress.sent} of {progress.total} items sent</span>
      </div>
      {error && <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>}

      <div className="mt-5 space-y-6">
        {ASSET_GROUPS.map((group) => {
          const items = assets.filter((a) => a.group === group);
          if (!items.length) return null;
          return (
            <div key={group}>
              {group !== "Brand" && <h3 className="text-xs font-semibold uppercase tracking-[.15em] text-slate-400">{group}</h3>}
              {group === "Brand" ? (
                // Logo, mobile logo, favicon, colours and fonts: one section
                <div className="divide-y divide-slate-200 overflow-hidden rounded-xl border border-slate-200">
                  <div className="bg-slate-50 px-4 py-3">
                    <p className="text-sm font-semibold text-slate-900">Brand identity</p>
                    <p className="mt-0.5 text-xs text-slate-500">Your logos, favicon, colours and fonts in one place.</p>
                  </div>
                  {items.map((a, i) => (
                    <Item key={a.id + a.updatedAt} embedded step={i + 1} asset={a} busy={busy === a.id} onUpload={(f) => upload(a.id, f)} onText={(t) => saveText(a.id, t)} onRemove={(fid) => removeFile(a.id, fid)} />
                  ))}
                </div>
              ) : (
                <div className="mt-2 space-y-3">
                  {items.map((a) => (
                    <Item key={a.id + a.updatedAt} asset={a} busy={busy === a.id} onUpload={(f) => upload(a.id, f)} onText={(t) => saveText(a.id, t)} onRemove={(fid) => removeFile(a.id, fid)} />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function Item({ asset: a, busy, onUpload, onText, onRemove, embedded = false, step }: { asset: ClientAsset; busy: boolean; embedded?: boolean; step?: number; onUpload: (f: FileList) => void; onText: (t: string) => void; onRemove: (fileId: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(a.text);
  const locked = a.status === "received";
  const takesFiles = a.kind !== "text";
  const takesText = a.kind !== "files";
  const brand = a.key === "brand-style";

  return (
    <div className={embedded ? `p-4 ${locked ? "bg-emerald-50/50" : a.status === "redo" ? "bg-amber-50/60" : ""}` : `rounded-xl border p-4 ${locked ? "border-emerald-200 bg-emerald-50/50" : a.status === "redo" ? "border-amber-300 bg-amber-50/60" : "border-slate-200"}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-sm font-semibold text-slate-900">{step && <span className="flex h-5 w-5 items-center justify-center rounded-full bg-slate-200 text-[11px] text-slate-600">{step}</span>}{a.label}</p>
          <p className="mt-0.5 max-w-xl text-xs leading-5 text-slate-500">{a.hint}</p>
        </div>
        <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium ${STATUS_STYLE[a.status]}`}>
          {locked && <CheckCircle2 size={12} />} {ASSET_STATUS_LABELS[a.status]}
        </span>
      </div>

      {a.status === "redo" && a.note && <p className="mt-3 rounded-lg bg-amber-100 px-3 py-2 text-sm text-amber-900"><b>Please send again:</b> {a.note}</p>}

      {a.files.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {a.files.map((f) => (
            <li key={f.id} className="flex items-center gap-2 rounded-lg bg-slate-50 px-3 py-2 text-sm">
              <FileText size={15} className="shrink-0 text-slate-400" />
              <span className="min-w-0 flex-1 truncate text-slate-700">{f.name}</span>
              <span className="shrink-0 text-xs text-slate-400">{formatBytes(f.size)}</span>
              {!locked && <button type="button" aria-label={`Remove ${f.name}`} disabled={busy} onClick={() => onRemove(f.id)} className="rounded-md p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600"><Trash2 size={14} /></button>}
            </li>
          ))}
        </ul>
      )}

      {!locked && (
        <div className="mt-3 space-y-3">
          {takesFiles && (
            <div>
              <input ref={input} type="file" multiple accept={ACCEPT_ATTRIBUTE} hidden onChange={(e) => { if (e.target.files?.length) onUpload(e.target.files); e.target.value = ""; }} />
              <button type="button" disabled={busy} onClick={() => input.current?.click()} className="flex items-center gap-2 rounded-lg border border-dashed border-violet-400 bg-violet-50 px-4 py-2.5 text-sm font-medium text-violet-700 hover:bg-violet-100 disabled:opacity-60">
                {busy ? <Loader2 size={15} className="animate-spin" /> : <Upload size={15} />} {a.files.length ? "Add more files" : "Choose files to upload"}
              </button>
              <p className="mt-1 text-[11px] text-slate-400">Images, PDF, Word, Excel, design files, font files (WOFF2, WOFF, TTF, OTF) or a ZIP. Up to {MAX_FILE_BYTES / 1048576} MB each.</p>
            </div>
          )}
          {brand && <BrandStyleEditor key={a.updatedAt} value={a.text} busy={busy} tone="light" onSave={onText} />}
          {takesText && !brand && (
            <div>
              <textarea value={text} onChange={(e) => setText(e.target.value)} rows={a.kind === "text" ? 5 : 3} maxLength={20000} placeholder={a.kind === "text" ? "Type or paste here" : "Or type / paste the text here"} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-violet-500" />
              <button type="button" disabled={busy || text === a.text || !text.trim()} onClick={() => onText(text)} className="mt-1.5 flex items-center gap-2 rounded-lg bg-violet-600 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-500 disabled:opacity-50">
                {busy && <Loader2 size={14} className="animate-spin" />} Save text
              </button>
            </div>
          )}
        </div>
      )}
      {locked && a.text.trim() && (brand ? <BrandStyleSummary value={a.text} tone="light" /> : <p className="mt-3 line-clamp-3 whitespace-pre-wrap text-xs text-slate-500">{a.text}</p>)}
    </div>
  );
}
