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
  getToolsForExecution(options: { requestContext: RequestContext }): Promise<Record<string, unknown>>;
};

async function toolNames(agent: ToolInspectionAgent): Promise<string[]> {
  const ai = await resolveAi("chat", {
    ...loadSettings(),
    chatProvider: "local",
    chatModel: "tool-inspection-model",
  });
  const requestContext = createModelContext(ai, new RequestContext());
  if (!requestContext) throw new Error("Expected local model request context");
  return Object.keys(await agent.getToolsForExecution({ requestContext })).sort();
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
  test("registers generation on Lap Chat and Compare Chat, but not Lap Analyst", async () => {
    await expect(toolNames(lapChatAgent)).resolves.toContain("generateLapAnalysisTool");
    await expect(toolNames(compareChatAgent)).resolves.toContain("generateLapAnalysisTool");
    await expect(toolNames(lapAnalystAgent)).resolves.not.toContain("generate_lap_analysis");
  });
});
