import { describe, expect, test } from "bun:test";
import {
  bootstrapMeanDiffCI,
  compareArms,
  describeComparison,
  hedgesG,
  MIN_LAPS_PER_ARM,
  RECOMMENDED_LAPS_PER_ARM,
  serializeComparison,
  welchTTest,
} from "../server/ai/compare-arms";
import { mean, sampleVariance } from "../server/ai/compare-arms";
import type { ArmInput } from "../server/ai/compare-arms";
import {
  type ArmLap,
  type CurationSpec,
  type MetadataOutcomeMetric,
  OUTCOME_METRICS,
} from "../server/ai/outcome-metrics";
import type { Corner } from "../server/corner-detection";
import type { EvaluableLap } from "../shared/review-laps";
import type { TelemetryPacket } from "../shared/types";

/**
 * The curation policy no shipped metric uses any more — see `lapTimeSec` in
 * server/ai/outcome-metrics.ts. It stays pinned here, applied explicitly, so the
 * *reasons* it was dropped keep being measured: it roughly doubles the
 * false-positive rate, and on a loose-vs-tight pair it misranks outright.
 */
const FASTEST_5: CurationSpec = { mode: "fastest-n", n: 5, outlierRule: "none" };

/** `lapTimeSec`'s samples under an arbitrary curation policy. */
function paceWith(curation: CurationSpec): MetadataOutcomeMetric {
  return { ...OUTCOME_METRICS.lapTimeSec, curation };
}

// ── synthetic distributions ─────────────────────────────────────────────────

/** Deterministic PRNG so every assertion below is reproducible. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller normal samples from a seeded stream. */
function normals(n: number, meanV: number, sd: number, seed: number): number[] {
  const rand = rng(seed);
  const out: number[] = [];
  while (out.length < n) {
    const u1 = Math.max(1e-12, rand());
    const u2 = rand();
    const r = Math.sqrt(-2 * Math.log(u1));
    out.push(meanV + sd * r * Math.cos(2 * Math.PI * u2));
    if (out.length < n) out.push(meanV + sd * r * Math.sin(2 * Math.PI * u2));
  }
  return out;
}

let nextId = 1;
function arm(lapTimes: number[]): { label: string; laps: ArmLap[] } {
  const laps: ArmLap[] = lapTimes.map((lapTime) => {
    const lap: EvaluableLap = {
      id: nextId++,
      lapTime,
      isValid: true,
      invalidReason: null,
      experimentExcluded: false,
      experimentExcludedSource: null,
    };
    return { lap, telemetry: null };
  });
  return { label: `arm-${laps[0]?.lap.id ?? 0}`, laps };
}

// ── stats primitives ────────────────────────────────────────────────────────

describe("stats primitives", () => {
  test("Welch's t-test on a textbook separation", () => {
    // means 3 vs 8, equal variances 2.5, n=5 each -> t = 5, df = 8.
    const res = welchTTest([1, 2, 3, 4, 5], [6, 7, 8, 9, 10]);
    expect(res.t).toBeCloseTo(5, 6);
    expect(res.df).toBeCloseTo(8, 6);
    expect(res.p).toBeGreaterThan(0);
    expect(res.p).toBeLessThan(0.002);
    expect(res.p).toBeCloseTo(0.00105, 4);
  });

  test("identical samples -> p = 1", () => {
    const res = welchTTest([1, 2, 3], [1, 2, 3]);
    expect(res.p).toBeCloseTo(1, 6);
  });

  test("constant samples in both arms -> se = 0 (caller must treat as inconclusive)", () => {
    expect(welchTTest([5, 5, 5], [5, 5, 5]).se).toBe(0);
  });

  test("sampleVariance is the unbiased (n-1) estimator", () => {
    expect(mean([1, 2, 3])).toBe(2);
    expect(sampleVariance([1, 2, 3])).toBe(1);
    expect(sampleVariance([4])).toBe(0);
  });

  test("Hedges' g is signed like b - a and shrinks for small samples", () => {
    const g = hedgesG([1, 2, 3, 4, 5], [6, 7, 8, 9, 10]);
    expect(g).not.toBeNull();
    expect(g!).toBeGreaterThan(2.5);
    expect(g!).toBeLessThan(3.163); // uncorrected d = 5/sqrt(2.5) ≈ 3.162
    expect(hedgesG([1], [2])).toBeNull();
  });

  test("bootstrap CI is deterministic and brackets the observed difference", () => {
    const a = normals(20, 0, 1, 11);
    const b = normals(20, 2, 1, 22);
    const first = bootstrapMeanDiffCI(a, b);
    const second = bootstrapMeanDiffCI(a, b);
    expect(first).toEqual(second);
    const observed = mean(b) - mean(a);
    expect(first![0]).toBeLessThan(observed);
    expect(first![1]).toBeGreaterThan(observed);
    expect(first![0]).toBeGreaterThan(0); // excludes zero for a real 2-sigma shift
  });
});

