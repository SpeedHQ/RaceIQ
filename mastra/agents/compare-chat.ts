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

export const compareChatAgent = new Agent({
  id: "compare-chat",
  name: "Compare Chat",
  instructions: compareEngineerPersona("metric"),
  model: () => {
    const s = loadSettings();
    return getMastraModelId(s.chatProvider, s.chatModel);
  },
  tools: { getTrackGuideTool, listTrackGuidesTool },
  memory: getChatMemory(),
});
