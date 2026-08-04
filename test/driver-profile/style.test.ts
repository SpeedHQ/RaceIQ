import { describe, expect, test } from "bun:test";

import { ALL_DETECTOR_IDS, computeStyleAxes } from "../../server/driver-profile/detectors";
import { buildDriverFingerprint } from "../../server/driver-profile/fingerprint";
import { SCOPE, habitualDriver, insight, lap, styleLap, unusableLap } from "../support/driver-profile/factories";

describe("style axes", () => {
  test("braking style is bipolar and signed", () => {
    const early = buildDriverFingerprint({ scope: SCOPE, ...habitualDriver(6, [insight("driving-early-braking"), insight("driving-over-slowing")]) });
    const late = buildDriverFingerprint({ scope: SCOPE, ...habitualDriver(6, [insight("driving-late-braking-overshoot"), insight("driving-brake-traction-loss")]) });
    expect(early.style!.brakingStyle).toBeLessThan(0);
    expect(late.style!.brakingStyle).toBeGreaterThan(0);
  });

  test("braking style stays bounded even when every detector fires critically", () => {
    const everything = ALL_DETECTOR_IDS.map((id) => insight(id, { severity: "critical" }));
    const fp = buildDriverFingerprint({ scope: SCOPE, ...habitualDriver(6, everything) });
    expect(Math.abs(fp.style!.brakingStyle)).toBeLessThanOrEqual(100);
  });

  test("consistency axis mirrors the pace consistency", () => {
    const axes = computeStyleAxes([], 87.5);
    expect(axes.consistency).toBe(87.5);
    expect(computeStyleAxes([], null).consistency).toBeNull();
  });

  // ── Physics-based axes ──────────────────────────────────────────────
  // These no longer come from detector counts at all. They are medians of
  // per-lap continuous measurements, on scales where the numbers mean something
  // in themselves (1.0 = peak grip; degrees are degrees).

  test("grip utilisation is reported on the calibrated friction-circle scale, not rescaled", () => {
    const axes = computeStyleAxes([], null, [styleLap({ gripUtilMedian: 0.62 }), styleLap({ gripUtilMedian: 0.7 }), styleLap({ gripUtilMedian: 0.78 })]);
    expect(axes.gripUtilMedian).toBe(0.7);
    expect(axes.physicsLaps).toBe(3);
  });

  test("balance is signed degrees, so understeer and oversteer drivers are distinguishable", () => {
    const under = computeStyleAxes([], null, [styleLap({ balanceMedianDeg: 3.2 }), styleLap({ balanceMedianDeg: 2.8 }), styleLap({ balanceMedianDeg: 3 })]);
    const over = computeStyleAxes([], null, [styleLap({ balanceMedianDeg: -2.5 }), styleLap({ balanceMedianDeg: -3.1 }), styleLap({ balanceMedianDeg: -2.9 })]);
    expect(under.balanceMedianDeg).toBe(3);
    expect(over.balanceMedianDeg).toBe(-2.9);
  });

  test("one wild lap does not drag the fingerprint — axes are medians", () => {
    const calm = [styleLap({ controlLossFraction: 0.01 }), styleLap({ controlLossFraction: 0.02 }), styleLap({ controlLossFraction: 0.015 })];
    const withSpin = [...calm, styleLap({ controlLossFraction: 0.85 })];
    expect(computeStyleAxes([], null, withSpin).controlLossFraction!).toBeLessThan(0.05);
  });

  test("physics axes are null, never zero, when nothing was measurable", () => {
    const axes = computeStyleAxes([], null, [{ frames: 500, corneringFrames: 3, corneringSeconds: 0.05, usable: false }]);
    expect(axes.gripUtilMedian).toBeNull();
    expect(axes.gripUtilP95).toBeNull();
    expect(axes.balanceMedianDeg).toBeNull();
    expect(axes.controlLossFraction).toBeNull();
    expect(axes.steerReversalsPerS).toBeNull();
    expect(axes.slipVariabilityDeg).toBeNull();
    expect(axes.physicsLaps).toBe(0);
  });

  test("detector counts no longer move the physics axes at all", () => {
    const style = [styleLap({}), styleLap({}), styleLap({})];
    const clean = buildDriverFingerprint({ scope: SCOPE, ...habitualDriver(3, []), perLapStyle: style });
    const faulty = buildDriverFingerprint({
      scope: SCOPE,
      ...habitualDriver(3, [insight("driving-late-braking-overshoot", { severity: "critical" }), insight("tire-spin-RL", { category: "tires", severity: "critical" })]),
      perLapStyle: style,
    });
    expect(faulty.style!.gripUtilMedian).toBe(clean.style!.gripUtilMedian);
    expect(faulty.style!.controlLossFraction).toBe(clean.style!.controlLossFraction);
    expect(faulty.style!.balanceMedianDeg).toBe(clean.style!.balanceMedianDeg);
    // …but the detector-derived braking lean still responds.
    expect(faulty.style!.brakingStyle).not.toBe(clean.style!.brakingStyle);
  });

  test("a pool with too few measurable laps says so", () => {
    const fp = buildDriverFingerprint({
      scope: SCOPE,
      ...habitualDriver(6, []),
      perLapStyle: [styleLap({}), styleLap({}), ...Array.from({ length: 4 }, () => unusableLap())],
    });
    expect(fp.style!.physicsLaps).toBe(2);
    expect(fp.notes.join(" ")).toContain("enough cornering to measure driving style");
  });

  test("physics axes survive lap reordering unchanged", () => {
    const laps = Array.from({ length: 5 }, (_, i) => lap(i + 1));
    const style = [0.5, 0.6, 0.7, 0.8, 0.9].map((g) => styleLap({ gripUtilMedian: g }));
    const perLapInsights = laps.map(() => []);
    const forward = buildDriverFingerprint({ scope: SCOPE, laps, perLapInsights, perLapStyle: style });
    const reversed = buildDriverFingerprint({
      scope: SCOPE,
      laps: [...laps].reverse(),
      perLapInsights,
      perLapStyle: [...style].reverse(),
    });
    expect(reversed.style).toEqual(forward.style);
  });
});
