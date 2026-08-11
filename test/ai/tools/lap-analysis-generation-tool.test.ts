import { describe, expect, test } from "bun:test";

import { getGenerateLapAnalysisTool } from "../../../mastra/tools/lap-analysis";

const validAnalysis = JSON.stringify({
  verdict: "clean",
  pace: [],
  handling: [],
  corners: [],
  technique: [],
  setup: [],
});

type GenerateResult = {
  available: boolean;
  lapId: number;
  analysis?: unknown;
  readable: string;
  cached: boolean;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    durationMs: number;
    model: string;
  };
  error?: string;
};

function isGenerateResult(value: unknown): value is GenerateResult {
  if (!value || typeof value !== "object") return false;
  const result = value as {
    available?: unknown;
    lapId?: unknown;
    readable?: unknown;
    cached?: unknown;
  };
  return (
    typeof result.available === "boolean" &&
    typeof result.lapId === "number" &&
    typeof result.readable === "string" &&
    typeof result.cached === "boolean"
  );
}

describe("lap analysis generation tool", () => {
  test("returns parsed cached structured output and usage", async () => {
    const tool = getGenerateLapAnalysisTool(async () => ({
      analysis: validAnalysis,
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

    const execute = tool.execute;
    if (!execute) throw new Error("Generate lap analysis tool has no execute function");
    const rawResult = await execute({ lapId: 42 }, {} as never);
    if (!isGenerateResult(rawResult)) throw new Error("Unexpected generate lap analysis tool result");
    const result = rawResult;

    expect(result).toEqual({
      available: true,
      lapId: 42,
      analysis: {
        verdict: "clean",
        pace: [],
        handling: [],
        corners: [],
        technique: [],
        setup: [],
      },
      readable: JSON.stringify(
        {
          verdict: "clean",
          pace: [],
          handling: [],
          corners: [],
          technique: [],
          setup: [],
        },
        null,
        2,
      ),
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

    const execute = tool.execute;
    if (!execute) throw new Error("Generate lap analysis tool has no execute function");
    const rawResult = await execute({ lapId: 7, regenerate: true }, {} as never);
    if (!isGenerateResult(rawResult)) throw new Error("Unexpected generate lap analysis tool result");
    const result = rawResult;

    expect(result.available).toBe(false);
    expect(result.lapId).toBe(7);
    expect(result.cached).toBe(false);
    expect(result.analysis).toBeUndefined();
    expect(result.error).toBe("AI provider is not configured");
    expect(result.readable).toContain("AI provider is not configured");
  });
});
