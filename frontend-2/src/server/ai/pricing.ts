/**
 * AI Gateway cost maths (pure, no database). Everything is whole numbers, so a cost is exact and repeatable.
 *
 *   provider cost  = ceil((inputTokens x inputPrice + outputTokens x outputPrice) / 1,000,000)     in micro-USD
 *   credits charged = ceil(provider cost x model markup x units-per-USD)                           in credit units
 *
 * Prices are micro-USD per million tokens. Markup is basis points (10000 = x1). Units per USD is the one conversion
 * setting (1 credit = 1000 units). Rounding is always UP, so a tiny call still costs at least one unit and the
 * customer is never undercharged by rounding.
 */

/**
 * A model's price at one moment. Cache prices are optional: a provider that does not price cached tokens separately leaves them out,
 * and then those tokens are billed at the ordinary input price.
 */
export type ModelPrice = { inputUsdMicroPerMtok: number; outputUsdMicroPerMtok: number; markupBasisPoints: number; cacheReadUsdMicroPerMtok?: number | null; cacheWriteUsdMicroPerMtok?: number | null };

/** What a provider reports it used. Cached tokens are counted APART from input tokens (as the Anthropic API reports them). */
export type Usage = { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; otherChargesMicroUsd?: number };

const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - BigInt(1)) / b;

/** Provider cost in micro-USD for a number of tokens. */
export function providerCostMicroUsd(price: ModelPrice, inputTokens: number, outputTokens: number): number {
  const total = BigInt(inputTokens) * BigInt(price.inputUsdMicroPerMtok) + BigInt(outputTokens) * BigInt(price.outputUsdMicroPerMtok);
  return Number(ceilDiv(total, BigInt(1_000_000)));
}

/** Provider cost in micro-USD for everything a request used: input, output, cached tokens, and any other billable charge (a tool call, for example). */
export function usageCostMicroUsd(price: ModelPrice, usage: Usage): number {
  const whole = (n: number | undefined, what: string) => {
    const v = n ?? 0;
    if (!Number.isSafeInteger(v) || v < 0) throw new Error(`${what} must be a whole number of zero or more.`);
    return BigInt(v);
  };
  const cacheRead = BigInt(price.cacheReadUsdMicroPerMtok ?? price.inputUsdMicroPerMtok);
  const cacheWrite = BigInt(price.cacheWriteUsdMicroPerMtok ?? price.inputUsdMicroPerMtok);
  const total =
    whole(usage.inputTokens, "inputTokens") * BigInt(price.inputUsdMicroPerMtok) +
    whole(usage.outputTokens, "outputTokens") * BigInt(price.outputUsdMicroPerMtok) +
    whole(usage.cacheReadTokens, "cacheReadTokens") * cacheRead +
    whole(usage.cacheWriteTokens, "cacheWriteTokens") * cacheWrite;
  return Number(ceilDiv(total, BigInt(1_000_000)) + whole(usage.otherChargesMicroUsd, "otherChargesMicroUsd"));
}

/** The dearest an input token could be billed at, so a worst-case hold never undercounts a request that turns out to write the cache. */
export const worstInputPrice = (price: ModelPrice): number => Math.max(price.inputUsdMicroPerMtok, price.cacheWriteUsdMicroPerMtok ?? 0, price.cacheReadUsdMicroPerMtok ?? 0);

/** How a customer charge becomes whole credit units. Rounding is "up" (the default: never undercharge by rounding) or "nearest". */
export type MeteringPolicy = { rounding: "up" | "nearest"; minChargeUnits: number };
export const DEFAULT_POLICY: MeteringPolicy = { rounding: "up", minChargeUnits: 0 };

/**
 * Customer charge in credit units: provider cost x markup x units per dollar, rounded by the policy, never below the minimum charge.
 * A request that cost the provider nothing (the free demo model) is never charged, whatever the minimum.
 */
export function chargeUnits(costMicroUsd: number, markupBasisPoints: number, unitsPerUsd: number, policy: MeteringPolicy = DEFAULT_POLICY): { units: number; minApplied: boolean } {
  if (costMicroUsd <= 0) return { units: 0, minApplied: false };
  const raw = BigInt(costMicroUsd) * BigInt(markupBasisPoints) * BigInt(unitsPerUsd);
  const den = BigInt(10_000) * BigInt(1_000_000);
  let units = Number(policy.rounding === "nearest" ? (raw + den / BigInt(2)) / den : ceilDiv(raw, den));
  let minApplied = false;
  if (units < policy.minChargeUnits) { units = policy.minChargeUnits; minApplied = true; }
  return { units, minApplied };
}

/** Credit units for a provider cost. Zero cost is zero units (the free demo model); any real cost is at least one unit. */
export function unitsForCost(costMicroUsd: number, markupBasisPoints: number, unitsPerUsd: number): number {
  if (costMicroUsd <= 0) return 0;
  return Number(ceilDiv(BigInt(costMicroUsd) * BigInt(markupBasisPoints) * BigInt(unitsPerUsd), BigInt(10_000) * BigInt(1_000_000)));
}

export function unitsForTokens(price: ModelPrice, unitsPerUsd: number, inputTokens: number, outputTokens: number): number {
  return unitsForCost(providerCostMicroUsd(price, inputTokens, outputTokens), price.markupBasisPoints, unitsPerUsd);
}

/**
 * A deliberately pessimistic token estimate: 1 token per 3 characters (real English text is nearer 1 per 4, so this
 * holds back a little more than needed and the difference is returned when the real cost is settled).
 */
export const estimateTokens = (chars: number): number => Math.ceil(Math.max(0, chars) / 3);

/** Credits a million tokens cost, for showing a price list: units per 1,000 tokens as a decimal credit figure. */
export function creditsPerThousandTokens(price: ModelPrice, unitsPerUsd: number, direction: "input" | "output"): number {
  const perMtok = direction === "input" ? price.inputUsdMicroPerMtok : price.outputUsdMicroPerMtok;
  // micro-USD per 1,000 tokens = perMtok / 1000 ; units = that x markup x unitsPerUsd / 1e6 ; credits = units / 1000
  return (perMtok / 1000) * (price.markupBasisPoints / 10_000) * unitsPerUsd / 1_000_000 / 1000;
}
