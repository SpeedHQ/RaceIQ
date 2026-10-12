/**
 * Lap Chat — free-form conversational persona for a single lap.
 *
 * Used by the per-lap chat (POST /api/laps/:id/chat). Has Mastra memory so the
 * driver can ask follow-up questions and the model remembers earlier turns.
 */
import { Agent } from "@mastra/core/agent";
import { getChatTurnContext } from "@raceiq/backend-core/ai/chat-message-context";
import { getChatMemory } from "@raceiq/backend-core/ai/chat-agent";
import { getModel } from "../../ai/model-provider";
import { getTrackGuideTool, listTrackGuidesTool } from "../tools/track-guide";
import { compareF1SetupToCatalogTool } from "../tools/f1-setup-compare";
import { getCornerMetricsTool } from "../tools/corner-metrics";
import { getLapAnalysisTool, generateLapAnalysisTool } from "../tools/lap-analysis";
import { TRACK_GUIDE_PROMPT } from "@raceiq/shared/integrations/ai/prompt-snippets";
const LAP_CHAT_INSTRUCTIONS = `You are a senior race engineer answering a driver's questions about a single lap of theirs. Lap context, telemetry summary, and (if available) the previous structured analysis are supplied per request via the system prompt. Be brief, use bullet points where helpful, cite specific numbers with units, and refer to the driver as "you". Do NOT output JSON.

Lap numbers are for conversation. The internal lap reference is only for RaceIQ tools; never ask the driver to find or provide an internal ID. When lap context changes, use only the current request's lap and setup context.

For F1 2025 setup questions: when the driver asks about their car setup or how to tune it, call the \`compare-f1-setup-to-catalog\` tool with the internal lap reference supplied in the system prompt. It returns their current setup alongside the top-5 community setups for the same track with per-field deltas. Ground your answer in those comparisons — cite the reference team/driver and the delta — rather than offering generic advice.${TRACK_GUIDE_PROMPT}`;

export function buildLapChatInstructions(requestContext?: { get: (key: string) => unknown }): string {
  const context = getChatTurnContext(requestContext);
  return `${LAP_CHAT_INSTRUCTIONS}${context ? `\n\n${context}` : ""}`;
}

export const lapChatAgent = new Agent({
  id: "lap-chat",
  name: "Lap Chat",
  instructions: ({ requestContext }) => buildLapChatInstructions(requestContext),
  model: ({ requestContext }) => getModel("chat", requestContext),
  tools: {
    get_track_guide: getTrackGuideTool,
    list_track_guides: listTrackGuidesTool,
    compare_f1_setup_to_catalog: compareF1SetupToCatalogTool,
    get_corner_metrics: getCornerMetricsTool,
    get_lap_analysis: getLapAnalysisTool,
    generate_lap_analysis: generateLapAnalysisTool,
  },
  memory: getChatMemory(),
});