// ── the guardrail ───────────────────────────────────────────────────────────

describe("compareArms guardrail", () => {
  test(`under ${MIN_LAPS_PER_ARM} laps per arm -> inconclusive, never a confident call`, () => {
    const cmp = compareArms(arm([90.0, 90.2]), arm([89.0, 89.1]), OUTCOME_METRICS.lapTimeSec);

    expect(cmp.significance).toBe("inconclusive");
    expect(cmp.underpowered).toBe(true);
    expect(cmp.favours).toBeNull();
    expect(cmp.pValue).toBeNull();
    expect(cmp.ci).toBeNull();
    expect(cmp.effectSize).toBeNull();
    expect(cmp.reason).toContain(`at least ${MIN_LAPS_PER_ARM} laps per arm`);
    // The descriptive delta survives — it just carries no claim.
    expect(cmp.deltaMean).toBeCloseTo(-1.05, 6);
  });

  test("one healthy arm does not rescue a thin one", () => {
    const cmp = compareArms(arm(normals(10, 90, 0.15, 1)), arm([89.0, 89.1]), OUTCOME_METRICS.lapTimeSec);
    expect(cmp.significance).toBe("inconclusive");
    expect(cmp.reason).toContain("arm B");
  });

  test("an empty arm is inconclusive with a null delta", () => {
    const cmp = compareArms(arm([]), arm(normals(6, 90, 0.15, 2)), OUTCOME_METRICS.lapTimeSec);
    expect(cmp.significance).toBe("inconclusive");
    expect(cmp.deltaMean).toBeNull();
    expect(cmp.a.mean).toBeNull();
  });

  test("both arms metronomic (zero variance) -> inconclusive, not p = 0", () => {
    const cmp = compareArms(arm([90, 90, 90, 90]), arm([90, 90, 90, 90]), OUTCOME_METRICS.lapTimeSec);
    expect(cmp.significance).toBe("inconclusive");
    expect(cmp.pValue).toBeNull();
    expect(cmp.reason).toContain("no variation");
  });

  test(`a null result under ${RECOMMENDED_LAPS_PER_ARM} laps is flagged as absence of evidence`, () => {
    const cmp = compareArms(arm([90.0, 90.1, 90.2]), arm([90.05, 90.15, 90.25]), OUTCOME_METRICS.lapTimeSec);
    expect(cmp.significance).toBe("not-significant");
    expect(cmp.underpowered).toBe(true);
    expect(cmp.reason).toContain("absence of evidence");
  });
});

// ── detection ───────────────────────────────────────────────────────────────

