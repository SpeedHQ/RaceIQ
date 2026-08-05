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
import { getTrackGuideTool, listTrackGuidesTool } from "../tools/track-guide";
import { compareF1SetupToCatalogTool } from "../tools/f1-setup-compare";
import { getCornerMetricsTool } from "../tools/corner-metrics";
import {
  getLapAnalysisTool,
  generateLapAnalysisTool,
} from "../tools/lap-analysis";
import { setupEngineerTools } from "../tools/setup-engineer";

export const compareEngineerAgent = new Agent({
  id: "compare-engineer",
  name: "Compare Engineer",
  instructions: () => {
    const s = loadSettings();
    // json: true — this agent's output is parsed against InputsCompareSchema.
    return (
      compareEngineerPersona(s.unit, s.temperatureUnit, s.language, {
        json: true,
      }) +
      "\nFor each relevant lap, call `get_lap_analysis` first. Only when a lap's retrieval is unavailable, call `generate_lap_analysis` for that lap. If both tools fail for either lap, explicitly state that lap's analysis could not be retrieved or generated and do not invent lap-specific findings."
    );
  },
  model: () => {
    const s = loadSettings();
    return getMastraModelId(s.aiProvider, s.aiModel, s.localEndpoint);
  },
  tools: {
    get_track_guide: getTrackGuideTool,
    list_track_guides: listTrackGuidesTool,
    compare_f1_setup_to_catalog: compareF1SetupToCatalogTool,
    get_corner_metrics: getCornerMetricsTool,
    get_lap_analysis: getLapAnalysisTool,
    generate_lap_analysis: generateLapAnalysisTool,
    list_laps: setupEngineerTools.listLapsTool,
    get_lap_detail: setupEngineerTools.getLapDetailTool,
    get_lap_issues: setupEngineerTools.getLapIssuesTool,
    compare_laps: setupEngineerTools.compareLapsTool,
  },
});
