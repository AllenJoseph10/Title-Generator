// USD per 1M tokens. Verified against Anthropic + OpenAI pricing as of 2026-05.
// Update here when prices change; every cost computation reads from this table.

export const ANTHROPIC_PRICING = {
  'claude-sonnet-4-6': {
    input: 3.0,
    output: 15.0,
    cacheWrite5m: 3.75, // 1.25× input
    cacheRead: 0.3,     // 0.1× input
  },
} as const;

export const OPENAI_PRICING = {
  'text-embedding-3-small': {
    input: 0.02,
  },
} as const;

export type AnthropicModel = keyof typeof ANTHROPIC_PRICING;
export type OpenAIEmbeddingModel = keyof typeof OPENAI_PRICING;

export function anthropicCost(
  model: AnthropicModel,
  usage: { input: number; output: number; cacheRead?: number; cacheWrite?: number },
): number {
  const p = ANTHROPIC_PRICING[model];
  return (
    (usage.input * p.input +
      usage.output * p.output +
      (usage.cacheRead ?? 0) * p.cacheRead +
      (usage.cacheWrite ?? 0) * p.cacheWrite5m) /
    1_000_000
  );
}

export function openaiEmbeddingCost(model: OpenAIEmbeddingModel, tokens: number): number {
  return (tokens * OPENAI_PRICING[model].input) / 1_000_000;
}
