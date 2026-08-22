import { describe, expect, test } from "bun:test";
import { getCompareAnalysisToolFor } from "../../../mastra/tools/compare-analysis";
import { compareFindingGenerationCacheKey } from "../../../server/db/analysis-queries";
import { FINDING_RECEIPT_FENCE_CONTEXT_KEY } from "../../../server/ai/chat-message-context";
import type { InputsCompareResult } from "../../../server/ai/inputs-compare-prompt";

type CompareResult = {
  available: boolean;
  lapAId: number;
  lapBId: number;
  analysis?: InputsCompareResult;
  model?: string;
  error?: string;
};

function isCompareResult(value: unknown): value is CompareResult {
  if (!value || typeof value !== "object") return false;
  const result = value as {
    available?: unknown;
    lapAId?: unknown;
    lapBId?: unknown;
  };
  return (
    typeof result.available === "boolean" &&
    typeof result.lapAId === "number" &&
    typeof result.lapBId === "number"
  );
}

const findingDeps = {
  getLapById: async (lapId: number) => ({
    id: lapId,
    gameId: "fm-2023" as const,
    sessionId: lapId + 100,
  }) as never,
  getCurrentFindingGeneration: async (scope: { lapId?: string }) => ({
    receipt: {
      generationId: `generation-${scope.lapId}`,
      contentHash: `content-${scope.lapId}`,
    },
    findings: [],
  }) as never,
};
describe("get_compare_analysis tool", () => {
  test("returns persisted Inputs analysis for either lap order", async () => {
    const tool = getCompareAnalysisToolFor(async (a, b, _findingKey, kind) => {
      expect(kind).toBe("inputs");
      const [lo, hi] = [a, b].sort((x, y) => x - y);
      const analysis = {
        verdict: "A gains time",
        segments: [
          {
            name: "T1",
            deltaSeconds: 0.2,
            throttle: "A earlier",
            brake: "B later",
            steering: "Similar",
            action: "Brake 10m later.",
            severity: "major",
          },
        ],
        coaching: [{ tip: "Brake later", detail: "At T1", targetLap: "B" }],
      };
      return lo === 3 && hi === 7
        ? ({ analysis: JSON.stringify(analysis), model: "test-model" } as never)
        : null;
    }, findingDeps);

    const execute = tool.execute;
    if (!execute) throw new Error("Compare analysis tool has no execute function");
    const rawResult = await execute({ lapAId: 7, lapBId: 3 }, {} as never);
    if (!isCompareResult(rawResult)) throw new Error("Unexpected compare analysis tool result");
    const result = rawResult;
    expect(result).toMatchObject({
      available: true,
      lapAId: 7,
      lapBId: 3,
      analysis: { verdict: "A gains time" },
      model: "test-model",
    });
  });

  test("reports unavailable without inventing analysis", async () => {
    const tool = getCompareAnalysisToolFor(async () => null, findingDeps);
    const execute = tool.execute;
    if (!execute) throw new Error("Compare analysis tool has no execute function");
    const rawResult = await execute({ lapAId: 3, lapBId: 7 }, {} as never);
    if (!isCompareResult(rawResult)) throw new Error("Unexpected compare analysis tool result");
    expect(rawResult).toEqual({
      available: false,
      lapAId: 3,
      lapBId: 7,
      error: "No cached Inputs comparison is available for laps 3 and 7.",
    });
  });

  test("abstains before cache lookup when a current finding generation is missing", async () => {
    let cacheRead = false;
    const tool = getCompareAnalysisToolFor(
      async () => {
        cacheRead = true;
        return null;
      },
      {
        ...findingDeps,
        getCurrentFindingGeneration: async () => null,
      },
    );
    const execute = tool.execute;
    if (!execute) throw new Error("Compare analysis tool has no execute function");
    const rawResult = await execute({ lapAId: 3, lapBId: 7 }, {} as never);
    if (!isCompareResult(rawResult)) throw new Error("Unexpected compare analysis tool result");

    expect(cacheRead).toBe(false);
    expect(rawResult.available).toBe(false);
    expect(rawResult.error).toContain("finding generations");
  });

  test("uses the request-bound receipt fence without loading a newer generation", async () => {
    const laps = [
      { lapId: 3, generationId: "generation-3", contentHash: "content-3" },
      { lapId: 7, generationId: "generation-7", contentHash: "content-7" },
    ] as const;
    const cacheKey = compareFindingGenerationCacheKey([
      { lapId: laps[0].lapId, receipt: laps[0] },
      { lapId: laps[1].lapId, receipt: laps[1] },
    ]);
    let receivedExpectations: unknown;
    const tool = getCompareAnalysisToolFor(
      async (_lapAId, _lapBId, expectations) => {
        receivedExpectations = expectations;
        return null;
      },
      {
        ...findingDeps,
        getCurrentFindingGeneration: async () => {
          throw new Error("must not load latest generation");
        },
      },
    );
    const execute = tool.execute;
    if (!execute) throw new Error("Compare analysis tool has no execute function");
    const rawResult = await execute(
      { lapAId: 7, lapBId: 3 },
      {
        requestContext: {
          get(key: string) {
            return key === FINDING_RECEIPT_FENCE_CONTEXT_KEY
              ? { kind: "comparison", gameId: "fm-2023", cacheKey, laps }
              : undefined;
          },
        },
      } as never,
    );
    if (!isCompareResult(rawResult)) throw new Error("Unexpected compare analysis tool result");

    expect(receivedExpectations).toEqual([
      { scope: { kind: "lap", gameId: "fm-2023", sessionId: "107", lapId: "7" }, generationId: "generation-7", contentHash: "content-7" },
      { scope: { kind: "lap", gameId: "fm-2023", sessionId: "103", lapId: "3" }, generationId: "generation-3", contentHash: "content-3" },
    ]);
  });
});
