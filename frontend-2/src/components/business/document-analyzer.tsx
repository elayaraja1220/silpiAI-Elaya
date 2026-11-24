"use client";

import { useRef, useState } from "react";
import { FileText, Loader2, Sparkles, UploadCloud, X } from "lucide-react";

import type { RequirementDraft } from "@/lib/business/types";
import { cn, formatBytes } from "@/lib/utils";

const ACCEPT = ".docx,.pdf,.png,.jpg,.jpeg,.webp,.gif,.txt,.md,.csv";
const MAX_FILES = 5;
const MAX_FILE_BYTES = 10 * 1024 * 1024;

export type AnalysisOutcome = {
  draft: RequirementDraft;
  files: string[];
  model: string;
  costUsd: number;
  /** The same documents were analysed before: the saved result is used, so the estimate is the same. */
  cached?: boolean;
  /** How many readings the draft is the agreement of. */
  runs?: number;
  /** Fewer readings than a majority succeeded; the result was not kept. */
  partial?: boolean;
};

/**
 * "Start from a document": upload the client's requirement files, the AI
 * reads them once and fills the form. The team then checks every field.
 */
export function DocumentAnalyzer({ onDraft, children }: { onDraft: (outcome: AnalysisOutcome) => void; children?: React.ReactNode }) {
  const [files, setFiles] = useState<File[]>([]);
  const [notes, setNotes] = useState("");
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const add = (list: FileList | null) => {
    if (!list) return;
    const incoming = Array.from(list);
    const word = incoming.find((f) => /\.doc$/i.test(f.name));
    const big = incoming.find((f) => f.size > MAX_FILE_BYTES);
    setError(word ? `${word.name}: old .doc format. In Word, use File > Save As > Word Document (.docx) or PDF.` : big ? `${big.name} is larger than 10 MB.` : "");
    const ok = incoming.filter((f) => !/\.doc$/i.test(f.name) && f.size <= MAX_FILE_BYTES);
    setFiles((old) => [...old, ...ok.filter((f) => !old.some((o) => o.name === f.name && o.size === f.size))].slice(0, MAX_FILES));
  };

  const analyze = async () => {
    setBusy(true);
    setError("");
    try {
      const body = new FormData();
      files.forEach((f) => body.append("files", f));
      body.append("notes", notes);
      const response = await fetch("/api/business/analyze", { method: "POST", body });
      const result = (await response.json().catch(() => ({}))) as { success?: boolean; error?: string; draft?: RequirementDraft; model?: string; costUsd?: number; cached?: boolean; runs?: number; partial?: boolean };
      if (!result.success || !result.draft) throw new Error(result.error || `Analysis failed (${response.status}).`);
      onDraft({ draft: result.draft, files: files.map((f) => f.name), model: result.model ?? "", costUsd: result.costUsd ?? 0, cached: result.cached, runs: result.runs, partial: result.partial });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-xl border border-violet-400/20 bg-gradient-to-br from-violet-500/10 to-transparent p-4">
      <div className="flex items-center gap-2 text-violet-200">
        <Sparkles size={16} />
        <p className="text-sm font-semibold">Start from the client&apos;s document</p>
      </div>
      <p className="mt-1 text-xs text-slate-400">Upload the requirement (Word, PDF, screenshots, text). AI reads it and fills this form; you check it before pricing.</p>

      <div
        role="button"
        tabIndex={0}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && inputRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); add(e.dataTransfer.files); }}
        className={cn("mt-3 flex cursor-pointer flex-col items-center gap-1 rounded-lg border border-dashed px-4 py-5 text-center transition", drag ? "border-violet-400 bg-violet-500/10" : "border-white/15 hover:border-white/30")}
      >
        <UploadCloud size={22} className="text-slate-400" />
        <p className="text-xs text-slate-300">Drop files here or click to choose</p>
        <p className="text-[11px] text-slate-500">Word (.docx), PDF, PNG, JPG, TXT, MD, CSV · up to {MAX_FILES} files, 10 MB each</p>
        <input ref={inputRef} type="file" multiple accept={ACCEPT} className="hidden" onChange={(e) => { add(e.target.files); e.target.value = ""; }} />
      </div>

      {files.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {files.map((f) => (
            <li key={`${f.name}-${f.size}`} className="flex items-center gap-2 rounded-md bg-white/[.04] px-2.5 py-1.5 text-xs">
              <FileText size={14} className="text-slate-400" />
              <span className="min-w-0 flex-1 truncate text-slate-200">{f.name}</span>
              <span className="text-slate-500">{formatBytes(f.size)}</span>
              <button type="button" aria-label={`Remove ${f.name}`} onClick={() => setFiles(files.filter((x) => x !== f))} className="text-slate-500 hover:text-white"><X size={13} /></button>
            </li>
          ))}
        </ul>
      )}

      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="Optional: notes from a phone call or WhatsApp message"
        className="mt-3 min-h-14 w-full rounded-lg border border-white/[.08] bg-white/[.03] px-3 py-2 text-xs text-slate-100 outline-none placeholder:text-slate-600 focus:border-violet-400/60"
      />

      {error && <p className="mt-2 rounded-md border border-rose-400/20 bg-rose-500/10 px-2.5 py-1.5 text-xs text-rose-200">{error}</p>}

      {children && <div className="mt-3 space-y-3">{children}</div>}

      <button
        type="button"
        onClick={analyze}
        disabled={busy || (files.length === 0 && !notes.trim())}
        className="mt-3 flex items-center gap-2 rounded-lg bg-violet-500 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-400 disabled:opacity-50"
      >
        {busy ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />}
        {busy ? "Reading the document... (10-60 seconds)" : "Analyse & fill the form"}
      </button>
    </div>
  );
}
