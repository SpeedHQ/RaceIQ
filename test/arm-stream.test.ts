/**
 * Streaming equivalence for frame-based outcome metrics (issue #120, Phase 2).
 *
 * The whole point of `arm-stream.ts` is that it holds 2 laps of telemetry live
 * instead of the whole arm. That is only worth having if it computes the SAME
 * numbers as the in-memory path — so the central test here is an equivalence
 * assertion between `prepareArm` (all laps in memory) and `streamArmSamples`
 * (one lap at a time), on identical laps.
 *
 * No DB: frames arrive through an injected `LapFrameLoader`, which also lets the
 * peak-live-laps bound be *measured* rather than asserted by inspection.
 */

import { describe, expect, test } from "bun:test";
import { compareArmSamples, describeComparison, prepareArm } from "../server/ai/compare-arms";
import type { ArmInput } from "../server/ai/compare-arms";
import {
  FRAME_BUDGET_PER_ARM,
  type FrameLapMeta,
  type LapFrameLoader,
  selectWithinFrameBudget,
  streamArmSamples,
} from "../server/ai/arm-stream";
import { OUTCOME_METRICS, type PairwiseFramesOutcomeMetric } from "../server/ai/outcome-metrics";
import type { Corner } from "../server/corner-detection";
import type { TelemetryPacket } from "../shared/types";

// ── synthetic laps (same shape as test/compare-arms.test.ts) ────────────────

/** Straight-line lap (600m along Z) with one corner at 200..300m. */
function syntheticLap(lateralOffsetM: number, brakeShiftM: number): TelemetryPacket[] {
  const frames = 121;
  const step = 600 / (frames - 1);
  const packets: TelemetryPacket[] = [];
  for (let i = 0; i < frames; i++) {
    const distance = i * step;
    const inCorner = distance >= 200 && distance <= 300;
    const braking = distance >= 220 - brakeShiftM && distance <= 260 - brakeShiftM;
    packets.push({
      gameId: "f1-2025",
      IsRaceOn: 1,
      TimestampMS: i * 100,
      DistanceTraveled: distance,
      PositionX: inCorner ? lateralOffsetM : 0,
      PositionZ: distance,
      VelocityX: 0,
      VelocityY: 0,
      VelocityZ: step / 0.1,
      Gear: 3,
      Accel: braking ? 0 : 1,
      Brake: braking ? 1 : 0,
    } as TelemetryPacket);
  }
  return packets;
}

const CORNERS: Corner[] = [{ index: 1, label: "T1", distanceStart: 200, distanceEnd: 300 }];
const FRAMES_PER_LAP = 121;

/** Distinct, non-monotonic lap-time offsets — see `buildArm`. */
const LAP_TIME_OFFSETS = [0.32, 0.05, 0.71, 0.18, 0.94, 0.43, 0.6, 0.27, 0.85, 0.11];

interface LapSpec {
  lateral: number;
  brakeShift: number;
  /** Defaults to a clean, valid lap. */
  isValid?: boolean;
  /** Defaults to `FRAMES_PER_LAP`; 0 means "no telemetry stored". */
  rawFrameCount?: number;
}

/**
 * One arm as BOTH representations of the same laps: the in-memory `ArmInput` and
 * the metadata + loader pair the streaming path consumes. Anything that made the
 * two disagree by construction would defeat the equivalence test, so they are
 * built from a single spec list here.
 */
function buildArm(specs: LapSpec[], firstId = 1) {
  const frames = new Map<number, TelemetryPacket[]>();
  const metas: FrameLapMeta[] = [];
  const laps: ArmInput["laps"] = [];

  specs.forEach((spec, i) => {
    const id = firstId + i;
    const rawFrameCount = spec.rawFrameCount ?? FRAMES_PER_LAP;
    const lap = {
      id,
      // Deliberately scrambled and all-distinct, so the median-lap-time
      // reference pick is doing real work rather than landing on the middle
      // element of the input order (which would make this test pass even if the
      // two paths picked different references).
      lapTime: 90 + LAP_TIME_OFFSETS[i % LAP_TIME_OFFSETS.length],
      isValid: spec.isValid ?? true,
      invalidReason: null,
      tuningExcluded: false,
      tuningExcludedSource: null,
    };
    metas.push({ ...lap, lapNumber: i + 1, createdAt: `2026-01-01T00:0${i % 10}:00Z`, rawFrameCount });
    if (rawFrameCount > 0) frames.set(id, syntheticLap(spec.lateral, spec.brakeShift));
    laps.push({ lap, telemetry: rawFrameCount > 0 ? syntheticLap(spec.lateral, spec.brakeShift) : null });
  });

  return {
    inMemory: { label: "arm", laps, corners: CORNERS } satisfies ArmInput,
    metas,
    frames,
  };
}

/** A loader that records every decode, so peak live laps can be measured. */
function trackingLoader(frames: Map<number, TelemetryPacket[]>) {
  const decoded: number[] = [];
  const loadFrames: LapFrameLoader = async (lapId) => {
    decoded.push(lapId);
    return frames.get(lapId) ?? null;
  };
  return { loadFrames, decoded };
}