describe("compareArms on lap time", () => {
  test("detects a real 0.4s gain", () => {
    const cmp = compareArms(
      arm(normals(10, 90.0, 0.12, 101)),
      arm(normals(10, 89.6, 0.12, 202)),
      OUTCOME_METRICS.lapTimeSec,
    );

    expect(cmp.significance).toBe("significant");
    expect(cmp.underpowered).toBe(false);
    expect(cmp.favours).toBe("b");
    expect(cmp.pValue!).toBeLessThan(0.05);
    expect(cmp.deltaMean!).toBeLessThan(-0.2);
    expect(cmp.ci![1]).toBeLessThan(0); // CI entirely on the faster side
    expect(cmp.effectSize!).toBeLessThan(-1);
    expect(cmp.reason).toBeNull();
  });

  test("reports no difference when both arms draw from the same distribution", () => {
    const cmp = compareArms(
      arm(normals(12, 90.0, 0.2, 909)),
      arm(normals(12, 90.0, 0.2, 808)),
      OUTCOME_METRICS.lapTimeSec,
    );

    expect(cmp.significance).toBe("not-significant");
    expect(cmp.favours).toBeNull();
    expect(cmp.underpowered).toBe(false);
    expect(cmp.pValue!).toBeGreaterThan(0.05);
    expect(cmp.ci![0]).toBeLessThan(0);
    expect(cmp.ci![1]).toBeGreaterThan(0); // CI straddles zero
  });

  test("the false-positive rate sits near alpha, and fastest-N is why it used to not", () => {
    // 60 independent null experiments. A single seed proves nothing about a
    // test's calibration; the false-positive rate does. At alpha = 0.05 a
    // correctly calibrated test flags ~3 of these 60.
    const falsePositiveRate = (curation: CurationSpec) => {
      let falsePositives = 0;
      for (let seed = 1; seed <= 60; seed++) {
        const cmp = compareArms(
          arm(normals(12, 90.0, 0.2, seed * 7)),
          arm(normals(12, 90.0, 0.2, seed * 7 + 3)),
          paceWith(curation),
        );
        if (cmp.significance === "significant") falsePositives++;
      }
      return falsePositives / 60;
    };

    // The shipped policy: every eligible lap, i.e. the iid sample Welch assumes.
    // 2/60 here; 4.75% over 400 seeds, against a nominal alpha of 5%.
    const shipped = falsePositiveRate(OUTCOME_METRICS.lapTimeSec.curation);
    expect(shipped).toBeLessThanOrEqual(0.1);

    // The old policy, on the identical draws: fastest-N keeps order statistics,
    // which deflates each arm's within-arm spread, so the same null data reads
    // as a finding far more often — 5/60 here, 12.25% over 400 seeds, i.e. ~2.6x
    // nominal. That is the defect that moved lapTimeSec off fastest-N; it is not
    // a property of the t-test.
    const trimmed = falsePositiveRate(FASTEST_5);
    expect(trimmed).toBeGreaterThanOrEqual(shipped * 2);
  });

  test("higher-better metrics flip which arm a difference points at", () => {
    const higherBetter: MetadataOutcomeMetric = { ...OUTCOME_METRICS.lapTimeSec, direction: "higher-better" };
    const cmp = compareArms(arm(normals(10, 90.0, 0.12, 101)), arm(normals(10, 89.6, 0.12, 202)), higherBetter);
    expect(cmp.significance).toBe("significant");
    expect(cmp.favours).toBe("a");
  });
});

describe("compareArms on lap-time variance", () => {
  test("detects a genuine consistency improvement", () => {
    // Same pace, half the spread. A lap-time comparison would see nothing.
    const loose = normals(14, 90.0, 0.5, 505);
    const tight = normals(14, 90.0, 0.12, 606);

    const variance = compareArms(arm(loose), arm(tight), OUTCOME_METRICS.consistencySpreadSec);
    expect(variance.significance).toBe("significant");
    expect(variance.favours).toBe("b");
    expect(variance.deltaMean!).toBeLessThan(0);

    // The shipped lap-time metric sees nothing — the two arms have the same mean
    // lap time, which is the point: a consistency experiment's outcome is not
    // expressible as a lap-time comparison.
    const pace = compareArms(arm(loose), arm(tight), OUTCOME_METRICS.lapTimeSec);
    expect(pace.significance).toBe("not-significant");
    expect(pace.favours).toBeNull();

    // Fastest-N on the identical laps is worse than blind: it keeps the loose
    // arm's luckiest 5 laps, so the LESS consistent arm reads as measurably
    // faster. A wrong answer with a p-value attached — the second reason
    // lapTimeSec no longer uses this policy.
    const trimmedPace = compareArms(arm(loose), arm(tight), paceWith(FASTEST_5));
    expect(trimmedPace.a.mean!).toBeLessThan(trimmedPace.b.mean!);
    expect(trimmedPace.significance).toBe("significant");
    expect(trimmedPace.favours).toBe("a");
  });
});

