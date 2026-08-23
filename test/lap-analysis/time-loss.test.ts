import { describe, expect, test } from "bun:test";
import type { SemanticTelemetrySample } from "@shared/telemetry/replay/contracts";
import { semanticLapFrames, type SemanticLapFrame } from "@shared/racing/analysis/laps/semantic-frame";
import { frameDt } from "@shared/racing/analysis/laps/frame-time";
import { MIN_REPORTABLE_LOSS_S, accelDeficitLoss, buildAccelReference, reportableLoss, speedDeficitLoss, sumLosses } from "@shared/racing/analysis/laps/time-loss";

const RADIUS = 0.33;

interface Frame {
  /** m/s */
  speed: number;
  /** ms since session start */
  t: number;
  /** 0–255 */
  accel?: number;
  /** 0–255 */
  brake?: number;
  /** rear wheel rotation speed (rad/s); defaults to free-rolling. Higher = wheelspin. */
  rearRot?: number;
}

const STEP_MS = 16;
const STEP_S = STEP_MS / 1000;

function sample(f: Frame): SemanticTelemetrySample {
  const rotation = f.speed / RADIUS;
  const rearRotation = f.rearRot ?? rotation;
  return {
    sequence: String(f.t),
    observedAtMs: f.t,
    values: {
      "motion.speed": f.speed,
      "inputs.accel": f.accel ?? 0,
      "inputs.brake": f.brake ?? 0,
      "inputs.steer": 0,
      "tires.wheel-rotation-speed": [rotation, rotation, rearRotation, rearRotation],
    },
  };
}

function frames(samples: readonly SemanticTelemetrySample[]): SemanticLapFrame[] {
  return semanticLapFrames(samples);
}

/** Constant-speed semantic lap of `n` samples. */
function steady(speed: number, n: number, opts: Partial<Frame> = {}): SemanticLapFrame[] {
  return frames(Array.from({ length: n }, (_, i) => sample({ speed, t: i * STEP_MS, ...opts })));
}

/** Semantic lap of `n` samples accelerating at `a` m/s² from `v0`. */
function ramp(v0: number, a: number, n: number, opts: Partial<Frame> = {}): SemanticLapFrame[] {
  return frames(Array.from({ length: n }, (_, i) => sample({ speed: v0 + a * i * STEP_S, t: i * STEP_MS, ...opts })));
}

describe("frameDt", () => {
  test("derives real timesteps from semantic sample timestamps", () => {
    const dt = frameDt(frames([sample({ speed: 50, t: 0 }), sample({ speed: 50, t: 20 }), sample({ speed: 50, t: 40 })]));
    expect(dt[0]).toBeCloseTo(0.02, 6);
    expect(dt[1]).toBeCloseTo(0.02, 6);
  });

  test("last sample repeats the previous interval", () => {
    const dt = frameDt(frames([sample({ speed: 50, t: 0 }), sample({ speed: 50, t: 20 }), sample({ speed: 50, t: 40 })]));
    expect(dt[2]).toBeCloseTo(dt[1], 6);
  });

  test("falls back to 60 Hz for implausible deltas (clock artefacts, respawns)", () => {
    // 0 ms (duplicate timestamp) and 5 s (pause) are both rejected.
    const dt = frameDt(frames([sample({ speed: 50, t: 1000 }), sample({ speed: 50, t: 1000 }), sample({ speed: 50, t: 6000 }), sample({ speed: 50, t: 6016 })]));
    expect(dt[0]).toBeCloseTo(1 / 60, 6);
    expect(dt[1]).toBeCloseTo(1 / 60, 6);
    expect(dt[2]).toBeCloseTo(0.016, 6);
  });

  test("handles degenerate inputs", () => {
    expect(frameDt([])).toEqual([]);
    expect(frameDt(frames([sample({ speed: 10, t: 0 })]))).toEqual([1 / 60]);
  });
});

describe("speedDeficitLoss", () => {
  test("no loss when the window already ran at the reference speed", () => {
    const tel = steady(50, 60);
    const dt = frameDt(tel);
    expect(speedDeficitLoss(tel, dt, 0, 59, 50)).toBeCloseTo(0, 6);
  });

  test("quantifies an over-slowed window against the speed the driver could have held", () => {
    // 1 s at 45 m/s where 50 m/s was available: 45 m covered, which at 50 m/s
    // takes 0.9 s → 0.1 s lost.
    const tel = steady(45, 61);
    const dt = frameDt(tel);
    expect(speedDeficitLoss(tel, dt, 0, 59, 50)).toBeCloseTo(0.1, 2);
  });

  test("a window faster than the reference is not a negative loss", () => {
    const tel = steady(60, 60);
    const dt = frameDt(tel);
    expect(speedDeficitLoss(tel, dt, 0, 59, 50)).toBe(0);
  });

  test("loss can never exceed the duration of the window itself", () => {
    const tel = steady(0.001, 60);
    const dt = frameDt(tel);
    const loss = speedDeficitLoss(tel, dt, 0, 59, 100);
    expect(loss).toBeLessThanOrEqual(1 + 1e-6);
  });

  test("guards degenerate ranges and references", () => {
    const tel = steady(45, 60);
    const dt = frameDt(tel);
    expect(speedDeficitLoss(tel, dt, 10, 10, 50)).toBe(0);
    expect(speedDeficitLoss(tel, dt, 20, 10, 50)).toBe(0);
    expect(speedDeficitLoss(tel, dt, 0, 59, 0)).toBe(0);
  });
});