const SCATTERED: LapSpec[] = [
  { lateral: 0, brakeShift: 0 },
  { lateral: 3, brakeShift: 20 },
  { lateral: -3, brakeShift: -20 },
  { lateral: 2.5, brakeShift: 15 },
  { lateral: -2.5, brakeShift: -15 },
  { lateral: 1.5, brakeShift: 10 },
  { lateral: -1.2, brakeShift: -8 },
];
const REPEATABLE: LapSpec[] = Array.from({ length: 7 }, () => ({ lateral: 0, brakeShift: 0 }));

const FRAME_METRICS: PairwiseFramesOutcomeMetric[] = [
  OUTCOME_METRICS.inputVarianceBrake,
  OUTCOME_METRICS.inputVarianceThrottle,
  OUTCOME_METRICS.lineSpreadScore,
];

// ── the equivalence assertion ───────────────────────────────────────────────

describe("streaming produces the same samples as the in-memory path", () => {
  for (const metric of FRAME_METRICS) {
    test(`${metric.id}: identical samples, lap for lap`, async () => {
      const built = buildArm(SCATTERED);
      const expected = prepareArm(built.inMemory, metric);
      const streamed = await streamArmSamples({
        label: "arm",
        metas: built.metas,
        metric,
        loadFrames: trackingLoader(built.frames).loadFrames,
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
    const a = buildArm(SCATTERED, 1);
    const b = buildArm(REPEATABLE, 100);

    const inMemory = compareArmSamples(prepareArm(a.inMemory, metric), prepareArm(b.inMemory, metric), metric);
    const streamed = compareArmSamples(
      await streamArmSamples({
        label: "arm",
        metas: a.metas,
        metric,
        loadFrames: trackingLoader(a.frames).loadFrames,
        resolveCorners: async () => CORNERS,
      }),
      await streamArmSamples({
        label: "arm",
        metas: b.metas,
        metric,
        loadFrames: trackingLoader(b.frames).loadFrames,
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
    const built = buildArm(specs);
    const expected = prepareArm(built.inMemory, metric);
    const streamed = await streamArmSamples({
      label: "arm",
      metas: built.metas,
      metric,
      loadFrames: trackingLoader(built.frames).loadFrames,
      resolveCorners: async () => CORNERS,
    });

    expect(streamed.samples).toEqual(expected.samples);
    expect(streamed.pool.droppedIneligible).toBe(1);
    // 4 decodable laps, one of which is the reference.
    expect(streamed.samples.length).toBe(3);
  });
});

// ── the memory bound, measured ──────────────────────────────────────────────

describe("peak live telemetry is 2 laps", () => {
  test("each lap is decoded exactly once and never held past its reduce", async () => {
    const built = buildArm(SCATTERED);
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
    const built = buildArm(SCATTERED);
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
    const built = buildArm(SCATTERED);
    // Room for 3 laps of 121 frames.
    const selection = selectWithinFrameBudget(built.metas, FRAMES_PER_LAP * 3);
    expect(selection.selected.length).toBe(3);
    expect(selection.dropped.length).toBe(SCATTERED.length - 3);
    expect(selection.frames).toBe(FRAMES_PER_LAP * 3);
    // Newest by lap number, not fastest by lap time.
    expect(selection.selected.map((m) => m.lapNumber)).toEqual([5, 6, 7]);
  });

  test("keeps the newest lap even when it alone exceeds the budget", () => {
    const built = buildArm(SCATTERED);
    const selection = selectWithinFrameBudget(built.metas, 1);
    expect(selection.selected.map((m) => m.lapNumber)).toEqual([7]);
    expect(selection.dropped.length).toBe(SCATTERED.length - 1);
  });

  test("a budget that trims REPORTS the drop; it never silently truncates", async () => {
    const metric = OUTCOME_METRICS.inputVarianceBrake;
    const built = buildArm(SCATTERED);
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
        metas: buildArm(REPEATABLE, 100).metas,
        metric,
        loadFrames: trackingLoader(buildArm(REPEATABLE, 100).frames).loadFrames,
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
    const built = buildArm(SCATTERED);
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

// ── degenerate inputs ───────────────────────────────────────────────────────

describe("streaming degenerates safely", () => {
  const metric = OUTCOME_METRICS.inputVarianceBrake;

  test("no corners -> no samples, not a perfect arm", async () => {
    const built = buildArm(SCATTERED);
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
    const built = buildArm(SCATTERED);
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
    const built = buildArm([{ lateral: 0, brakeShift: 0 }, { lateral: 2, brakeShift: 5, rawFrameCount: 0 }]);
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
    const built = buildArm(SCATTERED);
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

/** The lap id `streamArmSamples` would pick as the reference. */
function pickedReference(metas: FrameLapMeta[]): number {
  const byTime = [...metas].sort((a, b) => a.lapTime - b.lapTime || a.id - b.id);
  return byTime[Math.floor((byTime.length - 1) / 2)].id;
}
