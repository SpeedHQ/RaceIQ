import { describe, expect, test } from "bun:test";
import type { SemanticTelemetrySample } from "../../../shared/telemetry/replay/contracts";
import { deriveFuelPerLap, deriveTyreWear } from "../../../server/lap-analysis/metrics";

/** Pure per-lap metric derivation behind GET /api/experiments/:id/lap-metrics
 *  (plan §2, Phase C). Tests the compute directly — importing the composed app
 *  would bind the UDP socket as a side effect. */

function sample(values: SemanticTelemetrySample["values"]): SemanticTelemetrySample {
  return { sequence: "0", observedAtMs: 0, values };
}

function fuelSample(fuel: number): SemanticTelemetrySample {
  return sample({ "fuel.fuel": fuel });
}

describe("deriveFuelPerLap", () => {
  test("derives consumed fuel from remaining fuel across semantic lap frames", () => {
    const samples = [fuelSample(50), fuelSample(48), fuelSample(46)];
    expect(deriveFuelPerLap(samples)).toBe(4);
  });

  test("derives consumed fuel across semantic lap frames", () => {
    const samples = [fuelSample(50), fuelSample(49), fuelSample(47.4)];
    // 50 − 47.4 = 2.6
    expect(deriveFuelPerLap(samples)).toBe(2.6);
  });

  test("omits (undefined) for legacy laps with no telemetry", () => {
    expect(deriveFuelPerLap([])).toBeUndefined();
    expect(deriveFuelPerLap([fuelSample(50)])).toBeUndefined();
  });

  test("omits when fuel is flat or rising", () => {
    expect(deriveFuelPerLap([fuelSample(50), fuelSample(50)])).toBeUndefined();
    expect(deriveFuelPerLap([fuelSample(50), fuelSample(51)])).toBeUndefined();
  });
});

function wearSample(fl: number, fr: number, rl: number, rr: number): SemanticTelemetrySample {
  return sample({ "tires.tire-wear": [fl, fr, rl, rr] });
}

describe("deriveTyreWear", () => {
  test("reports worst-tyre % worn at lap end (0..1 fraction × 100)", () => {
    const samples = [wearSample(0.05, 0.06, 0.07, 0.06), wearSample(0.18, 0.19, 0.22, 0.21)];
    // worst = RL 0.22 → 22%
    expect(deriveTyreWear(samples)).toBe(22);
  });

  test("uses the last frame with all four tyres readable", () => {
    // Final frame has a -1 (channel unavailable) → falls back to prior frame.
    const samples = [wearSample(0.1, 0.1, 0.12, 0.11), wearSample(-1, -1, -1, -1)];
    expect(deriveTyreWear(samples)).toBe(12);
  });

  test("omits when no frame has a usable reading", () => {
    expect(deriveTyreWear([])).toBeUndefined();
    expect(deriveTyreWear([wearSample(-1, -1, -1, -1)])).toBeUndefined();
  });
});
