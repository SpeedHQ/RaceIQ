import { describe, expect, test } from "bun:test";
import { aggregateLapStyles, isCornering, medianAbsDeviation, MIN_CORNERING_FRAMES, quantile, summariseLapStyle, type LapStyleSummary } from "@shared/racing/analysis/laps/driving-style";
import { initGameAdapters } from "@shared/games/init";
import type { GameId } from "../../shared/games/ids";
import type { SemanticTelemetrySample } from "@shared/telemetry/replay/contracts";
import { semanticLapFrame } from "@shared/racing/analysis/laps/semantic-frame";

// Steering normalisation is the one genuinely game-dependent step, so the
// adapters have to exist before any lap is summarised.
initGameAdapters();

const DEG = Math.PI / 180;
const G = 9.81;
const RADIUS = 0.33;
const STEP_MS = 16;
const FM: GameId = "fm-2023";
/** fm-2023 centres steering at 127 over a range of 127 (see shared/games/fm-2023). */
const FM_CENTRE = 127;

interface Frame {
  /** km/h */
  speedKph: number;
  /** lateral g, right-positive */
  latG: number;
  frontSlipDeg: number;
  rearSlipDeg: number;
  /** rad/s — defaults to the steady-state path yaw rate (|Ay|·g / V). */
  yawRate?: number;
  /** normalised steering, −1 … +1. Encoded into the game's raw units. */
  steer?: number;
  /** rear wheel rotation (rad/s); defaults to free-rolling. Higher = wheelspin. */
  rearRot?: number;
}

function sample(f: Frame, i: number): SemanticTelemetrySample {
  const speed = f.speedKph / 3.6;
  const rotation = speed / RADIUS;
  const rearRotation = f.rearRot ?? rotation;
  return {
    sequence: String(i),
    observedAtMs: i * STEP_MS,
    values: {
      "motion.speed": speed,
      "motion.acceleration-x": -f.latG * G,
      "motion.angular-velocity-y": f.yawRate ?? (Math.abs(f.latG) * G) / Math.max(speed, 0.1),
      "tires.tire-slip-angle": [f.frontSlipDeg * DEG, f.frontSlipDeg * DEG, f.rearSlipDeg * DEG, f.rearSlipDeg * DEG],
      "tires.wheel-rotation-speed": [rotation, rotation, rearRotation, rearRotation],
      "inputs.steer": FM_CENTRE + (f.steer ?? 0) * 127,
      "inputs.accel": 0,
      "inputs.brake": 0,
    },
  };
}

/** `n` identical semantic samples. */
function run(n: number, f: Frame, offset = 0): SemanticTelemetrySample[] {
  return Array.from({ length: n }, (_, i) => sample(f, offset + i));
}

const STEADY: Frame = { speedKph: 120, latG: 1.0, frontSlipDeg: 4, rearSlipDeg: 4, steer: 0.3 };
const UNDERSTEER: Frame = { speedKph: 120, latG: 1.0, frontSlipDeg: 8, rearSlipDeg: 3, steer: 0.3 };
/** Yaw at twice the path rate → the body has clearly outrun the velocity vector. */
const OVERSTEER: Frame = {
  speedKph: 120,
  latG: 1.0,
  frontSlipDeg: 2,
  rearSlipDeg: 8,
  yawRate: (2 * (1.0 * G)) / (120 / 3.6),
  steer: -0.2,
};
/** Full-bore straight-line wheelspin: no lateral load at all, rear wheels spinning hard. */
const WHEELSPIN_STRAIGHT: Frame = { speedKph: 120, latG: 0.02, frontSlipDeg: 0, rearSlipDeg: 0, rearRot: (2.2 * (120 / 3.6)) / RADIUS, steer: 0 };

const LONG = MIN_CORNERING_FRAMES * 4;

