import { getGenerateLapAnalysisTool } from "@raceiq/assistant/mastra/tools/lap-analysis";
import { generateLapAnalysis } from "../../ai/generate-lap-analysis";

export { getLapAnalysisTool, getLapAnalysisToolFor, getGenerateLapAnalysisTool, parseCachedLapAnalysis } from "@raceiq/assistant/mastra/tools/lap-analysis";
export type { ParsedLapAnalysis } from "@raceiq/assistant/mastra/tools/lap-analysis";

export const generateLapAnalysisTool = getGenerateLapAnalysisTool(generateLapAnalysis);
