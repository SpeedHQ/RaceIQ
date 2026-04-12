/**
 * Lap Analyst — single-lap structured analysis persona.
 *
 * Used by the per-lap analyse flow (POST /api/laps/:id/analyse). Issues a
 * structured verdict on one lap (pace, handling, problem corners, braking,
 * throttle, coaching, setup). Distinct from compare-engineer, which thinks
 * across two laps.
 */
import { Agent } from "@mastra/core/agent";
import { getMastraModelId } from "../model";
import { loadSettings } from "../../server/settings";

const LAP_ANALYST_INSTRUCTIONS = `You are a senior race engineer reviewing a single driver's lap from telemetry data. Your job is to issue a structured verdict on the lap covering pace, handling, problem corners, braking, throttle application, coaching, and setup recommendations.

Be specific and concrete. Cite numbers where helpful. Refer to the driver as "you". Use the units provided in the prompt.`;

export const lapAnalystAgent = new Agent({
  id: "lap-analyst",
  name: "Lap Analyst",
  instructions: LAP_ANALYST_INSTRUCTIONS,
  model: () => {
    const s = loadSettings();
    return getMastraModelId(s.aiProvider, s.aiModel);
  },
});
