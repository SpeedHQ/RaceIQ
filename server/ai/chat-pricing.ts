type PricePerMillionTokens = {
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
};

const OPENAI_PRICING: Array<{ match: RegExp; price: PricePerMillionTokens }> = [
  { match: /^gpt-4\.1(-|$)/i, price: { inputUsdPerMillion: 2.0, outputUsdPerMillion: 8.0 } },
  { match: /^gpt-4o(-|$)/i, price: { inputUsdPerMillion: 2.5, outputUsdPerMillion: 10.0 } },
  { match: /^gpt-4o-mini(-|$)/i, price: { inputUsdPerMillion: 0.15, outputUsdPerMillion: 0.6 } },
];

const GOOGLE_PRICING: Array<{ match: RegExp; price: PricePerMillionTokens }> = [
  { match: /^gemini-2\.5-pro/i, price: { inputUsdPerMillion: 1.25, outputUsdPerMillion: 10.0 } },
  { match: /^gemini-2\.5-flash/i, price: { inputUsdPerMillion: 0.3, outputUsdPerMillion: 2.5 } },
  { match: /^gemini-2\.0-flash/i, price: { inputUsdPerMillion: 0.1, outputUsdPerMillion: 0.4 } },
  { match: /^gemini-flash-latest/i, price: { inputUsdPerMillion: 0.1, outputUsdPerMillion: 0.4 } },
  { match: /^gemma-/i, price: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 } },
];

function resolvePricing(provider: string | null | undefined, modelId: string | null | undefined): PricePerMillionTokens | null {
  if (!provider || !modelId) return null;
  const table = provider === "openai" ? OPENAI_PRICING : provider === "google" ? GOOGLE_PRICING : null;
  if (!table) return null;
  for (const entry of table) {
    if (entry.match.test(modelId)) return entry.price;
  }
  return null;
}

export function estimateTokenCostUsd(inputTokens: number, outputTokens: number, provider: string | null | undefined, modelId: string | null | undefined): number {
  const pricing = resolvePricing(provider, modelId);
  if (!pricing) return 0;
  const input = (Math.max(0, inputTokens) / 1_000_000) * pricing.inputUsdPerMillion;
  const output = (Math.max(0, outputTokens) / 1_000_000) * pricing.outputUsdPerMillion;
  return Number((input + output).toFixed(6));
}
