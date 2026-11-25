import { consumeMastraGeneration } from "@raceiq/assistant/ai/stream-mastra-generation";
import { createGenerateLapAnalysis } from "@raceiq/assistant/ai/generate-lap-analysis";
import { resolveLapCorners } from "../tracks/corner-resolution";
import { runtimeLapAnalystAgent } from "../mastra/agents/lap-analyst";

export type { AnalysisUsage, CornerFraction, LapAnalysisResult, GenerateLapAnalysisDeps } from "@raceiq/assistant/ai/generate-lap-analysis";
export const generateLapAnalysis = createGenerateLapAnalysis(
  resolveLapCorners,
  (prompt, options) => runtimeLapAnalystAgent.generate(prompt, options as never),
  (prompt, options) => consumeMastraGeneration(runtimeLapAnalystAgent.stream(prompt, { ...options, modelSettings: { maxRetries: 0 } } as never), true),
);
