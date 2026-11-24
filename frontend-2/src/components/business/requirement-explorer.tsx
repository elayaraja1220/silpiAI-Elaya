"use client";

import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Search } from "lucide-react";

import type { ClarificationItem, InsightDecision } from "@/lib/business/clarifications";
import {
  complexityOfItem, descriptionOf, FILTER_LABEL, filterCounts, groupItems, KIND_LABEL, matchesFilter, nextCount, PAGE_STEP, priorityOfItem, searchItems, statusOf, titleOf,
  VIEW_FILTERS, visibleCount, type ViewFilter,
} from "@/lib/business/requirement-view";
import { cn } from "@/lib/utils";

const STATUS_TONE: Record<ClarificationItem["status"], string> = {
  confirmed: "bg-emerald-500/15 text-emerald-200",
  unanswered: "bg-rose-500/15 text-rose-200",
  "not-applicable": "bg-slate-500/20 text-slate-300",
  "pending-approval": "bg-amber-500/15 text-amber-200",
  "needs-clarification": "bg-orange-500/15 text-orange-200",
  rejected: "bg-slate-500/20 text-slate-400",
  deferred: "bg-sky-500/15 text-sky-200",
};
const LEVEL_TONE: Record<string, string> = { critical: "bg-rose-500/20 text-rose-200", high: "bg-orange-500/15 text-orange-200", medium: "bg-sky-500/15 text-sky-200", low: "bg-white/10 text-slate-300" };

const Chip = ({ children, className }: { children: React.ReactNode; className?: string }) => (
  <span className={cn("inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-[10px] font-medium capitalize", className)}>{children}</span>
);

/**
 * The requirement list: filter tabs with their counts, search, groups by module that open and close, and only a few rows drawn
 * at first ("Load more" adds more), so a document with hundreds of items stays easy to scan. Rows are collapsed until opened.
 * What each tab holds is decided by requirement-view.ts, the same rules the summary cards use.
 */
