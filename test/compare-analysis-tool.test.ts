import { describe, expect, test } from "bun:test";
import { getCompareAnalysisToolFor } from "../mastra/tools/compare-analysis";

describe("get_compare_analysis tool", () => {
  test("returns persisted Inputs analysis for either lap order", async () => {
    const tool = getCompareAnalysisToolFor(async (a, b) => {
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
    });

    const result = await tool.execute({ lapAId: 7, lapBId: 3 }, {} as never);
    expect(result).toMatchObject({
      available: true,
      lapAId: 7,
      lapBId: 3,
      analysis: { verdict: "A gains time" },
      model: "test-model",
    });
  });

  test("reports unavailable without inventing analysis", async () => {
    const tool = getCompareAnalysisToolFor(async () => null);
    await expect(
      tool.execute({ lapAId: 3, lapBId: 7 }, {} as never),
    ).resolves.toEqual({
      available: false,
      lapAId: 3,
      lapBId: 7,
      error: "No cached Inputs comparison is available for laps 3 and 7.",
    });
  });
});
