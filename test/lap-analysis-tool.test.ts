import { describe, expect, test } from "bun:test";

import { parseCachedLapAnalysis } from "../mastra/tools/lap-analysis";
import { buildCompareChatSystemPrompt } from "../server/ai/compare-chat-prompt";

const lap = { lapNumber: 4, lapTime: 91.2, isValid: true, gameId: "fm-2023" as const };

const comparison = {
  timeDelta: [0, 0.4],
  distances: [0, 100],
  cornerDeltas: [],
} as never;

describe("lap analysis retrieval contract", () => {
  test("parses cached structured analysis for tool output", () => {
    const result = parseCachedLapAnalysis({ analysis: '{"verdict":"clean"}' });
    expect(result).toEqual({ analysis: { verdict: "clean" }, readable: '{\n  "verdict": "clean"\n}' });
  });

  test("rejects malformed cached analysis", () => {
    const result = parseCachedLapAnalysis({ analysis: "not-json" });
    expect(result).toEqual({
      error: "Cached analysis is invalid JSON",
      readable: "Cached analysis is invalid and cannot be used safely.",
    });
  });

  test("does not embed cached analysis in compare prompts", () => {
    const comparePrompt = buildCompareChatSystemPrompt(lap, { ...lap, lapNumber: 5 }, comparison, "metric", "C", "en");
    expect(comparePrompt).not.toContain("LAP A ANALYSIS");
    expect(comparePrompt).not.toContain("LAP B ANALYSIS");
    expect(comparePrompt).toContain("get_lap_analysis");
  });
});