describe("gating", () => {
  test("the cornering gate matches steerBalance's own floors", () => {
    expect(isCornering(semanticLapFrame(sample({ ...STEADY, latG: 0.23 }, 0)))).toBe(false);
    expect(isCornering(semanticLapFrame(sample({ ...STEADY, latG: 0.3 }, 0)))).toBe(true);
    // Below SPEED_FLOOR (5 m/s = 18 km/h) nothing is cornering, however bent.
    expect(isCornering(semanticLapFrame(sample({ ...STEADY, speedKph: 10, latG: 1.5 }, 0)))).toBe(false);
  });

  test("a lap with too few cornering frames reports itself unusable, not neutral", () => {
    const telemetry = [...run(MIN_CORNERING_FRAMES - 1, STEADY), ...run(400, WHEELSPIN_STRAIGHT, MIN_CORNERING_FRAMES)];
    const s = summariseLapStyle(telemetry, FM);
    expect(s.usable).toBe(false);
    expect(s.corneringFrames).toBe(MIN_CORNERING_FRAMES - 1);
    // Absent, not zero — a lap we could not measure must not claim perfect balance.
    expect(s.balanceMedianDeg).toBeUndefined();
    expect(s.gripUtilMedian).toBeUndefined();
    expect(s.controlLossFraction).toBeUndefined();
    expect(s.oversteerFraction).toBeUndefined();
  });

  test("an empty lap is unusable rather than an exception", () => {
    const s = summariseLapStyle([], FM);
    expect(s.usable).toBe(false);
    expect(s.frames).toBe(0);
    expect(s.corneringFrames).toBe(0);
  });

  test("straight-line wheelspin never reads as oversteer or control loss", () => {
    // Half the lap is a neutral corner, half is drive-wheel spin on a straight.
    const telemetry = [...run(LONG, STEADY), ...run(LONG, WHEELSPIN_STRAIGHT, LONG)];
    const s = summariseLapStyle(telemetry, FM);
    expect(s.usable).toBe(true);
    // Only the cornering half was measured at all.
    expect(s.corneringFrames).toBe(LONG);
    expect(s.oversteerFraction).toBe(0);
    expect(s.controlLossFraction).toBe(0);
    expect(s.balanceMedianDeg).toBeCloseTo(0, 6);
    // …and the spinning wheels did not inflate grip utilisation either.
    expect(s.gripUtilP95).toBeCloseTo(0.5, 2);
  });

  test("a lap that is nothing but straight-line wheelspin is unusable", () => {
    const s = summariseLapStyle(run(600, WHEELSPIN_STRAIGHT), FM);
    expect(s.usable).toBe(false);
    expect(s.corneringFrames).toBe(0);
  });
});

describe("grip utilisation", () => {
  test("a steady 4° of slip angle sits at half of peak grip", () => {
    // SLIP_ANGLE_PEAK_RAD is 8°, and the wheels are free-rolling, so 4°/8° = 0.5.
    const s = summariseLapStyle(run(LONG, STEADY), FM);
    expect(s.gripUtilMedian).toBeCloseTo(0.5, 3);
    expect(s.gripUtilP95).toBeCloseTo(0.5, 3);
  });

  test("1.0 means at the limit — an absolute claim, not a relative one", () => {
    const atLimit = summariseLapStyle(run(LONG, { ...STEADY, frontSlipDeg: 8, rearSlipDeg: 8 }), FM);
    expect(atLimit.gripUtilMedian).toBeCloseTo(1.0, 3);
    const past = summariseLapStyle(run(LONG, { ...STEADY, frontSlipDeg: 12, rearSlipDeg: 12 }), FM);
    expect(past.gripUtilMedian!).toBeGreaterThan(1.0);
  });

  test("p95 catches the committed frames a median hides", () => {
    // 90% of the corner at 3°, 10% leaning on it at 8°.
    const telemetry = [...run(LONG * 9, { ...STEADY, frontSlipDeg: 3, rearSlipDeg: 3 }), ...run(LONG, { ...STEADY, frontSlipDeg: 8, rearSlipDeg: 8 }, LONG * 9)];
    const s = summariseLapStyle(telemetry, FM);
    expect(s.gripUtilMedian).toBeCloseTo(0.375, 2);
    expect(s.gripUtilP95).toBeCloseTo(1.0, 2);
  });
});

