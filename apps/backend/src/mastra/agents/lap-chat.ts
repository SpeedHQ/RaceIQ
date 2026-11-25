import { createLapChatAgent } from "@raceiq/assistant/mastra/agents/lap-chat";
import { resolveLapCorners } from "../../tracks/corner-resolution";
import { generateLapAnalysis } from "../../ai/generate-lap-analysis";

export { buildLapChatInstructions, requiresCornerMetricsLookup, requiresLapInsightsLookup, lapChatPrepareStep, lapChatGroundingProcessor } from "@raceiq/assistant/mastra/agents/lap-chat";
export const lapChatAgent = createLapChatAgent(resolveLapCorners, generateLapAnalysis);
