/**
 * A circuit breaker per provider. When a provider keeps failing (rate limits, outages, a bad key), asking it again only makes the customer wait through
 * retries that will fail. After `threshold` failures in a row the circuit OPENS: requests skip that provider (and go to another model of the tier, or are
 * refused at once with nothing held) for `cooldownMs`. Then ONE request is let through as a probe (half-open): success closes the circuit, failure reopens it.
 * Kept in memory per server process; a restart starts closed, which is safe (the first failures reopen it).
 */
export type BreakerState = "closed" | "open" | "half-open";
export type Breaker = {
  /** May a request go to this provider now? In half-open this lets exactly one probe through until its outcome is recorded. */
  allow(provider: string): boolean;
  success(provider: string): void;
  failure(provider: string): void;
  state(provider: string): BreakerState;
  snapshot(): { provider: string; state: BreakerState; failures: number; reopensInMs: number }[];
  reset(provider?: string): void;
};

export function createBreaker(opts: { threshold?: number; cooldownMs?: number; now?: () => number } = {}): Breaker {
  const threshold = opts.threshold ?? 5;
  const cooldownMs = opts.cooldownMs ?? 30_000;
  const clock = opts.now ?? Date.now;
  type Entry = { failures: number; openedAt: number | null; probing: boolean };
  const entries = new Map<string, Entry>();
  const entry = (p: string): Entry => {
    let e = entries.get(p);
    if (!e) { e = { failures: 0, openedAt: null, probing: false }; entries.set(p, e); }
    return e;
  };
  const stateOf = (e: Entry): BreakerState => (e.openedAt === null ? "closed" : clock() - e.openedAt >= cooldownMs ? "half-open" : "open");
  return {
    allow(provider) {
      const e = entry(provider);
      const s = stateOf(e);
      if (s === "closed") return true;
      if (s === "open") return false;
      if (e.probing) return false; // a probe is already out
      e.probing = true;
      return true;
    },
    success(provider) { const e = entry(provider); e.failures = 0; e.openedAt = null; e.probing = false; },
    failure(provider) {
      const e = entry(provider);
      e.probing = false;
      e.failures++;
      if (e.openedAt !== null || e.failures >= threshold) e.openedAt = clock(); // a failed probe, or reaching the threshold, (re)opens it
    },
    state: (provider) => stateOf(entry(provider)),
    snapshot: () => [...entries].map(([provider, e]) => ({ provider, state: stateOf(e), failures: e.failures, reopensInMs: e.openedAt === null ? 0 : Math.max(0, cooldownMs - (clock() - e.openedAt)) })),
    reset(provider) { if (provider) entries.delete(provider); else entries.clear(); },
  };
}

/** The one the gateway uses unless a test passes its own. */
export const providerBreaker: Breaker = createBreaker();
