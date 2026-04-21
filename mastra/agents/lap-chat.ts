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

const LAP_CHAT_INSTRUCTIONS = `You are a senior race engineer answering a driver's questions about a single lap of theirs. Lap context, telemetry summary, and (if available) the previous structured analysis are supplied per request via the system prompt. Be brief, use bullet points where helpful, cite specific numbers with units, and refer to the driver as "you". Do NOT output JSON.

For F1 2025 setup questions: when the driver asks about their car setup or how to tune it, call the \`compare-f1-setup-to-catalog\` tool with their \`lapId\` (supplied in the system prompt). It returns their current setup alongside the top-5 community setups for the same track with per-field deltas. Ground your answer in those comparisons — cite the reference team/driver and the delta — rather than offering generic advice.`;

export const lapChatAgent = new Agent({
  id: "lap-chat",
  name: "Lap Chat",
  instructions: LAP_CHAT_INSTRUCTIONS,
  model: () => {
    const s = loadSettings();
    return getMastraModelId(s.chatProvider, s.chatModel, s.localEndpoint);
  },
  tools: { getTrackGuideTool, listTrackGuidesTool, compareF1SetupToCatalogTool },
  memory: getChatMemory(),
});
