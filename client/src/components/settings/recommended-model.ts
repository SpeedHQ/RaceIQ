/** Claude model suggested for RaceIQ: fast and token-efficient. */
export const RECOMMENDED_CLAUDE_MODEL = "claude-haiku-5-5";

/** True for the recommended model and its dated snapshots (e.g. claude-haiku-5-5-20260901). */
export function isRecommendedModel(modelId: string): boolean {
  return modelId === RECOMMENDED_CLAUDE_MODEL || modelId.startsWith(`${RECOMMENDED_CLAUDE_MODEL}-`);
}

/** Move recommended models to the top; the rest keep the provider's order. */
export function recommendedFirst<T extends { id: string }>(models: T[]): T[] {
  return [...models.filter((model) => isRecommendedModel(model.id)), ...models.filter((model) => !isRecommendedModel(model.id))];
}

/** Model to preselect after switching provider: the recommended Claude model, otherwise none. */
export function defaultModelForProvider(provider: string): string {
  return provider === "anthropic" ? RECOMMENDED_CLAUDE_MODEL : "";
}

/** Shown for Claude until (or if) the live model list loads, so selection never waits on the fetch. */
export const FALLBACK_CLAUDE_MODELS: { id: string; name: string }[] = [
  { id: "claude-haiku-5-5", name: "Claude Haiku 5.5" },
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
  { id: "claude-opus-5-5", name: "Claude Opus 5.5" },
];

export function modelsOrFallback<T extends { id: string; name: string; contextLength?: number }>(provider: string, models: T[]): (T | { id: string; name: string; contextLength?: number })[] {
  return models.length === 0 && provider === "anthropic" ? FALLBACK_CLAUDE_MODELS : models;
}