describe("balance", () => {
  test("neutral cornering: median slip delta is ~0° and neither state dominates", () => {
    const s = summariseLapStyle(run(LONG, STEADY), FM);
    expect(s.balanceMedianDeg).toBeCloseTo(0, 6);
    expect(s.understeerFraction).toBe(0);
    expect(s.oversteerFraction).toBe(0);
  });

  test("understeer lap: positive slip delta in real degrees", () => {
    const s = summariseLapStyle(run(LONG, UNDERSTEER), FM);
    expect(s.balanceMedianDeg).toBeCloseTo(5, 3); // 8° front − 3° rear
    expect(s.understeerFraction).toBe(1);
    expect(s.oversteerFraction).toBe(0);
    // Understeer is not the rear letting go.
    expect(s.controlLossFraction).toBe(0);
  });

  test("oversteer lap: negative slip delta, and the yaw error is flagged as control loss", () => {
    const s = summariseLapStyle(run(LONG, OVERSTEER), FM);
    expect(s.balanceMedianDeg).toBeCloseTo(-6, 3); // 2° front − 8° rear
    expect(s.oversteerFraction).toBe(1);
    expect(s.understeerFraction).toBe(0);
    expect(s.controlLossFraction).toBe(1);
  });

  test("over-rotating yaw alone is not control loss when the front is the end sliding", () => {
    // Same excess yaw as the oversteer case, but the tyres say understeer.
    const yawRate = (2 * (1.0 * G)) / (120 / 3.6);
    const s = summariseLapStyle(run(LONG, { ...UNDERSTEER, yawRate }), FM);
    expect(s.controlLossFraction).toBe(0);
  });

  test("control loss is a fraction of cornering frames, not of the lap", () => {
    const telemetry = [...run(LONG, OVERSTEER), ...run(LONG, STEADY, LONG), ...run(LONG * 5, WHEELSPIN_STRAIGHT, LONG * 2)];
    const s = summariseLapStyle(telemetry, FM);
    expect(s.corneringFrames).toBe(LONG * 2);
    expect(s.controlLossFraction).toBeCloseTo(0.5, 6);
  });
});

describe("smoothness is variability, not magnitude", () => {
  test("a steady large slip angle is smooth; an oscillating one is not", () => {
    const steadyBig = summariseLapStyle(run(LONG, { ...STEADY, frontSlipDeg: 6, rearSlipDeg: 6 }), FM);
    expect(steadyBig.slipVariabilityDeg).toBeCloseTo(0, 6);

    // Same mean slip delta (0°), but sawing the balance between ±4°.
    const blocks: SemanticTelemetrySample[] = [];
    for (let b = 0; b < 12; b++) {
      const front = b % 2 === 0 ? 8 : 4;
      const rear = b % 2 === 0 ? 4 : 8;
      blocks.push(...run(20, { ...STEADY, frontSlipDeg: front, rearSlipDeg: rear }, blocks.length));
    }
    const oscillating = summariseLapStyle(blocks, FM);
    expect(oscillating.slipVariabilityDeg!).toBeGreaterThan(3);
  });

  test("holding the wheel still scores zero reversals per second", () => {
    const s = summariseLapStyle(run(LONG, STEADY), FM);
    expect(s.steerReversalsPerS).toBe(0);
  });

  test("sawing at the wheel raises the reversal rate", () => {
    const blocks: SemanticTelemetrySample[] = [];
    for (let b = 0; b < 12; b++) {
      blocks.push(...run(20, { ...STEADY, steer: b % 2 === 0 ? 0.4 : 0.1 }, blocks.length));
    }
    const s = summariseLapStyle(blocks, FM);
    // 11 direction changes over 240 frames × 16 ms ≈ 3.84 s.
    expect(s.steerReversalsPerS!).toBeGreaterThan(2);
  });

  test("movement below the deadband is quantisation, not an input", () => {
    const blocks: SemanticTelemetrySample[] = [];
    for (let b = 0; b < 12; b++) {
      blocks.push(...run(20, { ...STEADY, steer: b % 2 === 0 ? 0.3 : 0.29 }, blocks.length));
    }
    expect(summariseLapStyle(blocks, FM).steerReversalsPerS).toBe(0);
  });

  test("steering is undefined — not zero — for a game with no registered adapter", () => {
    const s = summariseLapStyle(run(LONG, STEADY), "not-a-game" as GameId);
    expect(s.steerReversalsPerS).toBeUndefined();
    // Everything not derived from steering is still measured.
    expect(s.usable).toBe(true);
    expect(s.gripUtilMedian).toBeCloseTo(0.5, 3);
  });
});

