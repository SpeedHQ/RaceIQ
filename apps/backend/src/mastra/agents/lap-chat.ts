/**
 * Lap Chat — free-form conversational persona for a single lap.
 *
 * Used by the per-lap chat (POST /api/laps/:id/chat). Has Mastra memory so the
 * driver can ask follow-up questions and the model remembers earlier turns.
 */
import { Agent } from "@mastra/core/agent";
import type { Processor } from "@mastra/core/processors";
import { getChatTurnContext, getLatestChatTurnText } from "@raceiq/backend-core/ai/chat-message-context";
import { getChatMemory } from "@raceiq/backend-core/ai/chat-agent";
import { getModel } from "../../ai/model-provider";
import { getTrackGuideTool, listTrackGuidesTool } from "../tools/track-guide";
import { compareF1SetupToCatalogTool } from "../tools/f1-setup-compare";
import { getCornerMetricsTool } from "../tools/corner-metrics";
import { getLapAnalysisTool, generateLapAnalysisTool } from "../tools/lap-analysis";
import { TRACK_GUIDE_PROMPT } from "@raceiq/shared/integrations/ai/prompt-snippets";
const LAP_CHAT_INSTRUCTIONS = `You are a senior race engineer answering a driver's questions about a single lap of theirs. Lap context, telemetry summary, and (if available) the previous structured analysis are supplied per request via the system prompt. Be brief, use bullet points where helpful, cite specific numbers with units, and refer to the driver as "you". Do NOT output JSON.

Current request context is authoritative over all earlier chat history, assistant claims, tool results, or cached analysis. When current context includes revised data, use it even if history contains older data; never repeat obsolete values as current.

For requests for measured telemetry for a named corner, call \`get_corner_metrics\` using the current internal lap reference and that corner's 1-based T-label number on this turn, even if earlier messages already contain corner values. Do not answer with estimates or lap-wide summary values. Use returned values and units. If the requested metrics are unavailable, report the returned reason and stop; do not substitute another corner, unrelated telemetry, or tuning advice.

Lap numbers are for conversation. The internal lap reference is only for RaceIQ tools; never ask the driver to find or provide an internal ID. When lap context changes, use only the current request's lap and setup context.

For F1 2025 setup questions: when the driver asks about their car setup or how to tune it, call the \`compare-f1-setup-to-catalog\` tool with the internal lap reference supplied in the system prompt. It returns their current setup alongside the top-5 community setups for the same track with per-field deltas. Ground your answer in those comparisons — cite the reference team/driver and the delta — rather than offering generic advice.${TRACK_GUIDE_PROMPT}`;

export function buildLapChatInstructions(requestContext?: { get: (key: string) => unknown }): string {
  const context = getChatTurnContext(requestContext);
  return `${LAP_CHAT_INSTRUCTIONS}${context ? `\n\n${context}` : ""}`;
}

/** Clear corner-measurement requests must execute a fresh lookup, not merely suggest one in prose. */
export function requiresCornerMetricsLookup(requestContext?: { get: (key: string) => unknown }): boolean {
  const text = getLatestChatTurnText(requestContext);
  return /\b(?:turn|corner|t)\s*\d+\b/i.test(text) &&
    /\b(?:measured|measurements?|telemetry|speeds?|braking|brake|throttle)\b/i.test(text);
}

export type LapChatGroundingProcessor = Processor & Required<Pick<Processor, "processLLMRequest">>;

/** Fresh model-facing context without changing persisted conversation or system-role ordering. */
export const lapChatGroundingProcessor: LapChatGroundingProcessor = {
  id: "lap-chat-current-context",
  processLLMRequest({ prompt, requestContext, stepNumber }) {
    const context = getChatTurnContext(requestContext);
    const driverRequest = getLatestChatTurnText(requestContext);
    if (!context || !driverRequest) return;
    const index = prompt.findIndex(message =>
      message.role === "system" &&
      message.content.startsWith(LAP_CHAT_INSTRUCTIONS) &&
      message.content.endsWith(context),
    );
    const ordered = prompt.slice();
    if (index >= 0) {
      const current = ordered[index];
      if (current.role === "system") {
        ordered[index] = { ...current, content: current.content.slice(0, -context.length).trimEnd() };
      }
    }
    ordered.push({
      role: "user",
      content: [{
        type: "text",
        text: `Current request context supplied by RaceIQ:\n${context}\n\nCurrent driver request:\n${driverRequest}\n\nAnswer only this current driver request using the current context, not an earlier request or obsolete conversation values. For requested corner measurements, use this turn's get_corner_metrics result only. If unavailable, report its reason and stop without other corners, cached verdicts, or tuning advice.${stepNumber > 0 ? " A tool has already executed for this request; use its result above instead of repeating an identical lookup." : " No tool has executed for this current request yet. Earlier tool results belong to previous requests. If the current request asks for measured corner values, execute get_corner_metrics now before answering; do not infer availability from the export or history."}`,
      }],
    });
    return { prompt: ordered };
  },
};

export const lapChatAgent = new Agent({
  id: "lap-chat",
  name: "Lap Chat",
  instructions: ({ requestContext }) => buildLapChatInstructions(requestContext),
  model: ({ requestContext }) => getModel("chat", requestContext),
  inputProcessors: [lapChatGroundingProcessor],
  defaultOptions: ({ requestContext }) => ({
    prepareStep: ({ stepNumber }) => stepNumber === 0 && requiresCornerMetricsLookup(requestContext)
      ? { toolChoice: "required", activeTools: ["get_corner_metrics"] }
      : { toolChoice: "auto" },
  }),
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
