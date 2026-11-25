import { NextRequest, NextResponse } from "next/server";

/**
 * A sliding-window rate limiter, kept in this server process's memory.
 *
 * What it is for: a stuck script or a stolen session must not be able to hammer the AI, the billing writes or the webhook address.
 * What it is not: a shared limit across several server copies (each copy counts alone, so N copies allow N times the limit), or a defence against
 * a large attack, which belongs at the proxy or CDN. A restart forgets everything. Limits are per organization for signed-in routes and per client
 * address for open ones; a client address comes from the proxy's X-Forwarded-For, so behind no proxy it can be forged and must not be the only protection.
 */
export type RateRule = { name: string; limit: number; windowMs: number };

/** The limits in force. Generous for people, tight for scripts. */
export const RATES = {
  aiChat: { name: "ai-chat", limit: 60, windowMs: 60_000 },
  aiEstimate: { name: "ai-estimate", limit: 120, windowMs: 60_000 },
  jobWrite: { name: "job-write", limit: 30, windowMs: 60_000 },
  billingWrite: { name: "billing-write", limit: 20, windowMs: 10 * 60_000 },
  webhook: { name: "webhook", limit: 600, windowMs: 60_000 },
  adminWrite: { name: "admin-write", limit: 240, windowMs: 60_000 },
  adminSignIn: { name: "admin-sign-in", limit: 8, windowMs: 10 * 60_000 },
} as const satisfies Record<string, RateRule>;

const hits = new Map<string, number[]>();
const MAX_KEYS = 20_000;

export type RateResult = { ok: boolean; retryAfterSeconds: number; remaining: number };

/** Counts one request against `rule` for `key`. Refused requests are not counted, so waiting is enough to be let back in. */
export function checkRate(rule: RateRule, key: string, now = Date.now()): RateResult {
  const id = `${rule.name}:${key}`;
  const recent = (hits.get(id) ?? []).filter((t) => now - t < rule.windowMs);
  if (recent.length >= rule.limit) {
    hits.set(id, recent);
    return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((rule.windowMs - (now - recent[0]!)) / 1000)), remaining: 0 };
  }
  recent.push(now);
  hits.set(id, recent);
  if (hits.size > MAX_KEYS) prune(now);
  return { ok: true, retryAfterSeconds: 0, remaining: rule.limit - recent.length };
}

function prune(now: number): void {
  for (const [id, times] of hits) {
    const windowMs = Math.max(...Object.values(RATES).map((r) => r.windowMs));
    if (times.every((t) => now - t >= windowMs)) hits.delete(id);
  }
  if (hits.size > MAX_KEYS) hits.clear(); // a flood of distinct keys: forget everything rather than grow without limit
}
export const resetRates = (): void => hits.clear();

/** The caller's address as the proxy reports it. */
export function clientAddress(request: NextRequest): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip")?.trim() || request.headers.get("host") || "local";
}

/** A 429 answer when `key` is over the limit for `rule`, otherwise null (the request may go on). */
export function rateLimited(rule: RateRule, key: string): NextResponse | null {
  const r = checkRate(rule, key);
  if (r.ok) return null;
  return NextResponse.json(
    { success: false, error: `Too many requests. Try again in ${r.retryAfterSeconds} second${r.retryAfterSeconds === 1 ? "" : "s"}.`, code: "rate-limited", retryAfterSeconds: r.retryAfterSeconds },
    { status: 429, headers: { "Retry-After": String(r.retryAfterSeconds), "Cache-Control": "no-store" } },
  );
}
