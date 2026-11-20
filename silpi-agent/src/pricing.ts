/**
 * Anthropic first-party API prices in USD per million tokens.
 * Cache writes use the 5-minute TTL rate (1.25x input).
 * Check https://platform.claude.com/docs/en/about-claude/pricing when prices change.
 */
type Price = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Some models bill every token at a higher rate once one request's prompt passes a size. */
  longPrompt?: { aboveTokens: number; factor: number };
};

const PRICES: Record<string, Price> = {
  "claude-fable-5-2": { input: 8, output: 40, cacheRead: 0.2, cacheWrite: 10 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125, longPrompt: { aboveTokens: 100_000, factor: 5 } },
};

/** Unknown models are priced at the most expensive rate so the budget errs on the safe side. */
const FALLBACK: Price = PRICES["claude-fable-5-2"]!;

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

export function isKnownModel(model: string): boolean {
  return model in PRICES;
}

export function costUsd(model: string, usage: TokenUsage): number {
  const p = PRICES[model] ?? FALLBACK;
  const prompt = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  const factor = p.longPrompt && prompt > p.longPrompt.aboveTokens ? p.longPrompt.factor : 1;
  return (
    factor *
    (usage.inputTokens * p.input +
      usage.outputTokens * p.output +
      usage.cacheReadTokens * p.cacheRead +
      usage.cacheWriteTokens * p.cacheWrite) /
    1_000_000
  );
}
