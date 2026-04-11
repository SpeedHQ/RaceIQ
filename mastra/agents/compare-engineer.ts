/**
 * Compare Engineer — structured comparison persona.
 *
 * Used by the inputs-comparison flow (POST /api/laps/:a/compare/:b/inputs-analyse).
 * Different from the per-lap analyst: this persona thinks in terms of A vs B,
 * looks for technique differences, and explains where time is gained or lost.
 */
import { Agent } from "@mastra/core/agent";
import { compareEngineerPersona } from "../../server/ai/compare-engineer";
import { getMastraModelId } from "../model";
import { loadSettings } from "../../server/settings";

export const compareEngineerAgent = new Agent({
  id: "compare-engineer",
  name: "Compare Engineer",
  instructions: compareEngineerPersona("metric"),
  model: () => {
    const s = loadSettings();
    return getMastraModelId(s.aiProvider, s.aiModel);
  },
});
