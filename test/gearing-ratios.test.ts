import { describe, expect, test } from "bun:test";
import { ceilTo, findBestShiftRpm, findPeakRpm, SHIFT_DROP_RATIO, setupSpeedAtRpm, speedUnitFactor, tireCircumferenceM } from "../client/src/lib/gearing-ratios";

describe("speedUnitFactor", () => {
  test("maps km/h and mph labels to m/s multipliers", () => {
    expect(speedUnitFactor("km/h")).toBe(3.6);
    expect(speedUnitFactor("mph")).toBeCloseTo(2.23694, 5);
  });
});

describe("tireCircumferenceM", () => {
  test("derives circumference from the setup top speed", () => {
    // V_top = redline/60/(GR×FD)×circ×factor → circ = V_top×GR×FD/(redline/60)/factor
    const circ = tireCircumferenceM(299.338, 0.48, 6.1, 9000, 3.6);
    expect(circ).toBeCloseTo((299.338 * 0.48 * 6.1) / 150 / 3.6, 10);
  });

  test("returns 0 for unusable inputs", () => {
    expect(tireCircumferenceM(0, 0.48, 6.1, 9000, 3.6)).toBe(0);
    expect(tireCircumferenceM(299, 0, 6.1, 9000, 3.6)).toBe(0);
    expect(tireCircumferenceM(299, 0.48, 0, 9000, 3.6)).toBe(0);
    expect(tireCircumferenceM(299, 0.48, 6.1, 0, 3.6)).toBe(0);
  });
});

describe("setupSpeedAtRpm", () => {
  test("reproduces the stored top speed at redline in the top gear", () => {
    const circ = tireCircumferenceM(299.338, 0.48, 6.1, 9000, 3.6);
    expect(setupSpeedAtRpm(circ, 9000, 0.48, 6.1, 3.6)).toBeCloseTo(299.338, 6);
  });

  test("rescales speeds when the final drive changes", () => {
    const circ = tireCircumferenceM(299.338, 0.48, 6.1, 9000, 3.6);
    // Halving the FD doubles the speed at the same rpm and ratio.
    const at61 = setupSpeedAtRpm(circ, 9000, 0.48, 6.1, 3.6);
    const at305 = setupSpeedAtRpm(circ, 9000, 0.48, 3.05, 3.6);
    expect(at305).toBeCloseTo(at61 * 2, 6);
  });

  test("returns 0 for non-positive ratios or circumference", () => {
    expect(setupSpeedAtRpm(0, 9000, 0.48, 6.1, 3.6)).toBe(0);
    expect(setupSpeedAtRpm(1.6, 9000, 0, 6.1, 3.6)).toBe(0);
  });
});

describe("findPeakRpm", () => {
  test("returns the RPM of the maximum value", () => {
    const curve = [
      { rpm: 2000, powerW: 100 },
      { rpm: 7400, powerW: 400 },
      { rpm: 8000, powerW: 350 },
    ];
    expect(findPeakRpm(curve, "powerW")).toBe(7400);
  });

  test("returns null for an empty curve", () => {
    expect(findPeakRpm([], "powerW")).toBeNull();
  });
});

describe("findBestShiftRpm", () => {
  test("returns the first RPM past the peak where power drops below the ratio", () => {
    const peak = 400;
    const thr = peak * SHIFT_DROP_RATIO;
    const gap = peak - thr; // strictly positive for any ratio < 1
    const curve = [
      { rpm: 4000, powerW: 200 },
      { rpm: 7400, powerW: peak }, // peak
      { rpm: 8000, powerW: thr + gap / 2 },
      { rpm: 8400, powerW: thr - gap / 2 }, // first point below the threshold
    ];
    expect(findBestShiftRpm(curve)).toBe(8400);
  });

  test("falls back to the curve's end while power is still declining", () => {
    const peak = 400;
    const thr = peak * SHIFT_DROP_RATIO;
    const gap = peak - thr;
    const curve = [
      { rpm: 4000, powerW: 300 },
      { rpm: 7400, powerW: peak },
      { rpm: 8800, powerW: thr + gap / 2 }, // above the threshold, below the peak
    ];
    expect(findBestShiftRpm(curve)).toBe(8800);
  });

  test("returns null when the peak is the last point or the curve is short", () => {
    expect(findBestShiftRpm([{ rpm: 5000, powerW: 300 }])).toBeNull();
    expect(
      findBestShiftRpm([
        { rpm: 4000, powerW: 200 },
        { rpm: 5000, powerW: 400 },
      ]),
    ).toBeNull();
  });
});

describe("ceilTo", () => {
  test("rounds up to the next step multiple", () => {
    expect(ceilTo(0, 50)).toBe(0);
    expect(ceilTo(1, 50)).toBe(50);
    expect(ceilTo(100, 50)).toBe(100);
    expect(ceilTo(101, 50)).toBe(150);
  });
});
