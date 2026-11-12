/**
 * Compare Chat — free-form conversational comparison persona.
 *
 * Used by the compare-flow chat (POST /api/laps/:a/compare/:b/chat).
 * Same persona as compare-engineer but with persistent Mastra memory so the
 * driver can ask follow-up questions across a session.
 */
import { Agent } from "@mastra/core/agent";
import { compareEngineerPersona } from "@raceiq/assistant/ai/compare-engineer";
import { getChatTurnContext } from "@raceiq/assistant/ai/chat-message-context";
import { getChatMemory } from "@raceiq/assistant/ai/chat-agent";
import { getModel } from "@raceiq/assistant/ai/model-provider";
import { loadSettings } from "@raceiq/backend-core/runtime/config/settings";
import { getTrackGuideTool, listTrackGuidesTool } from "@raceiq/assistant/mastra/tools/track-guide";
import { compareF1SetupToCatalogTool } from "@raceiq/assistant/mastra/tools/f1-setup-compare";
import { createCornerMetricsTool, type ResolveLapCorners } from "@raceiq/assistant/mastra/tools/corner-metrics";
import { getLapAnalysisTool, getGenerateLapAnalysisTool, type GenerateLapAnalysis } from "@raceiq/assistant/mastra/tools/lap-analysis";
import { getCompareAnalysisTool } from "@raceiq/assistant/mastra/tools/compare-analysis";
import { TRACK_GUIDE_PROMPT } from "@raceiq/shared/integrations/ai/prompt-snippets";
import { DEEPSEEK_AGENT_DEFAULTS } from "@raceiq/assistant/mastra/model";
export function createCompareChatAgent(resolveLapCorners: ResolveLapCorners, generateLapAnalysis: GenerateLapAnalysis) {
  const getCornerMetricsTool = createCornerMetricsTool(resolveLapCorners);
  const generateLapAnalysisTool = getGenerateLapAnalysisTool(generateLapAnalysis);
  return new Agent({
    defaultOptions: DEEPSEEK_AGENT_DEFAULTS,
  id: "compare-chat",
  name: "Compare Chat",
  instructions: ({ requestContext }) => {
    const s = loadSettings();
    const context = getChatTurnContext(requestContext);
    return (
      compareEngineerPersona(s.unit, s.temperatureUnit, s.language) +
      TRACK_GUIDE_PROMPT +
      "\nThe server provides lap IDs and authoritative per-segment timing deltas in context. Use those values; never ask the driver for IDs or recalculate timing deltas." +
      "\nFor lap-specific technique explanations, call the relevant lap/compare analysis tools before answering. If a tool reports unavailable, state that limitation and do not invent findings." +
      (context ? `\n\n${context}` : "")
    );
  },
  model: ({ requestContext }) => getModel("chat", requestContext),
  tools: {
    get_track_guide: getTrackGuideTool,
    list_track_guides: listTrackGuidesTool,
    compare_f1_setup_to_catalog: compareF1SetupToCatalogTool,
    get_corner_metrics: getCornerMetricsTool,
    get_lap_analysis: getLapAnalysisTool,
    get_compare_analysis: getCompareAnalysisTool,
    generate_lap_analysis: generateLapAnalysisTool,
  },
  memory: getChatMemory(),
  });
}
