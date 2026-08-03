/**
 * Compare Chat — free-form conversational comparison persona.
 *
 * Used by the compare-flow chat (POST /api/laps/:a/compare/:b/chat).
 * Same persona as compare-engineer but with persistent Mastra memory so the
 * driver can ask follow-up questions across a session.
 */
import { Agent } from "@mastra/core/agent";
import { compareEngineerPersona } from "../../server/ai/compare-engineer";
import { getChatMemory } from "../../server/ai/chat-agent";
import { getMastraModelId } from "../model";
import { loadSettings } from "../../server/settings";
import { getTrackGuideTool, listTrackGuidesTool } from "../tools/track-guide";
import { compareF1SetupToCatalogTool } from "../tools/f1-setup-compare";
import { getCornerMetricsTool } from "../tools/corner-metrics";
import { getLapAnalysisTool, generateLapAnalysisTool } from "../tools/lap-analysis";
import { TRACK_GUIDE_PROMPT } from "../../shared/prompt-snippets";

export const compareChatAgent = new Agent({
  id: "compare-chat",
  name: "Compare Chat",
  instructions: () => {
    const s = loadSettings();
    return compareEngineerPersona(s.unit, s.temperatureUnit, s.language) + TRACK_GUIDE_PROMPT +
      "\nFor each lap, call `get_lap_analysis` first. Only when a lap's retrieval is unavailable, call `generate_lap_analysis` for that lap. If both tools fail for either lap, explicitly state that lap's analysis could not be retrieved or generated and do not invent lap-specific findings.";
  },
  model: () => {
    const s = loadSettings();
    return getMastraModelId(s.chatProvider, s.chatModel, s.localEndpoint);
  },
  tools: { getTrackGuideTool, listTrackGuidesTool, compareF1SetupToCatalogTool, getCornerMetricsTool, getLapAnalysisTool, generate_lap_analysis: generateLapAnalysisTool },
  memory: getChatMemory(),
});
