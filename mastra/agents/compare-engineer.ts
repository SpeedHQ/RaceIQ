/**
 * Compare Engineer — structured comparison persona.
 *
 * Used by the inputs-comparison flow (POST /api/laps/:a/compare/:b/inputs-analyse).
 * Different from the per-lap analyst: this persona thinks in terms of A vs B,
 * looks for technique differences, and explains where time is gained or lost.
 */
import { Agent } from "@mastra/core/agent";
import { compareEngineerPersona } from "../../server/ai/compare-engineer";
import { getModel } from "../../server/ai/model-provider";
import { loadSettings } from "../../server/settings";

export const compareEngineerAgent = new Agent({
  id: "compare-engineer",
  name: "Compare Engineer",
  instructions: () => {
    const s = loadSettings();
    // json: true — this agent's output is parsed against InputsCompareSchema.
    return compareEngineerPersona(s.unit, s.temperatureUnit, s.language, { json: true });
  },
  model: ({ requestContext }) => getModel("analysis", requestContext),
});
