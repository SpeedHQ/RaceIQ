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
import { getLapAnalysisTool } from "../tools/lap-analysis";
import { TRACK_GUIDE_PROMPT } from "../../shared/prompt-snippets";

export const compareChatAgent = new Agent({
  id: "compare-chat",
  name: "Compare Chat",
  instructions: () => {
    const s = loadSettings();
    return compareEngineerPersona(s.unit, s.temperatureUnit, s.language) + TRACK_GUIDE_PROMPT +
      "\nBefore lap-specific diagnosis or recommendations, call `get_lap_analysis` for both lap IDs. If either lookup is unavailable, state that limitation and do not invent findings.";
  },
  model: () => {
    const s = loadSettings();
    return getMastraModelId(s.chatProvider, s.chatModel, s.localEndpoint);
  },
  tools: { getTrackGuideTool, listTrackGuidesTool, compareF1SetupToCatalogTool, getCornerMetricsTool, getLapAnalysisTool },
  memory: getChatMemory(),
});
