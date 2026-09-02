import { describe, expect, test } from "bun:test";
import { ACC_MODEL_EVAL_CONFIG, MODEL_EVAL_FIXTURES, buildModelEvalCases, loadParsedModelEvalFixture } from "../../../scripts/quality/model-eval-cases";

describe("model eval fixture cases", () => {
  test("registers ACC fixture and retains parsed packet-bearing laps", async () => {
    expect(MODEL_EVAL_FIXTURES[ACC_MODEL_EVAL_CONFIG.id]).toBe(ACC_MODEL_EVAL_CONFIG);
    const fixture = await loadParsedModelEvalFixture(ACC_MODEL_EVAL_CONFIG);
    expect(fixture.analystLap.lapNumber).toBe(3);
    expect(fixture.analystLap.packets.length).toBeGreaterThan(0);
    expect(fixture.compareLaps.map((lap) => lap.lapNumber)).toEqual([2, 3]);
    expect(fixture.compareLaps.every((lap) => lap.packets.length > 0)).toBe(true);
  }, 300_000);

  test("builds grounded ACC analyst and comparison cases", async () => {
    const fixture = await loadParsedModelEvalFixture(ACC_MODEL_EVAL_CONFIG);
    const cases = await buildModelEvalCases(fixture);
    expect(cases.map((item) => item.id)).toEqual([
      "acc-brands-hatch-2026-04-10-lap-3-analyst",
      "acc-brands-hatch-2026-04-10-laps-2-vs-3-compare",
    ]);
    const [analyst, compare] = cases;
    expect(analyst.groundTruth.units).toBe("metric");
    expect(analyst.groundTruth.sourceContext).toContain(analyst.input);
    expect(analyst.groundTruth.truth.metrics?.segmentStats.length).toBeGreaterThan(0);
    expect(analyst.input).toContain("Brands Hatch");
    expect(compare.input).toContain("Brands Hatch");
    expect(compare.groundTruth.sourceContext).toContain(compare.input);
    expect(compare.groundTruth.truth.comparison?.cornerDeltas.length).toBeGreaterThan(0);
    expect(compare.groundTruth.units).toBe("metric");
    expect(analyst.groundTruth.slowestCorners).toHaveLength(3);
    expect(analyst.groundTruth.slowestCorners?.every((corner) => analyst.groundTruth.trackCorners.includes(corner))).toBe(true);
    expect(compare.groundTruth.fasterLap).toBe("B");
  }, 300_000);
});
