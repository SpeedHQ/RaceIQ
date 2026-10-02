import { describe, expect, test } from "bun:test";
import { compareArmSamples, describeComparison } from "../../../server/experiments/comparison/compare";
import {
  FRAME_BUDGET_PER_ARM,
  selectWithinFrameBudget,
  streamArmSamples,
} from "../../../server/experiments/comparison/stream";
import { OUTCOME_METRICS } from "../../../server/experiments/comparison/metrics";
import { buildStreamingArm, CORNERS, FRAMES_PER_LAP, REPEATABLE, SCATTERED, trackingLoader } from "../../support/experiments/arms";
import type { PairwiseFramesOutcomeMetric } from "../../../server/experiments/comparison/metrics";


// ── the memory bound, measured ──────────────────────────────────────────────

describe("peak live telemetry is 2 laps", () => {
  test("each lap is decoded exactly once and never held past its reduce", async () => {
    const built = buildStreamingArm(SCATTERED);
    const tracker = trackingLoader(built.frames);
    const streamed = await streamArmSamples({
      label: "arm",
      metas: built.metas,
      metric: OUTCOME_METRICS.inputVarianceBrake,
      loadFrames: tracker.loadFrames,
      resolveCorners: async () => CORNERS,
    });

    // One decode per lap: the reference first, then every other lap once.
    expect(tracker.decoded.length).toBe(SCATTERED.length);
    expect(new Set(tracker.decoded).size).toBe(SCATTERED.length);
    // The reference is decoded before anything else — that ordering IS the
    // 2-lap bound: reference + the lap in hand, and nothing accumulates.
    const referenceId = tracker.decoded[0];
    expect(streamed.samples.map((s) => s.lapId)).not.toContain(referenceId);
    expect(streamed.framesDecoded).toBe(SCATTERED.length * FRAMES_PER_LAP);
  });

  test("a metric never sees a third lap: reduce is handed exactly two", async () => {
    const built = buildStreamingArm(SCATTERED);
    const seen: number[] = [];
    const spy: PairwiseFramesOutcomeMetric = {
      ...OUTCOME_METRICS.inputVarianceBrake,
      reduce: (input) => {
        seen.push(input.lap.id);
        expect(input.telemetry).not.toBe(input.referenceTelemetry);
        return OUTCOME_METRICS.inputVarianceBrake.reduce(input);
      },
    };

    await streamArmSamples({
      label: "arm",
      metas: built.metas,
      metric: spy,
      loadFrames: trackingLoader(built.frames).loadFrames,
      resolveCorners: async () => CORNERS,
    });

    expect(seen.length).toBe(SCATTERED.length - 1);
  });
});

// ── the frame budget reports what it drops ──────────────────────────────────

describe("frame budget", () => {
  test("selects the newest laps within budget and hands back the rest", () => {
    const built = buildStreamingArm(SCATTERED);
    // Room for 3 laps of 121 frames.
    const selection = selectWithinFrameBudget(built.metas, FRAMES_PER_LAP * 3);
    expect(selection.selected.length).toBe(3);
    expect(selection.dropped.length).toBe(SCATTERED.length - 3);
    expect(selection.frames).toBe(FRAMES_PER_LAP * 3);
    // Newest by lap number, not fastest by lap time.
    expect(selection.selected.map((m) => m.lapNumber)).toEqual([5, 6, 7]);
  });

  test("keeps the newest lap even when it alone exceeds the budget", () => {
    const built = buildStreamingArm(SCATTERED);
    const selection = selectWithinFrameBudget(built.metas, 1);
    expect(selection.selected.map((m) => m.lapNumber)).toEqual([7]);
    expect(selection.dropped.length).toBe(SCATTERED.length - 1);
  });

  test("a budget that trims REPORTS the drop; it never silently truncates", async () => {
    const metric = OUTCOME_METRICS.inputVarianceBrake;
    const built = buildStreamingArm(SCATTERED);
    const streamed = await streamArmSamples({
      label: "arm",
      metas: built.metas,
      metric,
      loadFrames: trackingLoader(built.frames).loadFrames,
      resolveCorners: async () => CORNERS,
      frameBudget: FRAMES_PER_LAP * 4,
    });

    expect(streamed.droppedByFrameBudget).toBe(3);
    expect(streamed.samples.length).toBe(3); // 4 decoded, minus the reference
    expect(streamed.framesDecoded).toBe(FRAMES_PER_LAP * 4);
    // rawLapCount still describes the whole stint, so n vs rawLapCount is honest.
    expect(streamed.rawLapCount).toBe(SCATTERED.length);

    // And it reaches the human-readable line, not just a field.
    const cmp = compareArmSamples(
      streamed,
      await streamArmSamples({
        label: "other",
        metas: buildStreamingArm(REPEATABLE, 100).metas,
        metric,
        loadFrames: trackingLoader(buildStreamingArm(REPEATABLE, 100).frames).loadFrames,
        resolveCorners: async () => CORNERS,
      }),
      metric,
    );
    expect(cmp.a.droppedByFrameBudget).toBe(3);
    expect(cmp.b.droppedByFrameBudget).toBe(0);
    expect(describeComparison(cmp)).toContain("frame budget: 3 on arm");
  });

  test("the default budget is generous enough that a normal stint never trims", async () => {
    // 300k frames is ~50 laps of a 100-second circuit at 60 Hz. A 7-lap arm of
    // 121-frame synthetic laps must be nowhere near it.
    expect(FRAME_BUDGET_PER_ARM).toBeGreaterThan(FRAMES_PER_LAP * SCATTERED.length);
    const built = buildStreamingArm(SCATTERED);
    const streamed = await streamArmSamples({
      label: "arm",
      metas: built.metas,
      metric: OUTCOME_METRICS.lineSpreadScore,
      loadFrames: trackingLoader(built.frames).loadFrames,
      resolveCorners: async () => CORNERS,
    });
    expect(streamed.droppedByFrameBudget).toBe(0);
  });
});
