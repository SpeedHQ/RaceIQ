import { createGenerateLapAnalysis } from "@raceiq/assistant/ai/generate-lap-analysis";
import { resolveLapCorners } from "../tracks/corner-resolution";
import { runtimeLapAnalystAgent } from "../mastra/agents/lap-analyst";

export type { AnalysisUsage, CornerFraction, LapAnalysisResult, GenerateLapAnalysisDeps } from "@raceiq/assistant/ai/generate-lap-analysis";
export const generateLapAnalysis = createGenerateLapAnalysis(
  resolveLapCorners,
  (prompt, options) => runtimeLapAnalystAgent.generate(prompt, options as never),
);
