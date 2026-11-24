import { consumeMastraGeneration } from "@raceiq/assistant/ai/stream-mastra-generation";
import { createConsultLapAnalystForSession } from "@raceiq/assistant/ai/consult-lap-analyst";
import { resolveLapCorners, resolveLapSegments } from "../tracks/corner-resolution";
import { lapAnalystAgent } from "../mastra/agents/lap-analyst";
import { loadRepresentativeLap } from "../experiments/representative-lap";

export const consultLapAnalystForSession = createConsultLapAnalystForSession({
  resolveLapCorners,
  resolveLapSegments,
  loadRepresentativeLap,
  generate: (prompt, options) => options.requestContext
    ? consumeMastraGeneration(lapAnalystAgent.stream(prompt, { ...options, modelSettings: { maxRetries: 0 } }))
    : lapAnalystAgent.generate(prompt, options),
});