// ── the curation split (the bug this phase fixes) ───────────────────────────

describe("curation is per-metric, inside compareArms", () => {
  const stintA = [90.0, 90.05, 90.1, 90.15, 90.2, 90.6, 90.9, 91.3, 91.7, 92.1, 92.4, 92.8];
  const stintB = [90.0, 90.06, 90.12, 90.18, 90.24, 90.3, 90.36, 90.42, 90.48, 90.54, 90.6, 90.66];

  test("both shipped metrics see every eligible lap; only an explicit cap trims", () => {
    for (const metric of [OUTCOME_METRICS.lapTimeSec, OUTCOME_METRICS.consistencySpreadSec]) {
      const cmp = compareArms(arm(stintA), arm(stintB), metric);
      expect(cmp.a.n).toBe(12);
      expect(cmp.b.n).toBe(12);
      expect(cmp.a.droppedByCap).toBe(0);
      expect(cmp.a.droppedByFrameBudget).toBe(0);
      expect(cmp.a.curationMode).toBe("all-valid");
    }

    const trimmed = compareArms(arm(stintA), arm(stintB), paceWith(FASTEST_5));
    expect(trimmed.a.n).toBe(5);
    expect(trimmed.a.droppedByCap).toBe(7);
    expect(trimmed.a.curationMode).toBe("fastest-n");
  });

  test("fastest-N on a variance metric would erase the very difference being measured", () => {
    // Arm A's spread lives in its tail; arm B is uniformly tight. Judged over
    // all laps, A is measurably less consistent. Judged over each arm's fastest
    // 5, both look identical — the tail is gone. This is exactly why the
    // fastest-5 auto-exclude pass must not own a variance experiment's pool.
    const honest = compareArms(arm(stintA), arm(stintB), OUTCOME_METRICS.consistencySpreadSec);
    const truncated = compareArms(arm(stintA), arm(stintB), {
      ...OUTCOME_METRICS.consistencySpreadSec,
      curation: FASTEST_5,
    });

    expect(honest.significance).toBe("significant");
    expect(honest.favours).toBe("b");

    // Truncation shrinks the measured deviation of the loose arm by an order of
    // magnitude and hides the difference.
    expect(truncated.a.mean!).toBeLessThan(honest.a.mean! / 5);
    expect(truncated.significance).not.toBe("significant");
  });

  test("the fastest-N bias grows with lap count", () => {
    const grow = (laps: number) => {
      const times = Array.from({ length: laps }, (_, i) => 90 + i * 0.1);
      const all = compareArms(arm(times), arm(times), OUTCOME_METRICS.consistencySpreadSec);
      const trimmed = compareArms(arm(times), arm(times), {
        ...OUTCOME_METRICS.consistencySpreadSec,
        curation: FASTEST_5,
      });
      return all.a.mean! / trimmed.a.mean!;
    };

    expect(grow(8)).toBeGreaterThan(1);
    expect(grow(20)).toBeGreaterThan(grow(8));
    expect(grow(40)).toBeGreaterThan(grow(20));
  });

  test("the blunder fence, not the cap, removes a spin from a variance pool", () => {
    const withSpin = compareArms(
      arm([90.0, 90.1, 90.2, 90.15, 90.25, 90.3, 104.0]),
      arm([90.0, 90.1, 90.2, 90.15, 90.25, 90.3, 90.2]),
      OUTCOME_METRICS.consistencySpreadSec,
    );
    expect(withSpin.a.droppedOutliers).toBe(1);
    expect(withSpin.a.n).toBe(6);
    expect(withSpin.b.droppedOutliers).toBe(0);
    expect(withSpin.b.n).toBe(7);
  });
});

// ── frame-based metrics ─────────────────────────────────────────────────────

/**
 * Synthetic straight-line lap (600m along Z) with one corner at 200..300m,
 * mirroring test/lap-consistency.test.ts. `lateralOffsetM` moves the line in
 * the corner, `brakeShiftM` moves the braking point earlier.
 */
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

const syntheticCorners: Corner[] = [{ index: 1, label: "T1", distanceStart: 200, distanceEnd: 300 }];

