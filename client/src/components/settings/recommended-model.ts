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
