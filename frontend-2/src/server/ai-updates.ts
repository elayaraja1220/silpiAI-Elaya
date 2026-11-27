// What has changed in the AI workspace for one organization, newest first (server only): its builds, its credits and a payment that did not go through. It is the AI
// workspace's own list of updates, separate from the Fixed Price projects' updates. Everything is worked out from records that already exist (builds, the credit ledger,
// payments); nothing is stored for it. The words are fixed here, so no internal note or gateway message reaches the person.
import { listLedger } from "@/server/credits";
import { listJobs, type Job } from "@/server/ai/job-store";
import { listPayments } from "@/server/payments/service";

export type AiUpdate = {
  id: string;
  kind: "build" | "credits" | "payment";
  text: string;
  detail: string;
  at: string;
  /** Where the update leads. */
  href: string;
  tone: "action" | "good" | "warn" | "info";
  /** True while the person has something to do (approve a plan, add credits, open an interrupted build): it lights the dot on the bell. */
  needsAction: boolean;
};

/** Credit units (1 credit = 1000), written the way the pages write them. */
const credits = (units: number): string => {
  const c = Math.abs(units) / 1000;
  return Number.isInteger(c) ? c.toLocaleString("en-IN") : c.toLocaleString("en-IN", { maximumFractionDigits: 3 });
};

const PAUSED: Record<NonNullable<Job["pauseReason"]>, { detail: string; needsAction: boolean }> = {
  needs_approval: { detail: "Waiting for your approval of the plan and the budget.", needsAction: true },
  insufficient_credits: { detail: "Paused: not enough credits. Add credits to carry on.", needsAction: true },
  daily_cap: { detail: "Paused: the daily AI limit was reached.", needsAction: false },
  provider: { detail: "Paused: the AI provider is having problems. It can be continued later.", needsAction: false },
  interrupted: { detail: "Paused: it was interrupted. Open it to continue.", needsAction: true },
  error: { detail: "Paused after an error. Open it to see what happened.", needsAction: true },
};

function ofJob(j: Job): AiUpdate {
  const base = { id: `build-${j.id}`, kind: "build" as const, text: j.title, href: `/ai/builder/${j.id}`, at: j.updatedAt };
  switch (j.status) {
    case "awaiting_approval": return { ...base, detail: "Waiting for your approval of the plan and the budget.", tone: "action", needsAction: true };
    case "paused": { const p = PAUSED[j.pauseReason ?? "needs_approval"]; return { ...base, detail: p.detail, tone: p.needsAction ? "action" : "warn", needsAction: p.needsAction }; }
    case "planning": return { ...base, detail: "Writing the plan.", tone: "info", needsAction: false };
    case "running": return { ...base, detail: "Building now.", tone: "info", needsAction: false };
    case "completed": return { ...base, at: j.finishedAt ?? j.updatedAt, detail: "Finished. Open it to see the files.", tone: "good", needsAction: false };
    case "failed": return { ...base, at: j.finishedAt ?? j.updatedAt, detail: "It did not finish. Open it to see why.", tone: "warn", needsAction: false };
    default: return { ...base, at: j.finishedAt ?? j.updatedAt, detail: "Cancelled.", tone: "info", needsAction: false };
  }
}

/** A failed payment is only worth a line for a week; it never lights the bell. */
const PAYMENT_DAYS = 7;

export function aiUpdates(orgId: string, limit = 50, now = Date.now()): AiUpdate[] {
  const out: AiUpdate[] = listJobs(orgId).map(ofJob);

  for (const e of listLedger(orgId, { limit: 60 })) {
    const base = { id: `credits-${e.id}`, kind: "credits" as const, at: e.createdAt, href: "/ai/billing", needsAction: false };
    if (e.kind === "grant" && e.deltaUnits > 0) out.push({ ...base, text: "Credits added", detail: `${credits(e.deltaUnits)} credits from your plan.`, tone: "good" });
    else if (e.kind === "purchase" && e.deltaUnits > 0) out.push({ ...base, text: "Credits bought", detail: `${credits(e.deltaUnits)} credits were added after your payment.`, tone: "good" });
    else if (e.kind === "refund" && e.deltaUnits !== 0) out.push({ ...base, text: "Credits refunded", detail: `${credits(e.deltaUnits)} credits ${e.deltaUnits > 0 ? "were added back" : "were taken off"} for a refund.`, tone: "info" });
    else if (e.kind === "adjust" && e.deltaUnits !== 0) out.push({ ...base, text: "Credits adjusted", detail: `${credits(e.deltaUnits)} credits ${e.deltaUnits > 0 ? "added to" : "taken off"} your balance by the team.`, tone: "info" });
  }

  for (const p of listPayments({ orgId, status: "failed", limit: 10 })) {
    if (now - new Date(p.createdAt).getTime() > PAYMENT_DAYS * 86_400_000) continue;
    out.push({ id: `payment-${p.id}`, kind: "payment", text: "A payment did not go through", detail: "Nothing was added to your account for it. You can try again from the plans page.", at: p.createdAt, href: "/ai/billing", tone: "warn", needsAction: false });
  }

  return out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, Math.min(Math.max(1, Math.trunc(limit)), 100));
}
