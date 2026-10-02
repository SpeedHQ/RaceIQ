import { describe, expect, test } from "bun:test";
import { compareArms } from "../../../server/experiments/comparison/compare";
import { type CurationSpec, OUTCOME_METRICS } from "../../../server/experiments/comparison/metrics";
import { metadataArm } from "../../support/experiments/arms";

const FASTEST_5: CurationSpec = { mode: "fastest-n", n: 5, outlierRule: "none" };
function paceWith(curation: CurationSpec) {
  return { ...OUTCOME_METRICS.lapTimeSec, curation };
}

// ── the curation split (the bug this phase fixes) ───────────────────────────

describe("curation is per-metric, inside compareArms", () => {
  const stintA = [90.0, 90.05, 90.1, 90.15, 90.2, 90.6, 90.9, 91.3, 91.7, 92.1, 92.4, 92.8];
  const stintB = [90.0, 90.06, 90.12, 90.18, 90.24, 90.3, 90.36, 90.42, 90.48, 90.54, 90.6, 90.66];

  test("both shipped metrics see every eligible lap; only an explicit cap trims", () => {
    for (const metric of [OUTCOME_METRICS.lapTimeSec, OUTCOME_METRICS.consistencySpreadSec]) {
      const cmp = compareArms(metadataArm(stintA), metadataArm(stintB), metric);
      expect(cmp.a.n).toBe(12);
      expect(cmp.b.n).toBe(12);
      expect(cmp.a.droppedByCap).toBe(0);
      expect(cmp.a.droppedByFrameBudget).toBe(0);
      expect(cmp.a.curationMode).toBe("all-valid");
    }

    const trimmed = compareArms(metadataArm(stintA), metadataArm(stintB), paceWith(FASTEST_5));
    expect(trimmed.a.n).toBe(5);
    expect(trimmed.a.droppedByCap).toBe(7);
    expect(trimmed.a.curationMode).toBe("fastest-n");
  });

  test("fastest-N on a variance metric would erase the very difference being measured", () => {
    // Arm A's spread lives in its tail; arm B is uniformly tight. Judged over
    // all laps, A is measurably less consistent. Judged over each arm's fastest
    // 5, both look identical — the tail is gone. This is exactly why the
    // fastest-5 auto-exclude pass must not own a variance experiment's pool.
    const honest = compareArms(metadataArm(stintA), metadataArm(stintB), OUTCOME_METRICS.consistencySpreadSec);
    const truncated = compareArms(metadataArm(stintA), metadataArm(stintB), {
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
      const all = compareArms(metadataArm(times), metadataArm(times), OUTCOME_METRICS.consistencySpreadSec);
      const trimmed = compareArms(metadataArm(times), metadataArm(times), {
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
      metadataArm([90.0, 90.1, 90.2, 90.15, 90.25, 90.3, 104.0]),
      metadataArm([90.0, 90.1, 90.2, 90.15, 90.25, 90.3, 90.2]),
      OUTCOME_METRICS.consistencySpreadSec,
    );
    expect(withSpin.a.droppedOutliers).toBe(1);
    expect(withSpin.a.n).toBe(6);
    expect(withSpin.b.droppedOutliers).toBe(0);
    expect(withSpin.b.n).toBe(7);
  });
});
