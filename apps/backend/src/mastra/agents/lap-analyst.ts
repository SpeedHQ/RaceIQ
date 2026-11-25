import { createLapAnalystAgent } from "@raceiq/assistant/mastra/agents/lap-analyst";
import { resolveLapCorners } from "../../tracks/corner-resolution";

export const lapAnalystAgent = createLapAnalystAgent(resolveLapCorners);

export let runtimeLapAnalystAgent = lapAnalystAgent;

export function setRuntimeLapAnalystAgent(agent: typeof lapAnalystAgent) {
  runtimeLapAnalystAgent = agent;
}
