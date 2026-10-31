import type { AiUsage } from "@raceiq/shared/integrations/ai/usage";

/** Keep unknown values explicit without losing reported zero measurements. */
export function formatAnalysisUsage(usage: AiUsage, locale: string, unavailable: string): string {
  const input = usage.inputTokens == null ? unavailable : usage.inputTokens.toLocaleString(locale);
  const output = usage.outputTokens == null ? unavailable : usage.outputTokens.toLocaleString(locale);
  const cost = usage.costUsd == null ? unavailable : `$${usage.costUsd.toFixed(4)}`;
  const duration = usage.durationMs == null ? unavailable : `${(usage.durationMs / 1000).toFixed(1)}s`;
  return `${input}↓ ${output}↑ ${cost} ${duration}`;
}
