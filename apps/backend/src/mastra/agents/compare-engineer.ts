import { createCompareEngineerAgent } from "@raceiq/assistant/mastra/agents/compare-engineer";
import { resolveLapCorners } from "../../tracks/corner-resolution";
import { generateLapAnalysis } from "../../ai/generate-lap-analysis";
import { setupEngineerTools } from "../tools/setup-engineer";

export const compareEngineerAgent = createCompareEngineerAgent(resolveLapCorners, generateLapAnalysis, setupEngineerTools);
