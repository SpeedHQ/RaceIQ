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
import { getLapAnalysisTool } from "../tools/lap-analysis";
import { setupEngineerTools } from "../tools/setup-engineer";

export const compareEngineerAgent = new Agent({
  id: "compare-engineer",
  name: "Compare Engineer",
  instructions: () => {
    const s = loadSettings();
    // json: true — this agent's output is parsed against InputsCompareSchema.
    return compareEngineerPersona(s.unit, s.temperatureUnit, s.language, { json: true }) +
      "\nBefore producing lap-specific recommendations, call `get_lap_analysis` for each relevant lap ID. If unavailable, state the limitation and avoid unsupported findings.";
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
    list_laps: setupEngineerTools.listLapsTool,
    get_lap_detail: setupEngineerTools.getLapDetailTool,
    get_lap_issues: setupEngineerTools.getLapIssuesTool,
    compare_laps: setupEngineerTools.compareLapsTool,
  },
});
