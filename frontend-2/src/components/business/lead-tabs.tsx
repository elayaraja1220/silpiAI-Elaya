"use client";

import { ArrowRight, Check, CheckCircle2, Circle, Lock } from "lucide-react";

import { formatMoney, moneyOf } from "@/lib/business/money";
import { paymentStatus } from "@/lib/business/payment-status";
import { BILLING_CYCLE_LABELS } from "@/lib/business/types";
import type { Lead, Stage } from "@/lib/business/types";
import { cn } from "@/lib/utils";

export type TabId = "summary" | "quotation" | "files" | "build" | "demo" | "payments" | "internal";

export type TabDef = { id: TabId; label: string; hint?: string };

/** The tab bar of a lead. Only the tabs that make sense for the current stage are passed in. */
export function LeadTabBar({ tabs, active, onChange }: { tabs: TabDef[]; active: TabId; onChange: (id: TabId) => void }) {
  return (
    <div role="tablist" aria-label="Sections" className="no-print -mx-1 flex gap-1 overflow-x-auto border-b border-white/[.07] px-1">
      {tabs.map((t) => {
        const on = t.id === active;
        return (
          <button
            key={t.id}
            role="tab"
            aria-selected={on}
            id={`tab-${t.id}`}
            aria-controls={`panel-${t.id}`}
            type="button"
            onClick={() => onChange(t.id)}
            className={cn(
              "relative flex shrink-0 items-center gap-2 whitespace-nowrap px-4 py-3 text-sm font-medium transition",
              on ? "text-white" : "text-slate-400 hover:text-slate-200",
            )}
          >
            {t.label}
            {t.hint && <span className="rounded-full bg-white/10 px-2 py-0.5 text-[10px] font-normal text-slate-400">{t.hint}</span>}
            {on && <span className="absolute inset-x-3 -bottom-px h-0.5 rounded-full bg-violet-400" />}
          </button>
        );
      })}
    </div>
  );
}

/** A tab's content stays mounted (so uploads and forms keep their state) but is hidden unless active. It still prints. */
export function TabPanel({ id, active, children }: { id: TabId; active: TabId; children: React.ReactNode }) {
  return (
    <div role="tabpanel" id={`panel-${id}`} aria-labelledby={`tab-${id}`} className={cn("space-y-5", id === active ? "block" : "hidden print:block")}>
      {children}
    </div>
  );
}

// ---- the journey: where this project is, in plain steps ---------------------------------------------------------------------

const JOURNEY: { label: string; stages: Stage[] }[] = [
  { label: "Requirement", stages: ["requirement"] },
  { label: "Quoted", stages: ["quoted"] },
  { label: "Approved", stages: ["approved"] },
  { label: "Advance paid", stages: ["advance_paid"] },
  { label: "Building", stages: ["in_development", "testing"] },
  { label: "Demo ready", stages: ["demo_ready"] },
  { label: "Fully paid", stages: ["final_paid"] },
  { label: "Delivered", stages: ["delivered"] },
];

export function JourneyStepper({ stage }: { stage: Stage }) {
  const current = JOURNEY.findIndex((j) => j.stages.includes(stage));
  if (stage === "lost" || current < 0) return null;
  return (
    <ol className="no-print flex items-center gap-1 overflow-x-auto pb-1" aria-label="Project progress">
      {JOURNEY.map((j, i) => {
        const done = i < current;
        const now = i === current;
        return (
          <li key={j.label} className="flex shrink-0 items-center gap-1" aria-current={now ? "step" : undefined}>
            <span className={cn("flex items-center gap-2 rounded-full px-3 py-1.5 text-xs transition", now ? "bg-violet-500/20 font-semibold text-white ring-1 ring-violet-400/50" : done ? "text-emerald-300" : "text-slate-600")}>
              <span className={cn("flex h-4 w-4 items-center justify-center rounded-full text-[9px]", done ? "bg-emerald-500 text-white" : now ? "bg-violet-500 text-white" : "bg-white/10")}>
                {done ? <Check size={10} strokeWidth={3} /> : i + 1}
              </span>
              <span className={cn(!now && !done && "hidden sm:inline", !now && done && "hidden md:inline")}>{j.label}</span>
            </span>
            {i < JOURNEY.length - 1 && <span className={cn("h-px w-3 sm:w-5", done ? "bg-emerald-500/50" : "bg-white/10")} />}
          </li>
        );
      })}
    </ol>
  );
}

