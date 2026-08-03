/**
 * Lap Chat — free-form conversational persona for a single lap.
 *
 * Used by the per-lap chat (POST /api/laps/:id/chat). Has Mastra memory so the
 * driver can ask follow-up questions and the model remembers earlier turns.
 */
import { Agent } from "@mastra/core/agent";
import { getChatMemory } from "../../server/ai/chat-agent";
import { getMastraModelId } from "../model";
import { loadSettings } from "../../server/settings";
import { getTrackGuideTool, listTrackGuidesTool } from "../tools/track-guide";
import { compareF1SetupToCatalogTool } from "../tools/f1-setup-compare";
import { getCornerMetricsTool } from "../tools/corner-metrics";
import {
  getLapAnalysisTool,
  generateLapAnalysisTool,
} from "../tools/lap-analysis";
import { TRACK_GUIDE_PROMPT } from "../../shared/prompt-snippets";

const LAP_CHAT_INSTRUCTIONS = `You are a senior race engineer answering a driver's questions about a single lap of theirs. Lap context and telemetry summary are supplied per request. The previous structured analysis is NOT supplied in the prompt: call the \`get_lap_analysis\` tool first before making any lap-specific diagnosis or setup recommendation. Only if retrieval reports unavailable, call \`generate_lap_analysis\`. If both tools report unavailable, explicitly state that lap analysis could not be retrieved or generated and do not invent lap-specific findings. Be brief, use bullet points where helpful, cite specific numbers with units, and refer to the driver as "you". Do NOT output JSON.

For F1 2025 setup questions: when the driver asks about their car setup or how to tune it, call the \`compare-f1-setup-to-catalog\` tool with their \`lapId\` (supplied in the system prompt). It returns their current setup alongside the top-5 community setups for the same track with per-field deltas. Ground your answer in those comparisons — cite the reference team/driver and the delta — rather than offering generic advice.${TRACK_GUIDE_PROMPT}`;

export const lapChatAgent = new Agent({
  id: "lap-chat",
  name: "Lap Chat",
  instructions: LAP_CHAT_INSTRUCTIONS,
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
    generate_lap_analysis: generateLapAnalysisTool,
  },
  memory: getChatMemory(),
});
