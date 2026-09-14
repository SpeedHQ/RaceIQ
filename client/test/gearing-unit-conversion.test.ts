import { describe, expect, test } from "bun:test";
import { kphToSpeedUnit, speedUnitFactor, speedUnitToKph } from "../src/lib/gearing-ratios";

// Tune gearing stores top speed in km/h and converts at the display boundary.
// These helpers are the boundary — a lossy round-trip here would corrupt saved
// tunes the same way the stale display-unit draft used to.
describe("gearing unit conversion", () => {
  test("kph round-trips losslessly through both speed units", () => {
    for (const label of ["km/h", "mph"] as const) {
      const factor = speedUnitFactor(label);
      for (const kph of [250, 155.34, 1, 999.9]) {
        expect(speedUnitToKph(kphToSpeedUnit(kph, factor), factor)).toBeCloseTo(kph, 6);
      }
    }
  });

  test("km/h factor is the identity", () => {
    const factor = speedUnitFactor("km/h");
    expect(kphToSpeedUnit(250, factor)).toBeCloseTo(250, 6);
    expect(speedUnitToKph(250, factor)).toBeCloseTo(250, 6);
  });

  test("mph factor converts kph to mph", () => {
    const factor = speedUnitFactor("mph");
    expect(kphToSpeedUnit(160.934, factor)).toBeCloseTo(100, 2);
    expect(speedUnitToKph(100, factor)).toBeCloseTo(160.934, 2);
  });
});
