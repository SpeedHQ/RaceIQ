import { describe, expect, test } from "bun:test";

import {
  getLapAnalysisToolFor,
  parseCachedLapAnalysis,
} from "../../../mastra/tools/lap-analysis";
import { buildCompareChatSystemPrompt } from "../../../server/ai/compare-chat-prompt";

const lap = {
  id: 1,
  lapNumber: 4,
  lapTime: 91.2,
  isValid: true,
  gameId: "fm-2023" as const,
};

const validAnalysis = JSON.stringify({
  verdict: "clean",
  pace: [],
  handling: [],
  corners: [],
  technique: [],
  setup: [],
});

type LapResult = {
  available: boolean;
  lapId: number;
  analysis?: unknown;
  readable: string;
  model?: string;
  error?: string;
};

function isLapResult(value: unknown): value is LapResult {
  if (!value || typeof value !== "object") return false;
  const result = value as {
    available?: unknown;
    lapId?: unknown;
    readable?: unknown;
  };
  return (
    typeof result.available === "boolean" &&
    typeof result.lapId === "number" &&
    typeof result.readable === "string"
  );
}

const comparison = {
  timeDelta: [0, 0.4],
  distances: [0, 100],
  cornerDeltas: [],
} as never;

describe("lap analysis retrieval contract", () => {
  test("parses cached structured analysis for tool output", () => {
    const result = parseCachedLapAnalysis({ analysis: validAnalysis });
    expect(result).toEqual({
      analysis: JSON.parse(validAnalysis),
      readable: JSON.stringify(JSON.parse(validAnalysis), null, 2),
    });
  });

  test("rejects malformed cached analysis", () => {
    const result = parseCachedLapAnalysis({ analysis: "not-json" });
    expect(result).toEqual({
      error: "Cached analysis is invalid JSON",
      readable: "Cached analysis is invalid and cannot be used safely.",
    });
  });

  test("rejects null, arrays, and schema-invalid cached rows", async () => {
    for (const analysis of [
      "null",
      "[]",
      JSON.stringify({ verdict: "missing required fields" }),
    ]) {
      const tool = getLapAnalysisToolFor(async () => ({
        analysis,
        inputTokens: 1,
        outputTokens: 1,
        costUsd: 0,
        durationMs: 1,
        model: "test-model",
      }));
      const execute = tool.execute;
      if (!execute) throw new Error("Lap analysis tool has no execute function");
      const rawResult = await execute({ lapId: 4 }, {} as never);
      if (!isLapResult(rawResult)) throw new Error("Unexpected lap analysis tool result");
      const result = rawResult;
      expect(result.available).toBe(false);
      expect(result.analysis).toBeUndefined();
      expect(result.error).toContain("schema");
    }
  });
  test("does not embed cached analysis in compare prompts", () => {
    const comparePrompt = buildCompareChatSystemPrompt(
      lap,
      { ...lap, lapNumber: 5 },
      comparison,
      "metric",
      "C",
      "en",
    );
    expect(comparePrompt).not.toContain("LAP A ANALYSIS");
    expect(comparePrompt).not.toContain("LAP B ANALYSIS");
    expect(comparePrompt).toContain("get_lap_analysis");
  });
});
