/**
 * Compare Chat — free-form conversational comparison persona.
 *
 * Used by the compare-flow chat (POST /api/laps/:a/compare/:b/chat).
 * Same persona as compare-engineer but with persistent Mastra memory so the
 * driver can ask follow-up questions across a session.
 */
import { Agent } from "@mastra/core/agent";
import { compareEngineerPersona } from "../../server/ai/compare-engineer";
import { getChatTurnContext } from "../../server/ai/chat-message-context";
import { getChatMemory } from "../../server/ai/chat-agent";
import { getMastraModelId } from "../model";
import { loadSettings } from "../../server/runtime/config/settings";
import { getTrackGuideTool, listTrackGuidesTool } from "../tools/track-guide";
import { compareF1SetupToCatalogTool } from "../tools/f1-setup-compare";
import { getCornerMetricsTool } from "../tools/corner-metrics";
import { TRACK_GUIDE_PROMPT } from "../../shared/ai/prompt-snippets";
export const compareChatAgent = new Agent({
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
  model: () => {
    const s = loadSettings();
    return getMastraModelId(s.chatProvider, s.chatModel, s.localEndpoint);
  },
  tools: {
    getTrackGuideTool,
    listTrackGuidesTool,
    compareF1SetupToCatalogTool,
    getCornerMetricsTool,
    get_lap_analysis: getLapAnalysisTool,
    get_compare_analysis: getCompareAnalysisTool,
    generate_lap_analysis: generateLapAnalysisTool,
  },
  memory: getChatMemory(),
});
