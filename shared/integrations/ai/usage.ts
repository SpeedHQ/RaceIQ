/** Null means unreported. Zero is a reported value, never a missing-data sentinel. */
export interface AiUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  durationMs: number | null;
  model: string;
}

/** Runtime-reported generation measurements, separate from billable API usage. */
export interface AiGenerationDiagnostics {
  provider: string;
  model: string;
  runtimeVersion: string;
  status: "completed";
  latencyMs: number;
  firstContentMs: number | null;
  budget: { requestedOutputTokens: number | null; effectiveOutputTokens: number | null; supported: boolean };
  usage: { inputTokens: number | null; cachedInputTokens: number | null; outputTokens: number | null; reasoningOutputTokens: number | null; costUsd: number | null };
}