describe("determinism", () => {
  test("the same frames twice give a deeply equal summary", () => {
    const telemetry = [...run(LONG, UNDERSTEER), ...run(LONG, OVERSTEER, LONG), ...run(LONG, WHEELSPIN_STRAIGHT, LONG * 2)];
    expect(summariseLapStyle(telemetry, FM)).toEqual(summariseLapStyle(telemetry, FM));
  });
});

describe("aggregateLapStyles", () => {
  const s = (over: Partial<LapStyleSummary>): LapStyleSummary => ({
    frames: 1000,
    corneringFrames: 400,
    corneringSeconds: 6.4,
    usable: true,
    gripUtilMedian: 0.7,
    gripUtilP95: 1.05,
    balanceMedianDeg: 1,
    understeerFraction: 0.2,
    oversteerFraction: 0.05,
    controlLossFraction: 0.01,
    steerReversalsPerS: 1.2,
    slipVariabilityDeg: 0.8,
    ...over,
  });

  test("medians, so one excursion cannot redefine the driver", () => {
    const laps = [s({ controlLossFraction: 0.01 }), s({ controlLossFraction: 0.02 }), s({ controlLossFraction: 0.015 }), s({ controlLossFraction: 0.9 })];
    const agg = aggregateLapStyles(laps);
    expect(agg.controlLossFraction).toBeCloseTo(0.0175, 6); // mean would be 0.236
    expect(agg.lapsUsable).toBe(4);
  });

  test("unusable laps are excluded but still counted", () => {
    const agg = aggregateLapStyles([s({}), s({}), { frames: 100, corneringFrames: 2, corneringSeconds: 0.03, usable: false }]);
    expect(agg.lapsUsable).toBe(2);
    expect(agg.lapsConsidered).toBe(3);
    expect(agg.gripUtilMedian).toBe(0.7);
  });

  test("a field missing on some laps still aggregates from the rest", () => {
    const agg = aggregateLapStyles([s({ steerReversalsPerS: undefined }), s({ steerReversalsPerS: 2 }), s({ steerReversalsPerS: 4 })]);
    expect(agg.steerReversalsPerS).toBe(3);
    expect(agg.gripUtilMedian).toBe(0.7);
  });

  test("no usable laps leaves every field undefined rather than zero", () => {
    const agg = aggregateLapStyles([{ frames: 10, corneringFrames: 0, corneringSeconds: 0, usable: false }]);
    expect(agg.lapsUsable).toBe(0);
    expect(agg.gripUtilMedian).toBeUndefined();
    expect(agg.balanceMedianDeg).toBeUndefined();
    expect(agg.controlLossFraction).toBeUndefined();
  });

  test("an empty pool is not an error", () => {
    expect(aggregateLapStyles([])).toEqual({ lapsUsable: 0, lapsConsidered: 0 });
  });

  test("signed balance medians do not cancel understeer against oversteer dishonestly", () => {
    // Three understeering laps and two oversteering ones: the median is the
    // middle lap, not an average that lands on a fictitious "neutral".
    const agg = aggregateLapStyles([s({ balanceMedianDeg: 3 }), s({ balanceMedianDeg: 2.5 }), s({ balanceMedianDeg: 2 }), s({ balanceMedianDeg: -4 }), s({ balanceMedianDeg: -5 })]);
    expect(agg.balanceMedianDeg).toBe(2);
  });
});

describe("statistics helpers", () => {
  test("quantile interpolates and clamps", () => {
    expect(quantile([1, 2, 3, 4], 0)).toBe(1);
    expect(quantile([1, 2, 3, 4], 1)).toBe(4);
    expect(quantile([1, 2, 3, 4], 0.5)).toBeCloseTo(2.5, 6);
    expect(quantile([], 0.95)).toBeUndefined();
    expect(quantile([7], 0.95)).toBe(7);
  });

  test("MAD is blind to magnitude and resistant to a single spike", () => {
    expect(medianAbsDeviation([5, 5, 5, 5])).toBe(0);
    expect(medianAbsDeviation([100, 100, 100, 100])).toBe(0);
    expect(medianAbsDeviation([5, 5, 5, 5, 5, 500])).toBe(0);
    expect(medianAbsDeviation([])).toBeUndefined();
  });
});
