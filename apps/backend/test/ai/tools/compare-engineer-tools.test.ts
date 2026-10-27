import { describe, expect, test } from "bun:test";
import { RequestContext } from "@mastra/core/request-context";
import { compareEngineerAgent } from "../../../src/mastra/agents/compare-engineer";
import { compareChatAgent } from "../../../src/mastra/agents/compare-chat";
import { lapChatAgent } from "../../../src/mastra/agents/lap-chat";
import { lapAnalystAgent } from "../../../src/mastra/agents/lap-analyst";
import { createModelContext } from "../../../src/ai/model-provider";
import { resolveAi } from "../../../src/ai/ai-runtime";
import { loadSettings } from "@raceiq/backend-core/runtime/config/settings";
type ToolInspectionAgent = {
  getToolsForExecution(options: {
    requestContext: RequestContext;
  }): Promise<Record<string, unknown>>;
};

async function toolNames(agent: ToolInspectionAgent): Promise<string[]> {
  const ai = await resolveAi("chat", {
    ...loadSettings(),
    chatProvider: "openai-compatible",
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
    expect(tools).toContain("get_tire_temperature_guide");
    expect(tools).toContain("compare_laps");
    expect(tools).toContain("get_lap_detail");
    expect(tools).toContain("get_lap_issues");
    expect(tools).toContain("list_laps");
    expect(tools).not.toContain("apply_changes");
    expect(tools).not.toContain("set_lap_excluded");
    expect(tools).not.toContain("update_notes");
    expect(tools).not.toContain("record_driver_notes");
    expect(tools).not.toContain("delete_version");
    expect(tools).not.toContain("undo_last_action");
  });
  test("registers generation and retrieval under exact snake-case keys", async () => {
    const lapChatTools = await toolNames(lapChatAgent);
    expect(lapChatTools).toContain("get_lap_analysis");
    expect(lapChatTools).toContain("generate_lap_analysis");
    expect(lapChatTools).not.toContain("getLapAnalysisTool");
    expect(lapChatTools).not.toContain("generateLapAnalysisTool");
    const compareChatTools = await toolNames(compareChatAgent);

    expect(compareChatTools).toContain("get_lap_analysis");
    expect(compareChatTools).toContain("get_compare_analysis");
    expect(compareChatTools).toContain("generate_lap_analysis");
    expect(compareChatTools).not.toContain("getLapAnalysisTool");
    expect(compareChatTools).not.toContain("generateLapAnalysisTool");

    const lapAnalystTools = await toolNames(lapAnalystAgent);
    expect(lapAnalystTools).not.toContain("generate_lap_analysis");
  });
});
