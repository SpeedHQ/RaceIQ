/** Null means unreported. Zero is a reported value, never a missing-data sentinel. */
export interface AiUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  durationMs: number | null;
  model: string;
}
