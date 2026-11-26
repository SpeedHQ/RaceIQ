import { createCompareChatAgent } from "@raceiq/assistant/mastra/agents/compare-chat";
import { resolveLapCorners } from "../../tracks/corner-resolution";
import { generateLapAnalysis } from "../../ai/generate-lap-analysis";

export const compareChatAgent = createCompareChatAgent(resolveLapCorners, generateLapAnalysis);
