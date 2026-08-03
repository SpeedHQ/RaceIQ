import { describe, expect, test } from "bun:test";
import { RequestContext } from "@mastra/core/request-context";
import { compareEngineerAgent } from "../mastra/agents/compare-engineer";
import { compareChatAgent } from "../mastra/agents/compare-chat";
import { lapChatAgent } from "../mastra/agents/lap-chat";
import { lapAnalystAgent } from "../mastra/agents/lap-analyst";
import { createModelContext } from "../server/ai/model-provider";
import { resolveAi } from "../server/ai/ai-runtime";
import { loadSettings } from "../server/settings";
type ToolInspectionAgent = {
  getToolsForExecution(options: {
    requestContext: RequestContext;
  }): Promise<Record<string, unknown>>;
};

async function toolNames(agent: ToolInspectionAgent): Promise<string[]> {
  const ai = await resolveAi("chat", {
    ...loadSettings(),
    chatProvider: "local",
    chatModel: "tool-inspection-model",
  });
  const requestContext = createModelContext(ai, new RequestContext());
  if (!requestContext) throw new Error("Expected local model request context");
  return Object.keys(
    await agent.getToolsForExecution({ requestContext }),
  ).sort();
}

describe("Compare Engineer tools", () => {
  test("exposes comparison and read-only lap tools only", async () => {
    const tools = await toolNames(compareEngineerAgent);
    expect(tools).toEqual([
      "compare_f1_setup_to_catalog",
      "compare_laps",
      "generate_lap_analysis",
      "get_corner_metrics",
      "get_lap_analysis",
      "get_lap_detail",
      "get_lap_issues",
      "get_track_guide",
      "list_laps",
      "list_track_guides",
    ]);
    expect(tools).not.toContain("apply_changes");
    expect(tools).not.toContain("delete_version");
  });
  test("registers generation and retrieval under exact snake-case keys", async () => {
    const lapChatTools = await toolNames(lapChatAgent);
    expect(lapChatTools).toContain("get_lap_analysis");
    expect(lapChatTools).toContain("generate_lap_analysis");
    expect(lapChatTools).not.toContain("getLapAnalysisTool");
    expect(lapChatTools).not.toContain("generateLapAnalysisTool");

    const compareChatTools = await toolNames(compareChatAgent);
    expect(compareChatTools).toContain("get_lap_analysis");
    expect(compareChatTools).toContain("generate_lap_analysis");
    expect(compareChatTools).not.toContain("getLapAnalysisTool");
    expect(compareChatTools).not.toContain("generateLapAnalysisTool");

    const lapAnalystTools = await toolNames(lapAnalystAgent);
    expect(lapAnalystTools).not.toContain("generate_lap_analysis");
  });
});
