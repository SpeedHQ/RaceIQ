import { describe, expect, test } from "bun:test";
import { compareArmSamples, describeComparison, prepareArm } from "../../../server/experiments/comparison/compare";
import {
  streamArmSamples,
} from "../../../server/experiments/comparison/stream";
import { OUTCOME_METRICS } from "../../../server/experiments/comparison/metrics";
import type { FrameLapMeta } from "../../../server/experiments/comparison/stream";
import type { TelemetryPacket } from "../../../shared/telemetry/types";
import { buildStreamingArm, CORNERS, type LapSpec, REPEATABLE, SCATTERED, trackingLoader, FRAMES_PER_LAP } from "../../support/experiments/arms";

// ── degenerate inputs ───────────────────────────────────────────────────────

describe("streaming degenerates safely", () => {
  const metric = OUTCOME_METRICS.inputVarianceBrake;

  test("no corners -> no samples, not a perfect arm", async () => {
    const built = buildStreamingArm(SCATTERED);
    const streamed = await streamArmSamples({
      label: "arm",
      metas: built.metas,
      metric,
      loadFrames: trackingLoader(built.frames).loadFrames,
      resolveCorners: async () => [],
    });
    // computeLapConsistencyDelta returns an all-zero delta without corners; a
    // zero-variance arm would read as flawless consistency, so yield nothing.
    expect(streamed.samples).toEqual([]);
  });

  test("corner detection is offered the reference lap's frames", async () => {
    const built = buildStreamingArm(SCATTERED);
    let offered: TelemetryPacket[] | null = null;
    await streamArmSamples({
      label: "arm",
      metas: built.metas,
      metric,
      loadFrames: trackingLoader(built.frames).loadFrames,
      resolveCorners: async (referenceTelemetry) => {
        offered = referenceTelemetry;
        return CORNERS;
      },
    });
    expect(offered).not.toBeNull();
    expect(offered!.length).toBe(FRAMES_PER_LAP);
  });

  test("one decodable lap cannot be paired, so it yields nothing", async () => {
    const built = buildStreamingArm([{ lateral: 0, brakeShift: 0 }, { lateral: 2, brakeShift: 5, rawFrameCount: 0 }]);
    const streamed = await streamArmSamples({
      label: "arm",
      metas: built.metas,
      metric,
      loadFrames: trackingLoader(built.frames).loadFrames,
      resolveCorners: async () => CORNERS,
    });
    expect(streamed.samples).toEqual([]);
    expect(streamed.framesDecoded).toBeNull();
  });

  test("a lap whose decode fails is skipped, and a failing reference falls through", async () => {
    const built = buildStreamingArm(SCATTERED);
    const expected = prepareArm(built.inMemory, metric);
    // Break the lap the median pick would land on; the next-nearest becomes the
    // reference, so the arm still measures rather than collapsing to zero.
    const referenceId = expected.pool.kept.length > 0 ? pickedReference(built.metas) : 0;
    const frames = new Map(built.frames);
    frames.delete(referenceId);

    const streamed = await streamArmSamples({
      label: "arm",
      metas: built.metas,
      metric,
      loadFrames: async (id) => frames.get(id) ?? null,
      resolveCorners: async () => CORNERS,
    });

    expect(streamed.samples.length).toBe(SCATTERED.length - 2);
    expect(streamed.samples.map((s) => s.lapId)).not.toContain(referenceId);
  });
});

// ── the OTHER way a sample falls short of the pool ──────────────────────────
//
// A budget drop is a choice the loader made; a lap with no usable frames could
// never have counted. Both make `n` smaller than the curated pool, so both have
// to be visible — a driver reading "n=4" over a 7-lap stint must be able to see
// where the other 3 went, and the two causes have different remedies.

describe("laps with no usable telemetry are counted, not silently filtered", () => {
  const metric = OUTCOME_METRICS.inputVarianceBrake;
  /** 7 laps, 2 of which never had frames stored. */
  const WITH_GAPS: LapSpec[] = SCATTERED.map((spec, i) => (i === 1 || i === 4 ? { ...spec, rawFrameCount: 0 } : spec));

  test("streaming reports them, separately from a budget drop", async () => {
    const built = buildStreamingArm(WITH_GAPS);
    const streamed = await streamArmSamples({
      label: "arm",
      metas: built.metas,
      metric,
      loadFrames: trackingLoader(built.frames).loadFrames,
      resolveCorners: async () => CORNERS,
    });

    expect(streamed.droppedNoTelemetry).toBe(2);
    // Nothing was budget-trimmed: the shortfall must not be blamed on the cap.
    expect(streamed.droppedByFrameBudget).toBe(0);
    // 5 decodable laps, minus the reference.
    expect(streamed.samples.length).toBe(4);
    expect(streamed.rawLapCount).toBe(WITH_GAPS.length);
  });

  test("the in-memory path agrees, so the two paths disclose the same shortfall", () => {
    const built = buildStreamingArm(WITH_GAPS);
    const streamedInput = built.inMemory;
    expect(prepareArm(streamedInput, metric).droppedNoTelemetry).toBe(2);
  });

  test("a lap whose row promises frames the store cannot produce counts too", async () => {
    const built = buildStreamingArm(SCATTERED);
    const frames = new Map(built.frames);
    // Row says FRAMES_PER_LAP; the loader returns nothing. Not a budget drop.
    const missingId = built.metas.find((m) => m.id !== pickedReference(built.metas))!.id;
    frames.delete(missingId);

    const streamed = await streamArmSamples({
      label: "arm",
      metas: built.metas,
      metric,
      loadFrames: async (id) => frames.get(id) ?? null,
      resolveCorners: async () => CORNERS,
    });

    expect(streamed.droppedNoTelemetry).toBe(1);
    expect(streamed.samples.map((s) => s.lapId)).not.toContain(missingId);
  });

  test("it reaches the human-readable line, not just a field", async () => {
    const withGaps = buildStreamingArm(WITH_GAPS);
    const clean = buildStreamingArm(REPEATABLE, 100);
    const cmp = compareArmSamples(
      await streamArmSamples({
        label: "arm",
        metas: withGaps.metas,
        metric,
        loadFrames: trackingLoader(withGaps.frames).loadFrames,
        resolveCorners: async () => CORNERS,
      }),
      await streamArmSamples({
        label: "other",
        metas: clean.metas,
        metric,
        loadFrames: trackingLoader(clean.frames).loadFrames,
        resolveCorners: async () => CORNERS,
      }),
      metric,
    );

    expect(cmp.a.droppedNoTelemetry).toBe(2);
    expect(cmp.b.droppedNoTelemetry).toBe(0);
    const line = describeComparison(cmp);
    expect(line).toContain("laps without usable telemetry: 2 on arm");
    // The two causes stay distinguishable in the prose.
    expect(line).not.toContain("frame budget");
  });
});

/** The lap id `streamArmSamples` would pick as the reference. */
function pickedReference(metas: FrameLapMeta[]): number {
  const byTime = [...metas].sort((a, b) => a.lapTime - b.lapTime || a.id - b.id);
  return byTime[Math.floor((byTime.length - 1) / 2)].id;
}

