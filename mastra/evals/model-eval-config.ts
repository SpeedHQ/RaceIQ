export const DEFAULT_MODEL_IDS = ["prism-ml/bonsai-27b", "qwen/qwen3.5-9b"] as const;

export function modelEvalModelIds(
  requested: readonly string[],
  judgeEnabled: boolean,
  judgeModel: string,
): string[] {
  return [...new Set([
    ...(requested.length ? requested : DEFAULT_MODEL_IDS),
    ...(judgeEnabled ? [judgeModel] : []),
  ])];
}