describe("buildAccelReference", () => {
  test("bins median full-throttle acceleration by speed", () => {
    const tel = ramp(30, 4, 260, { accel: 255 });
    const ref = buildAccelReference(tel, frameDt(tel));
    // Starts in bin 3 (30–40 m/s) and climbs into bin 4.
    expect(ref.bins[3]).toBeCloseTo(4, 1);
    expect(ref.bins[4]).toBeCloseTo(4, 1);
  });

  test("ignores part-throttle, braking and wheelspin frames", () => {
    const partThrottle = ramp(30, 4, 120, { accel: 100 });
    const braking = ramp(30, 4, 120, { accel: 255, brake: 200 });
    // Driven wheels turning far faster than the fronts → "spin", not reference.
    const spinning = ramp(30, 4, 120, { accel: 255, rearRot: 400 });
    for (const tel of [partThrottle, braking, spinning]) {
      const ref = buildAccelReference(tel, frameDt(tel));
      expect(ref.bins[3]).toBeUndefined();
    }
  });

  test("leaves a bin unsupported when too few clean samples exist", () => {
    const tel = ramp(30, 4, 5, { accel: 255 });
    const ref = buildAccelReference(tel, frameDt(tel));
    expect(ref.bins[3]).toBeUndefined();
  });
});

describe("accelDeficitLoss", () => {
  test("no loss when the car already matched its own reference", () => {
    const tel = ramp(30, 4, 120, { accel: 255 });
    const dt = frameDt(tel);
    const ref = buildAccelReference(tel, dt);
    expect(accelDeficitLoss(tel, dt, 0, 60, ref)).toBeCloseTo(0, 2);
  });

  test("reports time lost when the car accelerated worse than it demonstrably can", () => {
    const strong = ramp(30, 4, 240, { accel: 255 });
    const ref = buildAccelReference(strong, frameDt(strong));
    // Same speed range, but only half the acceleration.
    const weak = ramp(30, 2, 120, { accel: 255 });
    const dt = frameDt(weak);
    const loss = accelDeficitLoss(weak, dt, 0, 119, ref);
    expect(loss).toBeDefined();
    expect(loss!).toBeGreaterThan(0.05);
    // Never more than the window itself took (2 s).
    expect(loss!).toBeLessThanOrEqual(2 + 1e-6);
  });

  test("returns undefined rather than extrapolating into unsupported speeds", () => {
    const strong = ramp(30, 4, 240, { accel: 255 });
    const ref = buildAccelReference(strong, frameDt(strong));
    const slow = ramp(2, 1, 120, { accel: 255 });
    expect(accelDeficitLoss(slow, frameDt(slow), 0, 119, ref)).toBeUndefined();
  });

  test("guards degenerate ranges", () => {
    const tel = ramp(30, 4, 120, { accel: 255 });
    const dt = frameDt(tel);
    const ref = buildAccelReference(tel, dt);
    expect(accelDeficitLoss(tel, dt, 10, 10, ref)).toBe(0);
    expect(accelDeficitLoss(tel, dt, 20, 10, ref)).toBe(0);
  });

  test("a stationary window covers no distance and cannot lose time", () => {
    const tel = steady(0, 60, { accel: 255 });
    const dt = frameDt(tel);
    const ref = buildAccelReference(ramp(30, 4, 240, { accel: 255 }), frameDt(ramp(30, 4, 240)));
    expect(accelDeficitLoss(tel, dt, 0, 59, ref)).toBe(0);
  });
});

describe("reportableLoss", () => {
  test("drops values indistinguishable from noise", () => {
    expect(reportableLoss(MIN_REPORTABLE_LOSS_S - 0.001)).toBeUndefined();
    expect(reportableLoss(0)).toBeUndefined();
    expect(reportableLoss(undefined)).toBeUndefined();
    expect(reportableLoss(Number.NaN)).toBeUndefined();
  });

  test("rounds survivors to hundredths", () => {
    expect(reportableLoss(0.1234)).toBe(0.12);
    expect(reportableLoss(1.239)).toBe(1.24);
    expect(reportableLoss(MIN_REPORTABLE_LOSS_S)).toBe(0.02);
  });
});

describe("sumLosses", () => {
  test("adds the quantified events and ignores the unquantified ones", () => {
    expect(sumLosses([0.1, undefined, 0.2])).toBeCloseTo(0.3, 6);
  });

  test("undefined when nothing could be quantified — not a confident zero", () => {
    expect(sumLosses([])).toBeUndefined();
    expect(sumLosses([undefined, undefined])).toBeUndefined();
  });

  test("all-zero losses still count as quantified", () => {
    expect(sumLosses([0, 0])).toBe(0);
  });
});
