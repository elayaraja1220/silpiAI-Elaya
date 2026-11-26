"use client";

import { useEffect } from "react";
import { AlertTriangle, Hammer, Loader2 } from "lucide-react";

import { useMoney } from "./money-context";

/**
 * "Are you sure?" before a project is generated. Generating starts a long run, so this says exactly what will be used and what
 * will be a placeholder, and nothing starts until it is confirmed.
 */
export function GenerateConfirmDialog({
  project,
  client,
  content,
  advanceMissing,
  hasDesign,
  demo,
  mode,
  busy = false,
  onConfirm,
  onCancel,
}: {
  project: string;
  client: string;
  /** How much of the client's content has been uploaded; null when not known here. */
  content: { uploaded: number; total: number } | null;
  /** The advance still to receive, when the work starts before it (demo only). */
  advanceMissing: number | null;
  /** true = a design reference was uploaded; false = none; undefined = not shown. */
  hasDesign?: boolean;
  demo: boolean;
  mode: "local" | "api";
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { fmt } = useMoney();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !busy) onCancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onCancel]);

  const placeholders = content ? Math.max(0, content.total - content.uploaded) : 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => !busy && onCancel()}>
      <div role="alertdialog" aria-modal="true" aria-labelledby="gen-title" onClick={(e) => e.stopPropagation()} className="w-full max-w-md rounded-2xl border border-white/10 bg-[#0f1424] p-6 shadow-2xl" data-testid="generate-confirm">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-violet-500/15 text-violet-300"><Hammer size={18} /></span>
          <div className="min-w-0">
            <h3 id="gen-title" className="text-sm font-semibold text-slate-100">Generate the project now?</h3>
            <p className="mt-1 break-words text-sm text-slate-300">{project}</p>
            <p className="text-xs text-slate-500">for {client}</p>
          </div>
        </div>

        <ul className="mt-4 space-y-2 text-xs leading-5 text-slate-300">
          {content && (
            <li className="rounded-lg bg-white/[.04] px-3 py-2">
              <b className="text-slate-100">{content.uploaded} of {content.total}</b> content items uploaded by the client.
              {placeholders > 0 ? ` The other ${placeholders} will use clearly marked placeholders.` : " Everything the site needs was supplied."}
            </li>
          )}
          <li className="rounded-lg bg-white/[.04] px-3 py-2">
            Runs on {mode === "local" ? <b className="text-slate-100">Local Claude Code</b> : <b className="text-slate-100">the Anthropic API</b>}
            {mode === "local" ? " with your own subscription: no API charge." : ". You will be asked to approve the estimated cost next."}
          </li>
          {hasDesign === true && <li className="rounded-lg bg-emerald-500/10 px-3 py-2 text-emerald-100" data-testid="design-yes">A design reference was uploaded. The website will follow it, and its real pages are compared with it afterwards to fill any gaps.</li>}
          {hasDesign === false && (
            <li className="flex gap-2 rounded-lg border border-amber-400/25 bg-amber-500/10 px-3 py-2 text-amber-100" data-testid="design-no">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <span><b>No design reference was uploaded.</b> The website gets a generic modern design from the brief. To make it look like a specific design, cancel and upload it under Client files, Design, first.</span>
            </li>
          )}
          {advanceMissing !== null && advanceMissing > 0 && (
            <li className="flex gap-2 rounded-lg border border-amber-400/25 bg-amber-500/10 px-3 py-2 text-amber-100">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <span>The advance of {fmt(advanceMissing)} has not been received. {demo ? "This is a demo-only start." : "Confirming starts the work before it is paid; this is recorded in the project history."}</span>
            </li>
          )}
          <li className="rounded-lg bg-white/[.04] px-3 py-2">By confirming, you confirm the approved scope of the quotation: exactly the pages, features and technology the client approved, and nothing from Phase 2.</li>
          <li className="px-1 text-slate-500">The build takes a few minutes. You can cancel the run while it is running.</li>
        </ul>

        <div className="mt-5 flex justify-end gap-2">
          <button autoFocus disabled={busy} onClick={onCancel} className="rounded-lg border border-white/10 px-4 py-2 text-sm text-slate-300 hover:bg-white/5 disabled:opacity-50">Cancel</button>
          <button disabled={busy} onClick={onConfirm} className="flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-50" data-testid="generate-confirm-yes">
            {busy ? <Loader2 size={15} className="animate-spin" /> : <Hammer size={15} />} Yes, generate the project
          </button>
        </div>
      </div>
    </div>
  );
}
