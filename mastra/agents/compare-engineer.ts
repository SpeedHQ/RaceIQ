/**
 * Compare Engineer — structured comparison persona.
 *
 * Used by the inputs-comparison flow (POST /api/laps/:a/compare/:b/inputs-analyse).
 * Different from the per-lap analyst: this persona thinks in terms of A vs B,
 * looks for technique differences, and explains where time is gained or lost.
 */
import { Agent, type AgentExecutionOptions } from "@mastra/core/agent";
import { providerConfigFromRequestContext } from "../model";
import { compareEngineerPersona } from "../../server/ai/compare-engineer";
import { buildCompareEngineerExecutionOptions } from "../../server/ai/analysis-agent-options";
import { loadSettings } from "../../server/runtime/config/settings";
import { getTrackGuideTool, listTrackGuidesTool } from "../tools/track-guide";
import { compareF1SetupToCatalogTool } from "../tools/f1-setup-compare";
import { getCornerMetricsTool } from "../tools/corner-metrics";
import { getLapAnalysisTool, generateLapAnalysisTool } from "../tools/lap-analysis";
import { getCompareAnalysisTool } from "../tools/compare-analysis";
import { setupEngineerTools } from "../tools/setup-engineer";
import { getModel } from "../../server/ai/model-provider";
export const compareEngineerAgent = new Agent({
  id: "compare-engineer",
  name: "Compare Engineer",
  model: ({ requestContext }) => getModel("analysis", requestContext),
  instructions: () => {
    const s = loadSettings();
    return (
      compareEngineerPersona(s.unit, s.temperatureUnit, s.language, { json: true }) +
      "\nFor each relevant lap, call `get_lap_analysis` first. Only when a lap's retrieval is unavailable, call `generate_lap_analysis` for that lap. If both report unavailable, state that limitation and do not invent findings."
    );
  },
  defaultOptions: ({ requestContext }): AgentExecutionOptions<undefined> => {
    const config = providerConfigFromRequestContext(requestContext);
    return (config
      ? buildCompareEngineerExecutionOptions(config)
      : {}) as unknown as AgentExecutionOptions<undefined>;
  },
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
