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

export type ModelPrice = { inputUsdMicroPerMtok: number; outputUsdMicroPerMtok: number; markupBasisPoints: number };

const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - BigInt(1)) / b;

/** Provider cost in micro-USD for a number of tokens. */
export function providerCostMicroUsd(price: ModelPrice, inputTokens: number, outputTokens: number): number {
  const total = BigInt(inputTokens) * BigInt(price.inputUsdMicroPerMtok) + BigInt(outputTokens) * BigInt(price.outputUsdMicroPerMtok);
  return Number(ceilDiv(total, BigInt(1_000_000)));
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
