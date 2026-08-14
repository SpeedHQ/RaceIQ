import { describe, expect, test } from "bun:test";
import { compareArms } from "../../../server/experiments/comparison/compare";
import { type CurationSpec, type MetadataOutcomeMetric, OUTCOME_METRICS } from "../../../server/experiments/comparison/metrics";
import { metadataArm, normals } from "../../support/experiments/arms";

const FASTEST_5: CurationSpec = { mode: "fastest-n", n: 5, outlierRule: "none", requiredPolicyIds: ["normal-pace"] };
function paceWith(curation: CurationSpec): MetadataOutcomeMetric {
  return { ...OUTCOME_METRICS.lapTimeSec, curation };
}

// ── detection ───────────────────────────────────────────────────────────────

describe("compareArms on lap time", () => {
  test("detects a real 0.4s gain", () => {
    const cmp = compareArms(
      metadataArm(normals(10, 90.0, 0.12, 101)),
      metadataArm(normals(10, 89.6, 0.12, 202)),
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
      metadataArm(normals(12, 90.0, 0.2, 909)),
      metadataArm(normals(12, 90.0, 0.2, 808)),
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
          metadataArm(normals(12, 90.0, 0.2, seed * 7)),
          metadataArm(normals(12, 90.0, 0.2, seed * 7 + 3)),
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
    const cmp = compareArms(metadataArm(normals(10, 90.0, 0.12, 101)), metadataArm(normals(10, 89.6, 0.12, 202)), higherBetter);
    expect(cmp.significance).toBe("significant");
    expect(cmp.favours).toBe("a");
  });
});

describe("compareArms on lap-time variance", () => {
  test("detects a genuine consistency improvement", () => {
    // Same pace, half the spread. A lap-time comparison would see nothing.
    const loose = normals(14, 90.0, 0.5, 505);
    const tight = normals(14, 90.0, 0.12, 606);

    const variance = compareArms(metadataArm(loose), metadataArm(tight), OUTCOME_METRICS.consistencySpreadSec);
    expect(variance.significance).toBe("significant");
    expect(variance.favours).toBe("b");
    expect(variance.deltaMean!).toBeLessThan(0);

    // The shipped lap-time metric sees nothing — the two arms have the same mean
    // lap time, which is the point: a consistency experiment's outcome is not
    // expressible as a lap-time comparison.
    const pace = compareArms(metadataArm(loose), metadataArm(tight), OUTCOME_METRICS.lapTimeSec);
    expect(pace.significance).toBe("not-significant");
    expect(pace.favours).toBeNull();

    // Fastest-N on the identical laps is worse than blind: it keeps the loose
    // arm's luckiest 5 laps, so the LESS consistent arm reads as measurably
    // faster. A wrong answer with a p-value attached — the second reason
    // lapTimeSec no longer uses this policy.
    const trimmedPace = compareArms(metadataArm(loose), metadataArm(tight), paceWith(FASTEST_5));
    expect(trimmedPace.a.mean!).toBeLessThan(trimmedPace.b.mean!);
    expect(trimmedPace.significance).toBe("significant");
    expect(trimmedPace.favours).toBe("a");
  });
});
