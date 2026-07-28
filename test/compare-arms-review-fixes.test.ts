import { describe, expect, test } from "bun:test";
import {
  type ArmComparison,
  compareArms,
  describeComparison,
  holmAdjust,
  MIN_LAPS_PER_ARM,
  RECOMMENDED_LAPS_PER_ARM,
} from "../server/ai/compare-arms";
import {
  type ArmLap,
  blunderFence,
  blunderFencesForArms,
  type MetadataOutcomeMetric,
  OUTCOME_METRICS,
} from "../server/ai/outcome-metrics";
import type { EvaluableLap } from "../shared/review-laps";

/**
 * Regression guards for the review findings on PR #137.
 *
 * Each test here failed before its fix — they exist to pin the *reason*, not
 * just the current output, so a later refactor that reintroduces the defect
 * fails loudly instead of quietly changing a number nobody rechecks.
 */

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

const SPREAD = OUTCOME_METRICS.consistencySpreadSec as MetadataOutcomeMetric;
const PACE = OUTCOME_METRICS.lapTimeSec as MetadataOutcomeMetric;

describe("blunder fence: shared width, per-arm location", () => {
  const TIDY = [90.0, 90.05, 90.1, 90.05, 90.0, 94.0];
  const WIDE = [90.0, 92.0, 94.0, 96.0, 98.0, 110.0];

  test("a self-computed fence lets a wide arm off almost entirely", () => {
    // This is the defect. The wide arm's own IQR is large, so its own fence
    // climbs to the blunder itself and censors nothing, while the tidy arm is
    // held to 94.5. Two arms, two standards, compared as though they were one.
    expect(blunderFence(TIDY)).toBeCloseTo(94.5, 3);
    expect(blunderFence(WIDE)).toBeCloseTo(110.0, 3);
    expect((blunderFence(WIDE) as number) >= Math.max(...WIDE)).toBe(true);
  });

  test("pooling the raw lap times would be worse, not better", () => {
    // Documented so nobody 'simplifies' this back: flattening both arms folds
    // the between-arm difference into the spread and inflates the threshold.
    const naive = blunderFence([...TIDY, ...WIDE]) as number;
    const shared = blunderFencesForArms([TIDY, WIDE]);
    expect(naive).toBeGreaterThan(shared[0] as number);
    expect(naive).toBeGreaterThan(shared[1] as number);
  });

  test("centering first gives both arms the same width", () => {
    const [fTidy, fWide] = blunderFencesForArms([TIDY, WIDE]) as [number, number];

    // The wide arm is pulled in from its self-serving 110.0 and now actually
    // fences its blunder; the tidy arm moves only slightly.
    expect(fWide).toBeLessThan(blunderFence(WIDE) as number);
    expect(fWide).toBeLessThan(110.0);
    expect(fTidy).toBeGreaterThanOrEqual(blunderFence(TIDY) as number);

    // Each threshold still sits above its own arm's median — a blunder remains
    // relative to what that arm normally laps.
    expect(fTidy).toBeGreaterThan(90.05);
    expect(fWide).toBeGreaterThan(95.0);
  });

  test("the shared fence actually censors the wide arm's blunder", () => {
    const cmp = compareArms(arm(TIDY), arm(WIDE), SPREAD);
    expect(cmp.b.droppedOutliers).toBeGreaterThan(0);
  });

  test("too few laps overall means nobody is fenced", () => {
    expect(blunderFencesForArms([[90], [91]])).toEqual([null, null]);
  });
});

describe("bootstrap CI is not labelled 95% when it cannot support the claim", () => {
  test("ciReliable is false at the MIN_LAPS_PER_ARM floor", () => {
    const a = arm([90.0, 90.2, 90.4]);
    const b = arm([91.0, 91.2, 91.4]);
    const cmp = compareArms(a, b, PACE);

    expect(cmp.a.n).toBe(MIN_LAPS_PER_ARM);
    expect(cmp.ciReliable).toBe(false);
    // Still reported — it is the best summary available, just not a 95% claim.
    expect(cmp.ci).not.toBeNull();
    expect(describeComparison(cmp)).toContain("indicative range");
    expect(describeComparison(cmp)).not.toContain("95% CI");
  });

  test("ciReliable is true at the recommended lap count", () => {
    const a = arm(Array.from({ length: RECOMMENDED_LAPS_PER_ARM }, (_, i) => 90 + i * 0.1));
    const b = arm(Array.from({ length: RECOMMENDED_LAPS_PER_ARM }, (_, i) => 91 + i * 0.1));
    const cmp = compareArms(a, b, PACE);

    expect(cmp.ciReliable).toBe(true);
    expect(describeComparison(cmp)).toContain("95% CI");
  });
});

describe("Holm correction across the metrics shown for one arm pair", () => {
  const base = (p: number, id: string): ArmComparison =>
    ({
      metricId: id,
      metricLabel: id,
      unit: "s",
      direction: "lower-better",
      a: { label: "A", n: 8, mean: 90, sd: 0.2 } as ArmComparison["a"],
      b: { label: "B", n: 8, mean: 89.8, sd: 0.2 } as ArmComparison["b"],
      deltaMean: -0.2,
      ci: [-0.4, -0.05],
      ciReliable: true,
      pValue: p,
      effectSize: -0.8,
      significance: p < 0.05 ? "significant" : "not-significant",
      underpowered: false,
      favours: p < 0.05 ? "b" : null,
      reason: null,
    }) as ArmComparison;

  test("a family of one is unchanged", () => {
    const [only] = holmAdjust([base(0.04, "lapTimeSec")]);
    expect(only.significance).toBe("significant");
    expect(only.pValueAdjusted).toBeCloseTo(0.04, 10);
  });

  test("a marginal result does not survive five metrics", () => {
    // 0.04 alone clears alpha. Tested alongside four others it is the smallest
    // of five, so Holm scales it by 5 -> 0.20, and it stops being a finding.
    const family = holmAdjust([
      base(0.04, "lapTimeSec"),
      base(0.30, "consistencySpreadSec"),
      base(0.55, "inputVarianceBrake"),
      base(0.61, "inputVarianceThrottle"),
      base(0.90, "lineSpreadScore"),
    ]);

    const pace = family.find((c) => c.metricId === "lapTimeSec");
    expect(pace?.pValueAdjusted).toBeCloseTo(0.2, 10);
    expect(pace?.significance).toBe("not-significant");
    expect(pace?.favours).toBeNull();
    expect(pace?.reason).toContain("5 metrics");
    // The raw p is preserved — the correction annotates, it does not overwrite.
    expect(pace?.pValue).toBeCloseTo(0.04, 10);
  });

  test("a strong result survives the same family", () => {
    const family = holmAdjust([
      base(0.0001, "lapTimeSec"),
      base(0.30, "consistencySpreadSec"),
      base(0.55, "inputVarianceBrake"),
      base(0.61, "inputVarianceThrottle"),
      base(0.90, "lineSpreadScore"),
    ]);
    const pace = family.find((c) => c.metricId === "lapTimeSec");
    expect(pace?.significance).toBe("significant");
    expect(pace?.favours).toBe("b");
  });

  test("adjusted p values are monotone in the raw ordering", () => {
    const family = holmAdjust([base(0.01, "a"), base(0.02, "b"), base(0.03, "c")]);
    const sorted = [...family].sort((x, y) => (x.pValue ?? 1) - (y.pValue ?? 1));
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i].pValueAdjusted ?? 1).toBeGreaterThanOrEqual(sorted[i - 1].pValueAdjusted ?? 1);
    }
  });
});
