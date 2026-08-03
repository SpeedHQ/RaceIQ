import { describe, expect, test } from "bun:test";

import { getGenerateLapAnalysisTool } from "../mastra/tools/lap-analysis";

describe("lap analysis generation tool", () => {
  test("returns parsed cached structured output and usage", async () => {
    const tool = getGenerateLapAnalysisTool(async () => ({
      analysis: '{"verdict":"clean"}',
      cached: true,
      usage: {
        inputTokens: 12,
        outputTokens: 8,
        costUsd: 0.001,
        durationMs: 42,
        model: "test-model",
      },
      cornerFracs: [],
      hasTune: false,
    }));

    const result = await tool.execute({ lapId: 42 });

    expect(result).toEqual({
      available: true,
      lapId: 42,
      analysis: { verdict: "clean" },
      readable: '{\n  "verdict": "clean"\n}',
      cached: true,
      usage: {
        inputTokens: 12,
        outputTokens: 8,
        costUsd: 0.001,
        durationMs: 42,
        model: "test-model",
      },
    });
  });

  test("reports generation errors without inventing analysis", async () => {
    const tool = getGenerateLapAnalysisTool(async () => ({
      analysis: null,
      cached: false,
      cornerFracs: [],
      hasTune: false,
      error: "AI provider is not configured",
    }));

    const result = await tool.execute({ lapId: 7, regenerate: true });

    expect(result.available).toBe(false);
    expect(result.lapId).toBe(7);
    expect(result.cached).toBe(false);
    expect(result.analysis).toBeUndefined();
    expect(result.error).toBe("AI provider is not configured");
    expect(result.readable).toContain("AI provider is not configured");
  });
});
