/**
 * Streaming equivalence for frame-based outcome metrics (issue #120, Phase 2).
 *
 * The whole point of `arm-stream.ts` is that it holds 2 laps of telemetry live
 * instead of the whole arm. That is only worth having if it computes the SAME
 * numbers as the in-memory path — so the central test here is an equivalence
 * assertion between `prepareArm` (all laps in memory) and `streamArmSamples`
 * (one lap at a time), on identical laps.
 *
 * No DB: samples arrive through an injected `SemanticSampleLoader`, which also
 * lets the peak-live-lap bound be *measured* rather than asserted by inspection.
 */

import { describe, expect, test } from "bun:test";
import { compareArmSamples, prepareArm } from "../../../server/experiments/comparison/compare";
import { streamArmSamples } from "../../../server/experiments/comparison/stream";
import { OUTCOME_METRICS, type PairwiseFramesOutcomeMetric } from "../../../server/experiments/comparison/metrics";
import { buildStreamingArm, CORNERS, REPEATABLE, SCATTERED, trackingLoader, type LapSpec } from "../../support/experiments/arms";

const FRAME_METRICS: PairwiseFramesOutcomeMetric[] = [OUTCOME_METRICS.inputVarianceBrake, OUTCOME_METRICS.inputVarianceThrottle, OUTCOME_METRICS.lineSpreadScore];

// ── the equivalence assertion ───────────────────────────────────────────────

describe("streaming produces the same samples as the in-memory path", () => {
  for (const metric of FRAME_METRICS) {
    test(`${metric.id}: identical samples, lap for lap`, async () => {
      const built = buildStreamingArm(SCATTERED);
      const expected = prepareArm(built.inMemory, metric);
      const streamed = await streamArmSamples({
        label: "arm",
        metas: built.metas,
        metric,
        loadSamples: trackingLoader(built.frames).loadSamples,
        resolveCorners: async () => CORNERS,
      });

      // Same reference lap excluded, same lap ids, same order, same values.
      expect(streamed.samples).toEqual(expected.samples);
      expect(streamed.samples.length).toBe(SCATTERED.length - 1);
      expect(streamed.rawLapCount).toBe(expected.rawLapCount);
      expect(streamed.pool.kept.map((l) => l.id)).toEqual(expected.pool.kept.map((l) => l.id));
    });
  }

  test("and therefore the same comparison, statistic for statistic", async () => {
    const metric = OUTCOME_METRICS.inputVarianceBrake;
    const a = buildStreamingArm(SCATTERED, 1);
    const b = buildStreamingArm(REPEATABLE, 100);

    const inMemory = compareArmSamples(prepareArm(a.inMemory, metric), prepareArm(b.inMemory, metric), metric);
    const streamed = compareArmSamples(
      await streamArmSamples({
        label: "arm",
        metas: a.metas,
        metric,
        loadSamples: trackingLoader(a.frames).loadSamples,
        resolveCorners: async () => CORNERS,
      }),
      await streamArmSamples({
        label: "arm",
        metas: b.metas,
        metric,
        loadSamples: trackingLoader(b.frames).loadSamples,
        resolveCorners: async () => CORNERS,
      }),
      metric,
    );

    expect(streamed.pValue).toBe(inMemory.pValue);
    expect(streamed.deltaMean).toBe(inMemory.deltaMean);
    expect(streamed.effectSize).toBe(inMemory.effectSize);
    expect(streamed.ci).toEqual(inMemory.ci);
    expect(streamed.significance).toBe(inMemory.significance);
    expect(streamed.favours).toBe(inMemory.favours);
    expect(streamed.a.n).toBe(inMemory.a.n);
    // The finding itself, so this isn't an equivalence between two null results.
    expect(streamed.significance).toBe("significant");
    expect(streamed.favours).toBe("b");
  });

  test("equivalence survives ineligible and telemetry-less laps in the pool", async () => {
    const metric = OUTCOME_METRICS.lineSpreadScore;
    const specs: LapSpec[] = [
      { lateral: 0, brakeShift: 0 },
      { lateral: 4, brakeShift: 0, isValid: false }, // curated out
      { lateral: 2, brakeShift: 10 },
      { lateral: -2, brakeShift: -10, rawFrameCount: 0 }, // no stored frames
      { lateral: 1, brakeShift: 5 },
      { lateral: -1, brakeShift: -5 },
    ];
    const built = buildStreamingArm(specs);
    const expected = prepareArm(built.inMemory, metric);
    const streamed = await streamArmSamples({
      label: "arm",
      metas: built.metas,
      metric,
      loadSamples: trackingLoader(built.frames).loadSamples,
      resolveCorners: async () => CORNERS,
    });

    expect(streamed.samples).toEqual(expected.samples);
    expect(streamed.pool.droppedIneligible).toBe(1);
    // 4 decodable laps, one of which is the reference.
    expect(streamed.samples.length).toBe(3);
  });
});
