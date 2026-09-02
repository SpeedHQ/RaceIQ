import { describe, expect, test } from "bun:test";
import { ACC_MODEL_EVAL_CONFIG, buildModelEvalDatasetDefinitions, loadParsedModelEvalFixture } from "../../../mastra/evals/model-eval-datasets";

describe("native model-eval datasets", () => {
  test("builds versioned analyst and comparison payloads", async () => {
    const fixture = await loadParsedModelEvalFixture(ACC_MODEL_EVAL_CONFIG);
    const [analyst, compare] = await buildModelEvalDatasetDefinitions(fixture);
    expect(analyst.id).toBe("raceiq-model-eval-lap-analyst");
    expect(compare.id).toBe("raceiq-model-eval-compare-engineer");
    expect(analyst.items).toHaveLength(3);
    expect(compare.items).toHaveLength(3);
    expect(analyst.items.map((item) => item.externalId)).toEqual([
      `${ACC_MODEL_EVAL_CONFIG.id}-lap-${ACC_MODEL_EVAL_CONFIG.analystLapNumber}-analyst-repeat-1`,
      `${ACC_MODEL_EVAL_CONFIG.id}-lap-${ACC_MODEL_EVAL_CONFIG.analystLapNumber}-analyst-repeat-2`,
      `${ACC_MODEL_EVAL_CONFIG.id}-lap-${ACC_MODEL_EVAL_CONFIG.analystLapNumber}-analyst-repeat-3`,
    ]);
    expect((compare.items[0].groundTruth as { fasterLap: string }).fasterLap).toBe("B");
    expect((compare.items[0].groundTruth as { lapIds: number[] }).lapIds.every((id) => id > 0)).toBe(true);
    expect(compare.items[0].toolMocks).toHaveLength(2);
  }, 300_000);
});
