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
import { compareF1SetupToCatalogTool } from "../tools/f1-setup-compare";

const LAP_ANALYST_INSTRUCTIONS = `You are a senior race engineer reviewing a single driver's lap from telemetry data. Your job is to issue a structured verdict on the lap covering pace, handling, problem corners, braking, throttle application, coaching, and setup recommendations.

Be specific and concrete. Cite numbers where helpful. Refer to the driver as "you". Use the units provided in the prompt.

For F1 2025 laps: the driver's current car setup is NOT in the prompt — you MUST fetch it via the \`compare-f1-setup-to-catalog\` tool. The prompt includes a line \`Lap ID: <n>\`; pass that number as \`lapId\`. The tool returns the driver's current setup alongside the top-5 fastest community setups for the same track, pre-diffed per field. Always call this tool before filling in \`tuning[]\` for an F1 lap. Ground every tuning change in that comparison — name the reference team/author, cite the delta, and stay within the field ranges shown. If the tool responds with \`available: false\`, say so and fall back to general F1 heuristics; do NOT claim "no tune data linked" without having called the tool.`;

export const lapAnalystAgent = new Agent({
  id: "lap-analyst",
  name: "Lap Analyst",
  instructions: LAP_ANALYST_INSTRUCTIONS,
  model: () => {
    const s = loadSettings();
    return getMastraModelId(s.aiProvider, s.aiModel);
  },
  tools: { compareF1SetupToCatalogTool },
});
