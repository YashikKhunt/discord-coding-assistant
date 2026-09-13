export interface ModelPrice {
  /** USD per million tokens. */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface TokenUsage {
  /** Uncached input tokens. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

const anthropic = (input: number, output: number): ModelPrice => ({
  input,
  output,
  // Anthropic prompt caching: reads ~0.1x input, 5-minute cache writes ~1.25x input.
  cacheRead: input * 0.1,
  cacheWrite: input * 1.25,
});

/** Anthropic first-party list prices (USD / MTok). Keep in sync with the pricing page. */
export const PRICES: Record<string, ModelPrice> = {
  "anthropic:claude-opus-5": anthropic(5, 25),
  "anthropic:claude-sonnet-5": anthropic(2, 10),
  "anthropic:claude-haiku-4-5": anthropic(1, 5),
};

/**
 * Used when a model has no known price and the provider reports no cost. Deliberately high so
 * per-job and monthly budgets still stop runaway spend instead of treating it as free.
 */
export const UNKNOWN_MODEL_PRICE: ModelPrice = {
  input: 15,
  output: 75,
  cacheRead: 15,
  cacheWrite: 15,
};

export function priceFor(modelSpec: string): { price: ModelPrice; known: boolean } {
  const price = PRICES[modelSpec];
  return price ? { price, known: true } : { price: UNKNOWN_MODEL_PRICE, known: false };
}

export function costUsd(price: ModelPrice, usage: TokenUsage): number {
  return (
    (usage.inputTokens * price.input +
      usage.outputTokens * price.output +
      usage.cacheReadTokens * price.cacheRead +
      usage.cacheWriteTokens * price.cacheWrite) /
    1_000_000
  );
}
