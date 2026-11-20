"use client";

import { useState } from "react";
import { AlertTriangle, Hammer, Loader2 } from "lucide-react";

import { Card, jsonFetch } from "@/components/business/ui";
import { AgentRunPanel } from "@/components/ui/agent-run-panel";
import { paymentStatus } from "@/lib/business/payment-status";
import { formatINR } from "@/lib/business/pricing";
import type { Lead, Stage } from "@/lib/business/types";
import { useAgentRun } from "@/lib/use-agent-run";

type History = { fromStage: Stage | null; toStage: Stage; note: string; at: string }[];

/**
 * Starts building the approved proposal with the SILPI agent. Without the
 * advance, the team must tick "start without advance" and give a reason.
 */
export function BuildPanel({ lead, onChanged }: { lead: Lead; onChanged: (r: { lead: Lead; history: History }) => void }) {
  const run = useAgentRun();
  const [withoutAdvance, setWithoutAdvance] = useState(false);
  const [reason, setReason] = useState("");
  const status = paymentStatus(lead.quotation, lead.payments);
  const advanceMissing = status.advanceRemaining > 0;
  const canStart = lead.stage === "advance_paid" || (lead.stage === "approved" && withoutAdvance && reason.trim().length >= 5) || lead.stage === "in_development";

  const refresh = () =>
    jsonFetch<{ lead: Lead; history: History }>(`/api/business/leads/${lead.id}`)
      .then(onChanged)
      .catch(() => {});

  const start = async () => {
    await run.start(`/api/business/leads/${lead.id}/build`, { withoutAdvance, reason });
    void refresh();
  };
  const resume = async (project: string) => {
    await run.start(`/api/projects/${encodeURIComponent(project)}/resume`, {});
    void refresh();
  };

  const busy = run.status === "running";
  const started = lead.stage === "in_development";

  return (
    <Card className="no-print space-y-4 border-violet-400/25">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="flex items-center gap-2 text-sm font-semibold text-slate-100"><Hammer size={16} className="text-violet-300" /> Development</p>
          <p className="mt-1 text-xs text-slate-400">
            {started
              ? <>Project <span className="font-mono text-slate-200">{lead.projectName}</span> is in development. Changes and re-runs are in <b>My projects</b>.</>
              : "SILPI builds exactly the approved proposal: its pages, sections, features, technology and SEO. Phase-2 items are left out."}
          </p>
        </div>
        {!started && (
          <button
            onClick={start}
            disabled={!canStart || busy}
            className="flex items-center gap-2 rounded-lg bg-violet-500 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-400 disabled:opacity-40"
          >
            {busy ? <Loader2 size={15} className="animate-spin" /> : <Hammer size={15} />} Start development
          </button>
        )}
        {started && run.status === "idle" && (
          <button onClick={start} className="rounded-lg border border-white/10 px-3 py-2 text-xs text-slate-300 hover:bg-white/5" title="Only if the first run failed before writing any files">
            Retry first build
          </button>
        )}
      </div>

      {lead.stage === "approved" && advanceMissing && (
        <div className="space-y-2 rounded-lg border border-amber-400/25 bg-amber-500/[.07] p-3">
          <p className="flex items-center gap-1.5 text-xs font-medium text-amber-100">
            <AlertTriangle size={14} /> Advance of {formatINR(status.advanceRemaining)} not received yet.
          </p>
          <label className="flex items-center gap-2 text-xs text-slate-300">
            <input type="checkbox" checked={withoutAdvance} onChange={(e) => setWithoutAdvance(e.target.checked)} className="accent-violet-500" />
            Start without advance (team decision)
          </label>
          {withoutAdvance && (
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={300}
              placeholder="Why? e.g. regular client, paying on Friday; or internal test"
              className="w-full rounded-lg border border-white/[.08] bg-white/[.03] px-3 py-2 text-xs text-slate-100 outline-none focus:border-violet-400/60"
            />
          )}
          <p className="text-[11px] text-slate-500">
            Safe either way: source code, build files and hosting are handed over only after full payment. Starting early risks your time and AI cost only.
          </p>
        </div>
      )}

      <AgentRunPanel events={run.events} status={run.status} error={run.error} result={run.result} totals={run.totals} onResume={(p) => void resume(p)} />
      {busy && <p className="text-[11px] text-slate-500">You can leave this page; the build keeps running and the project appears in My projects.</p>}
    </Card>
  );
}
