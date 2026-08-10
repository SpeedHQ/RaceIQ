import { describe, expect, test } from "bun:test";
import { detectLapCapabilities } from "../src/components/analyse/analyse-capabilities";

const frame = (values: Record<string, unknown>) => ({ values, states: {}, freshness: {} });

describe("detectLapCapabilities", () => {
  test("detects DRS and ERS anywhere in an F1-shaped lap", () => {
    expect(detectLapCapabilities([
      frame({ "aero.drs-active": false }),
      frame({ "fuel.ers-store-energy": 2_000_000 }),
    ])).toEqual({ hasDrs: true, hasErs: true });
  });

  test("detects neither for a Forza-shaped lap", () => {
    expect(detectLapCapabilities([frame({ "motion.speed": 40 })])).toEqual({ hasDrs: false, hasErs: false });
  });

  test("detects DRS and ERS independently", () => {
    expect(detectLapCapabilities([frame({ "aero.drs-active": true })])).toEqual({ hasDrs: true, hasErs: false });
    expect(detectLapCapabilities([frame({ "fuel.ers-deployed": 100 })])).toEqual({ hasDrs: false, hasErs: true });
  });

  test("ignores invalid values", () => {
    expect(detectLapCapabilities([frame({ "aero.drs-active": null, "fuel.ers-store-energy": Number.NaN })])).toEqual({ hasDrs: false, hasErs: false });
  });
});
