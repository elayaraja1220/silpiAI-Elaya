"use client";

import { useEffect, useMemo, useRef } from "react";
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  FileCode2,
  FolderOpen,
  Loader2,
  Search,
  TerminalSquare,
  Trash2,
  XCircle,
} from "lucide-react";

import type { RunStatus, RunTotals } from "@/lib/use-agent-run";
import type { AgentEvent } from "@/types";

type AgentRunPanelProps = {
  events: AgentEvent[];
  status: RunStatus;
  error: string | null;
  result: Extract<AgentEvent, { type: "done" }> | null;
  totals: RunTotals;
};

const TOOL_ICONS: Record<string, typeof Bot> = {
  list_files: FolderOpen,
  read_file: FileCode2,
  search_files: Search,
  write_file: FileCode2,
  edit_file: FileCode2,
  delete_file: Trash2,
  run_command: TerminalSquare,
};

const formatTokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}k` : String(n));

type Row =
  | { kind: "step"; tool: string; label: string; state: "running" | "ok" | "failed"; detail?: string }
  | { kind: "message"; text: string }
  | { kind: "status"; text: string }
  | { kind: "error"; text: string };

/** Pair each action with its result so a step shows as one row. */
function toRows(events: AgentEvent[]): Row[] {
  const rows: Row[] = [];
  for (const event of events) {
    if (event.type === "action") {
      rows.push({ kind: "step", tool: event.tool, label: event.label, state: "running" });
    } else if (event.type === "result") {
      for (let i = rows.length - 1; i >= 0; i--) {
        const row = rows[i];
        if (row.kind === "step" && row.state === "running" && row.label === event.label) {
          rows[i] = { ...row, state: event.ok ? "ok" : "failed", detail: event.detail };
          break;
        }
      }
    } else if (event.type === "message") {
      rows.push({ kind: "message", text: event.text });
    } else if (event.type === "status") {
      rows.push({ kind: "status", text: event.message });
    } else if (event.type === "error") {
      rows.push({ kind: "error", text: event.message });
    }
  }
  return rows;
}

export function AgentRunPanel({ events, status, error, result, totals }: AgentRunPanelProps) {
  const rows = useMemo(() => toRows(events), [events]);
  const filesWritten = useMemo(
    () => new Set(events.flatMap((e) => (e.type === "result" && e.ok && (e.tool === "write_file" || e.tool === "edit_file") ? [e.label] : []))).size,
    [events],
  );
  const commands = events.filter((e) => e.type === "result" && e.tool === "run_command").length;

  const logRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  useEffect(() => {
    const el = logRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [rows.length]);

  if (status === "idle") return null;

  const header =
    status === "running"
      ? { icon: <Loader2 size={16} className="animate-spin text-violet-300" />, title: "SILPI is working...", tone: "border-violet-400/20" }
      : status === "success"
        ? { icon: <CheckCircle2 size={16} className="text-emerald-300" />, title: "Finished successfully", tone: "border-emerald-400/25" }
        : { icon: <XCircle size={16} className="text-rose-300" />, title: result ? "Finished with problems" : "Run failed", tone: "border-rose-400/25" };

  return (
    <section className={`overflow-hidden rounded-xl border bg-[#151923] ${header.tone}`} aria-live="polite">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/[.06] px-4 py-3">
        <div className="flex items-center gap-2">
          {header.icon}
          <h3 className="text-xs font-semibold">{header.title}</h3>
        </div>
        <div className="flex flex-wrap gap-3 text-[10px] text-slate-500">
          <span>{totals.turns} steps</span>
          <span>{filesWritten} files</span>
          <span>{commands} commands</span>
          <span title="Input tokens (incl. cache writes) / output tokens / cache reads">
            {formatTokens(totals.inputTokens)} in · {formatTokens(totals.outputTokens)} out · {formatTokens(totals.cacheReadTokens)} cached
          </span>
        </div>
      </div>

      {/* Live log */}
      <div
        ref={logRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        className="custom-scrollbar max-h-[420px] space-y-1 overflow-y-auto px-4 py-3 font-mono text-[11px]"
      >
        {rows.map((row, i) => {
          if (row.kind === "message") {
            return (
              <p key={i} className="whitespace-pre-wrap py-1.5 font-sans text-xs leading-5 text-slate-300">
                <Bot size={13} className="mr-1.5 inline text-violet-300" />
                {row.text}
              </p>
            );
          }
          if (row.kind === "status") {
            return (
              <p key={i} className="text-slate-500">
                {row.text}
              </p>
            );
          }
          if (row.kind === "error") {
            return (
              <p key={i} className="whitespace-pre-wrap rounded-md bg-rose-400/10 px-2 py-1.5 text-rose-200">
                <AlertTriangle size={12} className="mr-1.5 inline" />
                {row.text}
              </p>
            );
          }
          const Icon = TOOL_ICONS[row.tool] ?? Bot;
          return (
            <div key={i}>
              <div className="flex items-center gap-2">
                {row.state === "running" ? (
                  <Loader2 size={12} className="shrink-0 animate-spin text-slate-500" />
                ) : row.state === "ok" ? (
                  <CheckCircle2 size={12} className="shrink-0 text-emerald-400/80" />
                ) : (
                  <XCircle size={12} className="shrink-0 text-amber-300" />
                )}
                <Icon size={12} className="shrink-0 text-slate-600" />
                <span className={row.state === "failed" ? "text-amber-200" : "text-slate-400"}>{row.label}</span>
              </div>
              {row.state === "failed" && row.detail && (
                <pre className="ml-6 mt-1 max-h-32 overflow-auto whitespace-pre-wrap rounded bg-black/30 p-2 text-[10px] text-slate-500">
                  {row.detail}
                </pre>
              )}
            </div>
          );
        })}
        {status === "running" && rows.length === 0 && <p className="text-slate-500">Starting the agent...</p>}
      </div>

      {/* Result */}
      {(result || (error && status !== "running")) && (
        <div className="space-y-1.5 border-t border-white/[.06] px-4 py-3 text-xs">
          {result?.summary && <p className="leading-5 text-slate-300">{result.summary}</p>}
          {result && (
            <p className="text-[10px] text-slate-500">
              Build check:{" "}
              {result.buildPassed === true ? (
                <span className="text-emerald-300">passed</span>
              ) : result.buildPassed === false ? (
                <span className="text-amber-300">failed</span>
              ) : (
                "not run"
              )}{" "}
              · {result.filesChanged.length} files changed
            </p>
          )}
          {result?.path && <p className="break-all font-mono text-[10px] text-emerald-300/90">{result.path}</p>}
          {error && !result && <p className="text-rose-300">{error}</p>}
        </div>
      )}
    </section>
  );
}