// ---- what to do next --------------------------------------------------------------------------------------------------------------

/** How much of the client's content has been uploaded (any amount counts: partial is fine). */
export type FilesProgress = { withContent: number; total: number; /** A design reference picture has been uploaded. */ hasDesign?: boolean };

type Row = { label: string; hint: string; done: boolean; cta?: string; tab?: TabId; locked?: string };

function rowsFor(lead: Lead, files: FilesProgress | null): Row[] {
  const pay = paymentStatus(lead.quotation, lead.payments);
  // Amounts are held in rupees; a client abroad's are written in their own currency.
  const fmt = (n: number) => formatMoney(n, moneyOf(lead.quotation));
  switch (lead.stage) {
    case "requirement":
      return [{ label: "Check the quotation", hint: "Review the pages, features and price, then send it to the client.", done: false, cta: "Open quotation", tab: "quotation" }];
    case "quoted":
      return [{ label: "Send the quotation to the client", hint: lead.shareToken ? "The link is ready. Waiting for the client to answer." : "Create the secure link and send it by WhatsApp or email.", done: !!lead.shareToken, cta: "Share quotation", tab: "quotation" }];
    case "approved":
    case "advance_paid":
    case "in_development":
    case "testing":
    case "demo_ready": {
      const uploaded = files?.withContent ?? 0;
      const started = lead.stage !== "approved" && lead.stage !== "advance_paid";
      // Generating needs some of the client's content first. Partial is enough; nothing is not. (Once a project exists this no longer applies.)
      const lockReason = started ? undefined : files === null ? "Checking the client's files..." : uploaded === 0 ? "Locked until the client's files are collected. Upload at least one file or some content (partial is fine)." : undefined;
      // Hourly engagement: the team does the work and logs hours; SILPI AI generation is only an optional helper.
      const hourly = lead.quotation?.hourly;
      const worked = lead.workLog.reduce((t, e) => t + e.hours, 0);
      const opt = hourly ? " (optional)" : "";
      const rows: Row[] = [
        { label: "Advance payment", hint: pay.advanceRemaining <= 0 ? `Received ${fmt(pay.advancePaid)}.` : `${fmt(pay.advanceRemaining)} still to receive.`, done: pay.advanceRemaining <= 0, cta: "Record payment", tab: "payments" },
        ...(hourly ? [{ label: "Do the work and log your hours", hint: `${Math.round(worked * 10) / 10} of ${hourly.capHours} cap hours used (${hourly.expectedHours} estimated). Bill the client ${BILLING_CYCLE_LABELS[hourly.cycle]} for the hours worked.`, done: false, cta: "Log hours", tab: "payments" as TabId }] : []),
        {
          label: `Collect the client's files and content${opt}`,
          hint: files ? (uploaded > 0 ? `${uploaded} of ${files.total} items uploaded. Partial is fine, and you can add more any time.` : "Nothing uploaded yet. Upload at least one file or some content to unlock the next step.") : "Logo, images and page content from the client.",
          done: !!files && files.total > 0 && uploaded === files.total,
          cta: uploaded > 0 ? "Add more" : "Collect files",
          tab: "files",
        },
        {
          label: hourly ? "Generate with SILPI AI (optional)" : "Generate the project",
          hint: lead.stage === "demo_ready" ? "Built and ready for the client's demo." : lead.stage === "in_development" || lead.stage === "testing" ? "In progress." : "Builds the website from whatever the client uploaded. You will be asked to confirm first.",
          done: lead.stage === "demo_ready",
          cta: lead.stage === "in_development" || lead.stage === "testing" ? "Open build" : "Generate",
          tab: "build",
          locked: lockReason,
        },
      ];
      if (lead.projectName) rows.push({ label: "Show the client a demo", hint: "A private link that ends by itself. Nothing is sent to them until you share it.", done: false, cta: "Demo preview", tab: "demo" });
      if (lead.stage === "demo_ready") rows.push({ label: "Final payment", hint: pay.balanceRemaining > 0 ? `${fmt(pay.balanceRemaining)} balance due.` : "Balance received.", done: pay.balanceRemaining <= 0, cta: "Record payment", tab: "payments" });
      return rows;
    }
    case "final_paid":
      return [{ label: "Fully paid", hint: "Hand the finished project over to the client.", done: true }];
    case "delivered":
      return [{ label: "Delivered", hint: "This project is complete.", done: true }];
    default:
      return [{ label: "Marked as lost", hint: "Use Reopen at the top if the client comes back.", done: false }];
  }
}

