import { createConsultLapAnalystForSession } from "@raceiq/assistant/ai/consult-lap-analyst";
import { resolveLapCorners, resolveLapSegments } from "../tracks/corner-resolution";
import { lapAnalystAgent } from "../mastra/agents/lap-analyst";
import { loadRepresentativeLap } from "../experiments/representative-lap";

export const consultLapAnalystForSession = createConsultLapAnalystForSession({
  resolveLapCorners,
  resolveLapSegments,
  loadRepresentativeLap,
  generate: (prompt, options) => lapAnalystAgent.generate(prompt, options),
});
