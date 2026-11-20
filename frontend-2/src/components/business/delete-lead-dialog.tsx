"use client";

import { useEffect, useState } from "react";
import { Loader2, Trash2 } from "lucide-react";

import { jsonFetch } from "@/components/business/ui";
import type { Lead } from "@/lib/business/types";

/** In-app confirmation before a lead (and its quotations, payments and hours) is deleted for good. */
export function DeleteLeadDialog({ lead, onClose, onDeleted, onError }: { lead: Lead; onClose: () => void; onDeleted: () => void; onError: (message: string) => void }) {
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !deleting) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [deleting, onClose]);

  const confirm = async () => {
    setDeleting(true);
    try {
      await jsonFetch(`/api/business/leads/${lead.id}`, { method: "DELETE" });
      onDeleted();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setDeleting(false);
      onClose();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => !deleting && onClose()}>
      <div role="alertdialog" aria-modal="true" aria-labelledby="del-title" onClick={(e) => e.stopPropagation()} className="w-full max-w-md rounded-2xl border border-white/10 bg-[#0f1424] p-6 shadow-2xl">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-rose-500/15 text-rose-300"><Trash2 size={18} /></span>
          <div className="min-w-0">
            <h3 id="del-title" className="text-sm font-semibold text-slate-100">Delete this requirement?</h3>
            <p className="mt-1 break-words text-sm text-slate-300">{lead.requirement.title}</p>
            <p className="mt-2 text-xs leading-5 text-slate-500">
              {lead.client.company || lead.client.name}{lead.quotation ? ` · ${lead.quotation.number}` : ""}. The quotation, payments and hours logged for it are removed permanently. Generated project folders are not touched. This cannot be undone.
            </p>
          </div>
        </div>
        <div className="mt-6 flex justify-end gap-2">
          <button autoFocus disabled={deleting} onClick={onClose} className="rounded-lg border border-white/10 px-4 py-2 text-sm text-slate-300 hover:bg-white/5 disabled:opacity-50">Cancel</button>
          <button disabled={deleting} onClick={confirm} className="flex items-center gap-2 rounded-lg bg-rose-500 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-400 disabled:opacity-50">
            {deleting ? <Loader2 size={15} className="animate-spin" /> : <Trash2 size={15} />} Delete
          </button>
        </div>
      </div>
    </div>
  );
}