/** One calm card: numbered steps, only the step to do now is highlighted, and a step that cannot be done yet is locked and says why. */
export function NextSteps({ lead, files, onGo, onApprove, busy }: { lead: Lead; files: FilesProgress | null; onGo: (tab: TabId) => void; onApprove: () => void; busy: boolean }) {
  const rows = rowsFor(lead, files);
  const open = rows.filter((r) => !r.done).length;
  // The step to do now: the first one that is not done and not locked.
  const current = rows.findIndex((r) => !r.done && !r.locked);
  return (
    <section className="no-print rounded-2xl border border-violet-400/25 bg-gradient-to-br from-violet-600/15 via-[#141927] to-[#10141f] p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-100">What to do next</h3>
        {rows.length > 1 && <span className="text-[11px] text-slate-400">{open === 0 ? "All done" : `${open} of ${rows.length} to do`}</span>}
      </div>
      <ol className="mt-3 divide-y divide-white/[.06]">
        {rows.map((r, i) => {
          const isCurrent = i === current;
          return (
            <li key={r.label} className={cn("flex flex-wrap items-center gap-3 py-3 first:pt-1 last:pb-1", r.locked && "opacity-80")} aria-current={isCurrent ? "step" : undefined}>
              <span className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold", r.done ? "bg-emerald-500/20 text-emerald-300" : r.locked ? "bg-white/[.06] text-slate-500" : isCurrent ? "bg-violet-500 text-white" : "bg-white/10 text-slate-300")}>
                {r.done ? <Check size={14} strokeWidth={3} /> : r.locked ? <Lock size={12} /> : rows.length > 1 ? i + 1 : <Circle size={12} />}
              </span>
              <div className="min-w-0 flex-1">
                <p className={cn("text-sm font-medium", r.done ? "text-slate-400" : r.locked ? "text-slate-400" : "text-slate-100")}>{r.label}</p>
                <p className={cn("mt-0.5 text-xs", r.locked ? "text-amber-200/80" : "text-slate-500")}>{r.locked ?? r.hint}</p>
              </div>
              {r.cta && r.tab && (
                r.locked ? (
                  <button type="button" disabled aria-disabled="true" className="flex cursor-not-allowed items-center gap-1.5 rounded-lg border border-white/[.07] px-3.5 py-2 text-xs font-medium text-slate-600" data-testid="step-locked">
                    <Lock size={12} /> {r.cta}
                  </button>
                ) : (
                  <button type="button" onClick={() => onGo(r.tab!)} className={cn("flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-xs font-semibold transition", isCurrent ? "bg-violet-500 text-white hover:bg-violet-400" : "border border-white/10 text-slate-300 hover:bg-white/5")}>
                    {r.cta} <ArrowRight size={13} />
                  </button>
                )
              )}
            </li>
          );
        })}
      </ol>
      {lead.stage === "quoted" && (
        <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-white/[.06] pt-3">
          <p className="min-w-0 flex-1 text-xs text-slate-500">Client confirmed by phone or message?</p>
          <button type="button" disabled={busy} onClick={onApprove} className="flex items-center gap-1.5 rounded-lg bg-emerald-500/90 px-3.5 py-2 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-50">
            <CheckCircle2 size={14} /> Mark client approved
          </button>
        </div>
      )}
    </section>
  );
}