function telemetryArm(specs: { lateral: number; brakeShift: number }[]): ArmInput {
  const laps: ArmLap[] = specs.map((spec, i) => ({
    lap: {
      id: nextId++,
      lapTime: 90 + i * 0.05,
      isValid: true,
      invalidReason: null,
      experimentExcluded: false,
      experimentExcludedSource: null,
    },
    telemetry: syntheticLap(spec.lateral, spec.brakeShift),
  }));
  return { label: "telemetry-arm", laps, corners: syntheticCorners };
}

describe("frame-based metrics via computeLapConsistencyDelta", () => {
  const scattered = [
    { lateral: 0, brakeShift: 0 },
    { lateral: 3, brakeShift: 20 },
    { lateral: -3, brakeShift: -20 },
    { lateral: 2.5, brakeShift: 15 },
    { lateral: -2.5, brakeShift: -15 },
    { lateral: 1.5, brakeShift: 10 },
  ];
  const repeatable = Array.from({ length: 6 }, () => ({ lateral: 0, brakeShift: 0 }));

  test("brake input variance separates a scattered arm from a repeatable one", () => {
    const cmp = compareArms(telemetryArm(scattered), telemetryArm(repeatable), OUTCOME_METRICS.inputVarianceBrake);

    // The arm's median-lap-time lap is the reference and is not its own sample.
    expect(cmp.a.n).toBe(scattered.length - 1);
    expect(cmp.significance).toBe("significant");
    expect(cmp.favours).toBe("b");
    expect(cmp.a.mean!).toBeGreaterThan(cmp.b.mean!);
    expect(cmp.b.mean!).toBe(0);
  });

  test("line consistency is higher-better and points at the repeatable arm", () => {
    const cmp = compareArms(telemetryArm(scattered), telemetryArm(repeatable), OUTCOME_METRICS.lineSpreadScore);

    expect(cmp.direction).toBe("higher-better");
    expect(cmp.significance).toBe("significant");
    expect(cmp.favours).toBe("b");
    expect(cmp.deltaMean!).toBeGreaterThan(0);
    expect(cmp.b.mean!).toBe(100);
  });

  test("three telemetry laps is one sample short of the guardrail", () => {
    const cmp = compareArms(
      telemetryArm(scattered.slice(0, 3)),
      telemetryArm(repeatable.slice(0, 3)),
      OUTCOME_METRICS.inputVarianceBrake,
    );
    expect(cmp.a.n).toBe(2);
    expect(cmp.significance).toBe("inconclusive");
    expect(cmp.reason).toContain("measured laps");
  });
});

// ── reporting is a measurement, never a verdict ─────────────────────────────

describe("reporting", () => {
  test("describeComparison never claims the change was good", () => {
    const cmp = compareArms(
      arm(normals(10, 90.0, 0.12, 101)),
      arm(normals(10, 89.6, 0.12, 202)),
      OUTCOME_METRICS.lapTimeSec,
    );
    const text = describeComparison(cmp);
    expect(text).toContain("Distinguishable from noise");
    expect(text).toContain("driver's call");
    expect(text.toLowerCase()).not.toContain("better setup");
  });

  test("the comparison exposes no field named verdict", () => {
    const cmp = compareArms(arm([90, 90.1, 90.2]), arm([90, 90.1, 90.2]), OUTCOME_METRICS.lapTimeSec);
    expect(Object.keys(cmp)).not.toContain("verdict");
    expect(Object.keys(cmp)).toContain("significance");
  });

  test("serializeComparison is JSON-safe and keeps per-lap curation reasons", () => {
    const cmp = compareArms(
      arm([90.0, 90.1, 90.2, 90.3, 90.4, 90.5]),
      arm([90.0, 90.1, 90.2, 90.3, 90.4, 90.5]),
      OUTCOME_METRICS.lapTimeSec,
    );
    const json = JSON.parse(JSON.stringify(serializeComparison(cmp)));
    expect(json.a.lapReasons.length).toBe(6);
    // All six are `chosen` now — `lapTimeSec` no longer ranks any lap away.
    expect(json.a.lapReasons.filter((r: { reason: string }) => r.reason === "chosen").length).toBe(6);
    expect(json.summary).toContain("Lap time");
  });
});
