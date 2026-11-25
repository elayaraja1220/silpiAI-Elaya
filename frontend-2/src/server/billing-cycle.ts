import { recordAudit } from "@/server/audit";
import { expireCredits } from "@/server/credits";
import { processSubscriptions, type Processed } from "@/server/subscriptions";

/**
 * The periodic billing work: renewals and their invoices, past-due and downgrades, and expiring credits. Both calls are safe to repeat (running them
 * again at the same moment does nothing more), so it does not matter if two copies of the server both run it.
 *
 * It runs by itself in production (once an hour). Elsewhere it is off unless SILPI_AUTO_BILLING=1, so a development server does not move real
 * subscriptions along unexpectedly. Set SILPI_AUTO_BILLING=0 to turn it off in production, for example if a separate scheduler calls
 * POST /api/admin/billing/process instead. The same work can be run at any time from there.
 */
export type CycleResult = { processed: Processed; expired: { expiredUnits: number; buckets: number } };

export function runBillingCycle(now = Date.now()): CycleResult {
  const processed = processSubscriptions({ now });
  const expired = expireCredits({ at: new Date(now).toISOString() });
  const changed = Object.values(processed).some((n) => n > 0) || expired.buckets > 0;
  if (changed) recordAudit({ actor: "system", action: "billing.auto_run", entityType: "billing", entityId: "cycle", detail: { processed, expired } });
  return { processed, expired };
}

export const autoBillingEnabled = (env: Record<string, string | undefined> = process.env): boolean =>
  env.SILPI_AUTO_BILLING === "1" || (env.NODE_ENV === "production" && env.SILPI_AUTO_BILLING !== "0");

/** How often it runs: every hour, or SILPI_BILLING_INTERVAL_MINUTES (5 to 1440). */
export function billingIntervalMs(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.SILPI_BILLING_INTERVAL_MINUTES);
  return (Number.isFinite(n) && n >= 5 && n <= 1440 ? Math.floor(n) : 60) * 60_000;
}

const state = globalThis as unknown as { silpiBillingTimer?: ReturnType<typeof setInterval>; silpiBillingRunning?: boolean };

/** Starts the timer once per server process (a development hot reload does not start a second one). Returns whether a timer is running. */
export function startBillingScheduler(env: Record<string, string | undefined> = process.env): boolean {
  if (!autoBillingEnabled(env)) return false;
  if (state.silpiBillingTimer) return true;
  const tick = () => {
    if (state.silpiBillingRunning) return;
    state.silpiBillingRunning = true;
    try { runBillingCycle(); } catch (e) { console.error("SILPI billing cycle failed:", (e as Error).message); } finally { state.silpiBillingRunning = false; }
  };
  state.silpiBillingTimer = setInterval(tick, billingIntervalMs(env));
  state.silpiBillingTimer.unref?.(); // never keeps the process alive on its own
  setTimeout(tick, 15_000).unref?.(); // and once soon after the start, so a server that was down over a renewal catches up
  return true;
}
export function stopBillingScheduler(): void {
  if (state.silpiBillingTimer) clearInterval(state.silpiBillingTimer);
  state.silpiBillingTimer = undefined;
}
