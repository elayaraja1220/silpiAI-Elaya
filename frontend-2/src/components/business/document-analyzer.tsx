"use client";

import { useEffect, useRef, useState } from "react";
import { FileText, Loader2, Sparkles, UploadCloud, X } from "lucide-react";

import { chooseSample, MAX_FILE_BYTES, MAX_LISTED, readingEstimate } from "@/lib/business/analyze-sample";
import type { RequirementDraft } from "@/lib/business/types";
import { cn, formatBytes } from "@/lib/utils";

const ACCEPT = ".docx,.pdf,.png,.jpg,.jpeg,.webp,.gif,.txt,.md,.csv";
const SHOWN = 6; // rows of the list shown before "and N more", so a thousand files do not become a thousand rows

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
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!busy) { setSeconds(0); return; }
    const t = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [busy]);

  const add = (list: FileList | null) => {
    if (!list) return;
    const incoming = Array.from(list);
    const word = incoming.find((f) => /\.doc$/i.test(f.name));
    // A file over the single-file size is still ADDED and counted; it just cannot be read by the AI, and the page says so.
    setError(word ? `${word.name}: old .doc format. In Word, use File > Save As > Word Document (.docx) or PDF.` : "");
    const ok = incoming.filter((f) => !/\.doc$/i.test(f.name));
    setFiles((old) => {
      const seen = new Set(old.map((o) => `${o.name}|${o.size}`));
      const fresh = ok.filter((f) => { const k = `${f.name}|${f.size}`; if (seen.has(k)) return false; seen.add(k); return true; });
      return [...old, ...fresh].slice(0, MAX_LISTED);
    });
  };

  // What the AI will read from what was added: the written documents, then page images spread evenly. The rest is counted and named, not read.
  const picked = chooseSample(files.map((f) => ({ name: f.name, size: f.size })));
  const sample = picked.map((i) => files[i]!);
  const tooBig = files.filter((f) => f.size > MAX_FILE_BYTES).length;

  const analyze = async () => {
    setBusy(true);
    setError("");
    try {
      const body = new FormData();
      sample.forEach((f) => body.append("files", f));
      // Every file's name and size goes too (a few bytes each), so the AI is told how many there really are.
      body.append("manifest", JSON.stringify(files.map((f) => ({ name: f.name, size: f.size }))));
      body.append("notes", notes);
      const response = await fetch("/api/business/analyze", { method: "POST", body });
      const result = (await response.json().catch(() => ({}))) as { success?: boolean; error?: string; draft?: RequirementDraft; model?: string; costUsd?: number; cached?: boolean; runs?: number; partial?: boolean };
      if (!result.success || !result.draft) throw new Error(result.error || `Analysis failed (${response.status}).`);
      onDraft({ draft: result.draft, files: [...sample.map((f) => f.name), ...(files.length > sample.length ? [`and ${files.length - sample.length} more files (counted, not read)`] : [])], model: result.model ?? "", costUsd: result.costUsd ?? 0, cached: result.cached, runs: result.runs, partial: result.partial });
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
        <p className="text-[11px] text-slate-500">Word (.docx), PDF, PNG, JPG, TXT, MD, CSV · as many files as the client sent, 10 MB each</p>
        <input ref={inputRef} type="file" multiple accept={ACCEPT} className="hidden" onChange={(e) => { add(e.target.files); e.target.value = ""; }} />
      </div>

      {files.length > 0 && (
        <p className="mt-3 text-xs text-slate-300">
          <b>{files.length}</b> file{files.length === 1 ? "" : "s"} added.{" "}
          {sample.length < files.length
            ? <>The AI will read <b>{sample.length}</b> of them: the written documents, then page images spread from the first to the last. It is told the total ({files.length}) and every file name, so the page count comes from <b>all {files.length}</b>. Keep the rest for the project&apos;s own files.</>
            : <>The AI will read all of them.</>}
          {tooBig > 0 && <span className="text-amber-300"> {tooBig} file{tooBig === 1 ? " is" : "s are"} over 10 MB: counted, but not read.</span>}
          {sample.length === 0 && files.length > 0 && <span className="text-amber-300"> None of these can be read by the AI (only documents and images up to 10 MB can). Type the requirement in the notes.</span>}
        </p>
      )}
      {files.length > 0 && (
        <ul className="mt-2 space-y-1.5">
          {files.slice(0, SHOWN).map((f) => (
            <li key={`${f.name}-${f.size}`} className="flex items-center gap-2 rounded-md bg-white/[.04] px-2.5 py-1.5 text-xs">
              <FileText size={14} className="text-slate-400" />
              <span className="min-w-0 flex-1 truncate text-slate-200">{f.name}</span>
              <span className="text-slate-500">{formatBytes(f.size)}</span>
              <button type="button" aria-label={`Remove ${f.name}`} onClick={() => setFiles(files.filter((x) => x !== f))} className="text-slate-500 hover:text-white"><X size={13} /></button>
            </li>
          ))}
          {files.length > SHOWN && (
            <li className="flex items-center justify-between rounded-md bg-white/[.04] px-2.5 py-1.5 text-xs text-slate-400">
              <span>and {files.length - SHOWN} more</span>
              <button type="button" onClick={() => setFiles([])} className="text-slate-300 underline hover:text-white">Clear all</button>
            </li>
          )}
        </ul>
      )}

      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="Optional: notes from a phone call or WhatsApp message"
        className="mt-3 min-h-14 w-full rounded-lg border border-white/[.08] bg-white/[.03] px-3 py-2 text-xs text-slate-100 outline-none placeholder:text-slate-600 focus:border-violet-400/60"
      />

      {busy && (() => { const e = readingEstimate(sample.map((f) => ({ name: f.name, size: f.size }))); const show = (s: number) => (s < 90 ? `${s} seconds` : `${(s / 60).toFixed(1).replace(".0", "")} minutes`); return (
        <p className="mt-2 text-xs text-slate-400">Usually {show(e.minSeconds)} to {show(e.maxSeconds)} for this many files. It reads them several times and keeps what the readings agree on, so please wait: it can take up to 4 minutes.{seconds > e.maxSeconds ? " Taking longer than usual: still working." : ""}</p>
      ); })()}

      {error && <p className="mt-2 rounded-md border border-rose-400/20 bg-rose-500/10 px-2.5 py-1.5 text-xs text-rose-200">{error}</p>}

      {children && <div className="mt-3 space-y-3">{children}</div>}

      <button
        type="button"
        onClick={analyze}
        disabled={busy || (sample.length === 0 && !notes.trim())}
        className="mt-3 flex items-center gap-2 rounded-lg bg-violet-500 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-400 disabled:opacity-50"
      >
        {busy ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />}
        {busy ? `Reading ${sample.length || "your notes"}${sample.length ? (sample.length === 1 ? " file" : " files") : ""}... ${seconds}s` : "Analyse & fill the form"}
      </button>
    </div>
  );
}
