import { describe, expect, test } from "bun:test";
import {
  bootstrapMeanDiffCI,
  compareArms,
  hedgesG,
  MIN_LAPS_PER_ARM,
  RECOMMENDED_LAPS_PER_ARM,
  mean,
  sampleVariance,
  welchTTest,
} from "../../../server/experiments/comparison/compare";
import { OUTCOME_METRICS } from "../../../server/experiments/comparison/metrics";
import { metadataArm, normals } from "../../support/experiments/arms";


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
    const cmp = compareArms(metadataArm([90.0, 90.2]), metadataArm([89.0, 89.1]), OUTCOME_METRICS.lapTimeSec);

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
    const cmp = compareArms(metadataArm(normals(10, 90, 0.15, 1)), metadataArm([89.0, 89.1]), OUTCOME_METRICS.lapTimeSec);
    expect(cmp.significance).toBe("inconclusive");
    expect(cmp.reason).toContain("arm B");
  });

  test("an empty arm is inconclusive with a null delta", () => {
    const cmp = compareArms(metadataArm([]), metadataArm(normals(6, 90, 0.15, 2)), OUTCOME_METRICS.lapTimeSec);
    expect(cmp.significance).toBe("inconclusive");
    expect(cmp.deltaMean).toBeNull();
    expect(cmp.a.mean).toBeNull();
  });

  test("both arms metronomic (zero variance) -> inconclusive, not p = 0", () => {
    const cmp = compareArms(metadataArm([90, 90, 90, 90]), metadataArm([90, 90, 90, 90]), OUTCOME_METRICS.lapTimeSec);
    expect(cmp.significance).toBe("inconclusive");
    expect(cmp.pValue).toBeNull();
    expect(cmp.reason).toContain("no variation");
  });

  test(`a null result under ${RECOMMENDED_LAPS_PER_ARM} laps is flagged as absence of evidence`, () => {
    const cmp = compareArms(metadataArm([90.0, 90.1, 90.2]), metadataArm([90.05, 90.15, 90.25]), OUTCOME_METRICS.lapTimeSec);
    expect(cmp.significance).toBe("not-significant");
    expect(cmp.underpowered).toBe(true);
    expect(cmp.reason).toContain("absence of evidence");
  });
});



