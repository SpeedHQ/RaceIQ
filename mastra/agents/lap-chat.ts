/**
 * Lap Chat — free-form conversational persona for a single lap.
 *
 * Used by the per-lap chat (POST /api/laps/:id/chat). Has Mastra memory so the
 * driver can ask follow-up questions and the model remembers earlier turns.
 */
import { Agent } from "@mastra/core/agent";
import { getChatTurnContext } from "../../server/ai/chat-message-context";
import { getChatMemory } from "../../server/ai/chat-agent";
import { getModel } from "../../server/ai/model-provider";
import { getTrackGuideTool, listTrackGuidesTool } from "../tools/track-guide";
import { compareF1SetupToCatalogTool } from "../tools/f1-setup-compare";
import { getCornerMetricsTool } from "../tools/corner-metrics";
import { getLapAnalysisTool, generateLapAnalysisTool } from "../tools/lap-analysis";
import { TRACK_GUIDE_PROMPT } from "../../shared/integrations/ai/prompt-snippets";
const LAP_CHAT_INSTRUCTIONS = `You are a senior race engineer answering a driver's questions about a single lap of theirs. Lap context, telemetry summary, and (if available) the previous structured analysis are supplied per request via the system prompt. Be brief, use bullet points where helpful, cite specific numbers with units, and refer to the driver as "you". Do NOT output JSON.

For F1 2025 setup questions: when driver asks about car setup or tuning, call \`compare-f1-setup-to-catalog\` with \`lapId\` and matching \`gameId\` (supplied in system prompt). It reads persisted car setup and returns top-5 community comparisons. Ground answer in references — cite team/driver and delta — rather than generic advice.${TRACK_GUIDE_PROMPT}`;

export const lapChatAgent = new Agent({
  id: "lap-chat",
  name: "Lap Chat",
  instructions: ({ requestContext }) => {
    const context = getChatTurnContext(requestContext);
    return `${LAP_CHAT_INSTRUCTIONS}${context ? `\n\n${context}` : ""}`;
  },
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
