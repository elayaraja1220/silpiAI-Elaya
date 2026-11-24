import { paymentStatus } from "./payment-status";
import { deferredTexts, estimateStatus } from "./clarifications";
import type { PublicRunningServices } from "./running-services";
import type { Lead, Quotation, RateCard, Requirement } from "./types";

/**
 * What the client sees through their link: the quotation and proposals,
 * never internal notes (AI assumptions, questions, references, history).
 */
export type ClientView = {
  number: string;
  stage: Lead["stage"];
  open: boolean;
  expired: boolean;
  quotation: Quotation;
  requirement: Pick<Requirement, "title" | "summary" | "pages">;
  response?: Lead["clientResponse"];
  /** True while open questions or proposals remain: the price is a preliminary estimate and cannot be approved yet. */
  preliminary?: boolean;
  /** Items deliberately left out of the price: the client must be told, and confirm they understand, before approving. */
  deferred?: string[];
  /** Running services the admin approved for the client (already reduced to client-safe fields). Absent when none. */
  running?: PublicRunningServices;
  /** A private preview of the website the team made for them (only when it can be opened from outside the team's computer). */
  demo?: { url: string; expiresAt: string; protected: boolean };
  /** Shown once approved: what to pay and how. */
  payment?: { advanceDue: number; advancePaid: number; advanceRemaining: number; upiId: string; bankDetails: string; payee: string; reference: string };
};

/** `business`: current business details, so a UPI ID added later still shows. */
export function clientView(lead: Lead, business: RateCard["business"], running?: PublicRunningServices | null, demo?: ClientView["demo"] | null): ClientView | null {
  const q = lead.quotation;
  if (!q) return null;
  const scope = q.requirement ?? lead.requirement;
  const { insights: _i, references: _r, mustHave: _m, ...publicScope } = scope;
  const expired = new Date(q.validUntil).getTime() < Date.now();
  return {
    number: q.number,
    stage: lead.stage,
    open: lead.stage === "quoted" && !expired,
    expired,
    // Team-only notes (e.g. which hourly rate would fit the budget) stay out of the client view.
    quotation: { ...q, budgetCheck: undefined, requirement: publicScope as Requirement, proposals: q.proposals?.map(({ budgetNote: _n, ...p }) => p) },
    requirement: { title: scope.title, summary: scope.summary, pages: scope.pages },
    response: lead.clientResponse,
    ...(estimateStatus(lead.requirement.insights?.tracker ?? []).level === "preliminary" ? { preliminary: true } : {}),
    ...(deferredTexts(lead.requirement.insights?.tracker ?? []).length ? { deferred: deferredTexts(lead.requirement.insights?.tracker ?? []) } : {}),
    ...(running && running.services.length ? { running } : {}),
    ...(demo ? { demo } : {}),
    payment: ["approved", "advance_paid", "in_development", "testing", "demo_ready"].includes(lead.stage)
      ? (() => {
          const s = paymentStatus(q, lead.payments);
          return { advanceDue: s.advanceDue, advancePaid: s.advancePaid, advanceRemaining: s.advanceRemaining, upiId: business.upiId ?? "", bankDetails: business.bankDetails ?? "", payee: business.name, reference: q.number };
        })()
      : undefined,
  };
}

/** Small per-link limit on responses so a leaked link cannot be spammed. */
const attempts = new Map<string, number[]>();
export function allowResponse(token: string, limit = 10, windowMs = 60 * 60 * 1000): boolean {
  const recent = (attempts.get(token) ?? []).filter((t) => Date.now() - t < windowMs);
  if (recent.length >= limit) return false;
  attempts.set(token, [...recent, Date.now()]);
  return true;
}