export function RequirementExplorer({
  items,
  documents,
  onDecide,
  busy = false,
}: {
  items: ClarificationItem[];
  /** The files the analysis was read from, shown with each item's section. */
  documents: string[];
  onDecide?: (itemId: string, decision: InsightDecision) => void;
  busy?: boolean;
}) {
  const [filter, setFilter] = useState<ViewFilter>("all");
  const [query, setQuery] = useState("");
  const [loaded, setLoaded] = useState<Record<string, number>>({});
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const [opened, setOpened] = useState<Set<string>>(new Set());

  const counts = useMemo(() => filterCounts(items), [items]);
  const shown = useMemo(() => searchItems(items.filter((i) => matchesFilter(i, filter)), query), [items, filter, query]);
  const groups = useMemo(() => groupItems(shown), [shown]);
  // Few results: show every group open. Many: only the first, the rest are one click away.
  const groupOpen = (key: string, index: number) => toggled[key] ?? (shown.length <= 12 || index === 0);

  const pick = (f: ViewFilter) => { setFilter(f); setLoaded({}); setToggled({}); };
  const source = documents.length === 1 ? documents[0] : documents.length > 1 ? documents.join(", ") : "";

  return (
    <section data-testid="requirement-explorer" aria-label="Requirements">
      <div role="tablist" aria-label="Filter requirements" className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1">
        {VIEW_FILTERS.map((f) => (
          <button
            key={f}
            role="tab"
            type="button"
            aria-selected={filter === f}
            data-testid={`filter-${f}`}
            onClick={() => pick(f)}
            className={cn("flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1 text-[11px] transition", filter === f ? "border-violet-400/60 bg-violet-500/20 text-white" : "border-white/10 text-slate-400 hover:text-slate-200")}
          >
            {FILTER_LABEL[f]}
            <span className="rounded-full bg-white/10 px-1.5 text-[10px] tabular-nums" data-testid={`count-${f}`}>{counts[f]}</span>
          </button>
        ))}
      </div>

      <label className="mt-2 flex items-center gap-2 rounded-lg border border-white/[.08] bg-white/[.03] px-2.5 py-1.5">
        <Search size={13} className="shrink-0 text-slate-500" />
        <input
          value={query}
          onChange={(e) => { setQuery(e.target.value); setLoaded({}); }}
          placeholder="Search by ID, words, section or answer"
          aria-label="Search requirements"
          className="min-w-0 flex-1 bg-transparent text-xs text-slate-100 outline-none placeholder:text-slate-600"
        />
        {query && <button type="button" onClick={() => setQuery("")} className="text-[11px] text-slate-500 hover:text-white">Clear</button>}
      </label>
      <p className="mt-1.5 text-[11px] text-slate-500" data-testid="result-count">
        {shown.length} item{shown.length === 1 ? "" : "s"}{query ? ` matching "${query}"` : ""} in {groups.length} module{groups.length === 1 ? "" : "s"}
      </p>

      {groups.length === 0 && <p className="mt-3 rounded-lg border border-dashed border-white/10 px-3 py-4 text-center text-xs text-slate-500">Nothing here{query ? " for this search" : ""}.</p>}

      <div className="mt-2 space-y-2">
        {groups.map((g, gi) => {
          const open = groupOpen(g.key, gi);
          const count = visibleCount(g.items.length, loaded[g.key]);
          return (
            <div key={g.key} className="rounded-lg border border-white/[.07]" data-testid="module-group">
              <button
                type="button"
                aria-expanded={open}
                onClick={() => setToggled((t) => ({ ...t, [g.key]: !open }))}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-medium text-slate-200 hover:bg-white/[.03]"
              >
                {open ? <ChevronDown size={14} className="shrink-0 text-slate-500" /> : <ChevronRight size={14} className="shrink-0 text-slate-500" />}
                <span className="min-w-0 flex-1 truncate">{g.label}</span>
                <span className="rounded-full bg-white/10 px-2 text-[10px] tabular-nums text-slate-300">{g.items.length}</span>
              </button>
              {open && (
                <div className="border-t border-white/[.05]">
                  <ul className="divide-y divide-white/[.05]">
                    {g.items.slice(0, count).map((item) => {
                      const isOpen = opened.has(item.id);
                      const description = descriptionOf(item);
                      const priority = priorityOfItem(item);
                      const complexity = complexityOfItem(item);
                      return (
                        <li key={item.id} data-testid="requirement-row">
                          <button
                            type="button"
                            aria-expanded={isOpen}
                            onClick={() => setOpened((o) => { const n = new Set(o); if (n.has(item.id)) n.delete(item.id); else n.add(item.id); return n; })}
                            className="flex w-full flex-wrap items-start gap-x-2 gap-y-1 px-3 py-2 text-left hover:bg-white/[.03]"
                          >
                            <span className="w-[4.5rem] shrink-0 font-mono text-[10px] leading-5 text-slate-500">{item.id}</span>
                            <span className="min-w-0 flex-1 basis-48 text-xs leading-5 text-slate-200">{titleOf(item)}</span>
                            <span className="flex flex-wrap items-center gap-1">
                              <Chip className={STATUS_TONE[item.status]}>{statusOf(item)}</Chip>
                              {priority && <Chip className={LEVEL_TONE[priority] ?? LEVEL_TONE.low}>{item.kind === "discovered" ? `impact ${priority}` : priority}</Chip>}
                              {complexity && item.kind === "requirement" && <Chip className="bg-violet-500/15 text-violet-200">{complexity} complexity</Chip>}
                            </span>
                          </button>
                          {onDecide && !isOpen && (item.status === "unanswered" || item.status === "pending-approval" || item.status === "needs-clarification") && item.kind !== "requirement" && (
                            <div className="flex flex-wrap items-center gap-2 px-3 pb-2 pl-[5.25rem]">
                              <button type="button" disabled={busy} data-testid="defer-inline" onClick={() => onDecide(item.id, "defer")} className="rounded-md border border-sky-400/30 px-2 py-0.5 text-[11px] text-sky-200 hover:bg-sky-500/10 disabled:opacity-50">Start without it: quote later</button>
                              <span className="text-[10px] text-slate-500">Left out of the price; the client is told.</span>
                            </div>
                          )}
                          {item.status === "deferred" && onDecide && (
                            <div className="flex flex-wrap items-center gap-2 px-3 pb-2 pl-[5.25rem]">
                              <span className="text-[10px] text-sky-300">Not in the price: quoted separately later.</span>
                              <button type="button" disabled={busy} onClick={() => onDecide(item.id, "reset")} className="rounded-md border border-white/15 px-2 py-0.5 text-[11px] text-slate-300 hover:bg-white/5 disabled:opacity-50">Undo</button>
                            </div>
                          )}
                          {isOpen && (
                            <dl className="grid gap-x-4 gap-y-1 bg-white/[.02] px-3 py-2 text-[11px] text-slate-400 sm:grid-cols-[7rem_1fr]">
                              <dt className="text-slate-500">ID</dt><dd className="font-mono">{item.id}</dd>
                              <dt className="text-slate-500">Type</dt><dd>{KIND_LABEL[item.kind]}{item.type === "non-functional" ? " (non-functional)" : item.type === "functional" ? " (functional)" : ""}</dd>
                              <dt className="text-slate-500">Requirement</dt><dd className="text-slate-300">{titleOf(item, 120)}</dd>
                              {description && <><dt className="text-slate-500">Description</dt><dd>{description}</dd></>}
                              <dt className="text-slate-500">Source</dt>
                              <dd>{[source, item.source].filter(Boolean).join(" › ") || (item.origin === "discovered" ? "Raised by the AI from a gap" : "Not recorded")}</dd>
                              <dt className="text-slate-500">Status</dt><dd>{statusOf(item)}</dd>
                              <dt className="text-slate-500">Priority</dt><dd className="capitalize">{priority || (item.kind === "question" ? "n/a (answered)" : "n/a")}</dd>
                              <dt className="text-slate-500">Complexity</dt><dd className="capitalize">{complexity || "Not stated in the document"}</dd>
                              {item.kind === "question" && <><dt className="text-slate-500">Client response</dt><dd className={item.answer ? "text-slate-200" : "italic text-slate-500"}>{item.answer || "No response yet"}</dd></>}
                              {item.reason && <><dt className="text-slate-500">Why it is needed</dt><dd>{item.reason}</dd></>}
                              {item.module && <><dt className="text-slate-500">Adds feature</dt><dd>{item.module}</dd></>}
                              {onDecide && item.kind === "question" && (item.status === "unanswered" || item.status === "deferred") && (
                                <>
                                  <dt className="text-slate-500">Decision</dt>
                                  <dd className="flex flex-wrap items-center gap-1.5">
                                    {item.status === "unanswered" ? (
                                      <button type="button" disabled={busy} data-testid="defer-question" onClick={() => onDecide(item.id, "defer")} className="rounded-md border border-sky-400/30 px-2 py-0.5 text-[11px] text-sky-200 hover:bg-sky-500/10 disabled:opacity-50">Start without it: quote later</button>
                                    ) : (
                                      <button type="button" disabled={busy} onClick={() => onDecide(item.id, "reset")} className="rounded-md border border-white/15 px-2 py-0.5 text-[11px] text-slate-300 hover:bg-white/5 disabled:opacity-50">Undo</button>
                                    )}
                                    <span className="text-[10px] text-slate-500">The client is told this is not in the price.</span>
                                  </dd>
                                </>
                              )}
                              {onDecide && (item.kind === "discovered" || item.kind === "assumption") && (
                                <>
                                  <dt className="text-slate-500">Decision</dt>
                                  <dd className="flex flex-wrap gap-1.5">
                                    {(["accept", "reject", "clarify", "defer"] as const).map((d) => (
                                      <button
                                        key={d}
                                        type="button"
                                        disabled={busy}
                                        onClick={() => onDecide(item.id, d)}
                                        className={cn("rounded-md border px-2 py-0.5 text-[11px] disabled:opacity-50", d === "accept" ? "border-emerald-400/30 text-emerald-200 hover:bg-emerald-500/10" : d === "reject" ? "border-rose-400/30 text-rose-200 hover:bg-rose-500/10" : d === "defer" ? "border-sky-400/30 text-sky-200 hover:bg-sky-500/10" : "border-amber-400/30 text-amber-200 hover:bg-amber-500/10")}
                                      >
                                        {d === "defer" ? "Start without it: quote later" : item.kind === "assumption" ? (d === "accept" ? "Client approved" : d === "reject" ? "Reject" : "Needs clarification") : d === "accept" ? "Accept" : d === "reject" ? "Reject" : "Needs clarification"}
                                      </button>
                                    ))}
                                    {item.status !== "pending-approval" && (
                                      <button type="button" disabled={busy} onClick={() => onDecide(item.id, "reset")} className="rounded-md border border-white/15 px-2 py-0.5 text-[11px] text-slate-300 hover:bg-white/5 disabled:opacity-50">Undo</button>
                                    )}
                                  </dd>
                                </>
                              )}
                            </dl>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                  {count < g.items.length && (
                    <button
                      type="button"
                      data-testid="load-more"
                      onClick={() => setLoaded((l) => ({ ...l, [g.key]: nextCount(g.items.length, l[g.key]) }))}
                      className="w-full border-t border-white/[.05] px-3 py-2 text-center text-[11px] text-violet-300 hover:bg-white/[.03]"
                    >
                      Load more ({g.items.length - count} remaining, {Math.min(PAGE_STEP, g.items.length - count)} at a time)
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
