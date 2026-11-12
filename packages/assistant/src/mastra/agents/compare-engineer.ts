/**
 * Compare Engineer — structured comparison persona.
 *
 * Used by the inputs-comparison flow (POST /api/laps/:a/compare/:b/inputs-analyse).
 * Different from the per-lap analyst: this persona thinks in terms of A vs B,
 * looks for technique differences, and explains where time is gained or lost.
 */
import { Agent } from "@mastra/core/agent";
import type { ToolSet } from "@mastra/core/tools";
import { compareEngineerPersona } from "@raceiq/assistant/ai/compare-engineer";
import { getModel } from "@raceiq/assistant/ai/model-provider";
import { loadSettings } from "@raceiq/backend-core/runtime/config/settings";
import { getTrackGuideTool, listTrackGuidesTool } from "@raceiq/assistant/mastra/tools/track-guide";
import { compareF1SetupToCatalogTool } from "@raceiq/assistant/mastra/tools/f1-setup-compare";
import { createCornerMetricsTool, type ResolveLapCorners } from "@raceiq/assistant/mastra/tools/corner-metrics";
import { getLapAnalysisTool, getGenerateLapAnalysisTool, type GenerateLapAnalysis } from "@raceiq/assistant/mastra/tools/lap-analysis";
import { getCompareAnalysisTool } from "@raceiq/assistant/mastra/tools/compare-analysis";
import { DEEPSEEK_AGENT_DEFAULTS } from "@raceiq/assistant/mastra/model";
export function createCompareEngineerAgent(resolveLapCorners: ResolveLapCorners, generateLapAnalysis: GenerateLapAnalysis, setupEngineerTools: ToolSet) {
  const getCornerMetricsTool = createCornerMetricsTool(resolveLapCorners);
  const generateLapAnalysisTool = getGenerateLapAnalysisTool(generateLapAnalysis);
  return new Agent({
    defaultOptions: DEEPSEEK_AGENT_DEFAULTS,
  id: "compare-engineer",
  name: "Compare Engineer",
  instructions: () => {
    const s = loadSettings();
    return (
      compareEngineerPersona(s.unit, s.temperatureUnit, s.language, { json: true }) +
      "\nFor each relevant lap, call `get_lap_analysis` first. Only when a lap's retrieval is unavailable, call `generate_lap_analysis` for that lap. If both report unavailable, state that limitation and do not invent findings."
    );
  },
  model: ({ requestContext }) => getModel("analysis", requestContext),
  tools: {
    get_track_guide: getTrackGuideTool,
    list_track_guides: listTrackGuidesTool,
    compare_f1_setup_to_catalog: compareF1SetupToCatalogTool,
    get_corner_metrics: getCornerMetricsTool,
    get_lap_analysis: getLapAnalysisTool,
    get_compare_analysis: getCompareAnalysisTool,
    generate_lap_analysis: generateLapAnalysisTool,
    list_laps: setupEngineerTools.listLapsTool,
    get_lap_detail: setupEngineerTools.getLapDetailTool,
    get_lap_issues: setupEngineerTools.getLapIssuesTool,
    compare_laps: setupEngineerTools.compareLapsTool,
  },
  });
}
