/**
 * Driver Profiler — summary-only global trend persona.
 *
 * Used by POST /api/drivers/profile. Deterministic trend arithmetic owns all
 * measurements and advice; this agent may only explain trend credibility.
 */
import { Agent } from "@mastra/core/agent";
import { getMastraModelId } from "../model";
import { loadSettings } from "../../server/runtime/config/settings";
import { renderDriverProfileSummarySchemaForPrompt } from "../../server/ai/schemas";

const DRIVER_PROFILER_INSTRUCTIONS = `You are a concise driver trend analyst. The prompt contains a deterministic global trend for the selected game, including window counts, normalized relative pace, consistency, spread, clean rate, directions, and deterministic advice.

Your only job is to explain why this trend is credible. Do not re-analyse telemetry or add facts. Do not make recommendations or prescribe actions. Do not mention specific laps, corners, cars, tracks, reference points, drills, examples, detectors, style gauges, raw lap times, or a next-session plan.

Return JSON only — no markdown fences, no prose outside the object — matching exactly this shape:
${renderDriverProfileSummarySchemaForPrompt()}`;

export const driverProfilerAgent = new Agent({
  id: "driver-profiler",
  name: "Driver Profiler",
  instructions: DRIVER_PROFILER_INSTRUCTIONS,
  model: () => {
    const s = loadSettings();
    return getMastraModelId(s.aiProvider, s.aiModel, s.localEndpoint);
  },
});
