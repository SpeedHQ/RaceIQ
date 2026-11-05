import type { AiUsage } from "@raceiq/shared/integrations/ai/usage";

/** Normalize reported counters only; never infer token counts or monetary cost. */
export function normalizeAiUsage(value: unknown, model: string, measuredDurationMs?: number): AiUsage {
  const raw = value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const reported = (keys: string[], integer = false): number | null => {
    for (const key of keys) {
      const metric = raw[key];
      if (typeof metric === "number" && Number.isFinite(metric) && metric >= 0 && (!integer || Number.isSafeInteger(metric))) return metric;
    }
    return null;
  };
  return {
    inputTokens: reported(["inputTokens", "promptTokens"], true),
    outputTokens: reported(["outputTokens", "completionTokens"], true),
    costUsd: reported(["costUsd"]),
    durationMs: reported(["durationMs"]) ?? (typeof measuredDurationMs === "number" && Number.isFinite(measuredDurationMs) && measuredDurationMs >= 0 ? measuredDurationMs : null),
    model,
  };
}
