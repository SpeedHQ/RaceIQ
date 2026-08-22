import { describe, expect, test } from "bun:test";
import { clampVisibleRange } from "../src/lib/chart-range";
import { cropComparisonRange, mergeComparisonRange, normalizeFidelityRange, selectFidelity } from "../src/lib/comparison-fidelity";
import type { ComparisonData, ComparisonRangeData } from "../../shared/racing/comparison/types";

const trace = (distance: number[]) => ({
  distance,
  sourceIndicesA: distance.map((_, i) => i), sourceIndicesB: distance.map((_, i) => i),
  speedA: distance, speedB: distance.map((value) => value + 1),
  throttleA: distance, throttleB: distance, brakeA: distance, brakeB: distance,
  steerA: distance, steerB: distance, gearA: distance, gearB: distance,
  rpmA: distance, rpmB: distance, positionXA: distance, positionXB: distance,
  positionZA: distance, positionZB: distance, yawA: distance, yawB: distance,
  elapsedTimeA: distance, elapsedTimeB: distance, tireWearA: distance, tireWearB: distance,
});

const base: ComparisonData = {
  lapA: { lapNumber: 1, lapTime: 1, isValid: true, trackOrdinal: 1, carOrdinal: 1 },
  lapB: { lapNumber: 2, lapTime: 1, isValid: true, trackOrdinal: 1, carOrdinal: 1 },
  traces: trace([0, 1, 2, 3, 4]), timeDelta: [0, 1, 2, 3, 4], corners: [],
};
const detail: ComparisonRangeData = { distanceStart: 1, distanceEnd: 3, stepMeters: 0.5, traces: { ...trace([1, 1.5, 2, 2.5, 3]), speedA: [10, 10.5, 11, 11.5, 12] }, timeDelta: [10, 10.5, 11, 11.5, 12] };

describe("comparison fidelity", () => {
  test("allows repeated zoom within an already narrowed range", () => {
    expect(selectFidelity(800, 1001)?.stepMeters).toBe(0.1);
    expect(selectFidelity(990, 1001)).toBeNull();
  });

  test("pads and clamps requested range", () => {
    expect(normalizeFidelityRange(0, 10, 100)).toEqual({ start: 0, end: 12, stepMeters: 0.1 });
  });

  test("merges high-resolution values into base view", () => {
    const merged = mergeComparisonRange(base, detail);
    expect(merged.traces.speedA).toEqual([0, 10, 11, 12, 4]);
    expect(merged.timeDelta).toEqual([0, 10, 11, 12, 4]);
  });

  test("crops current detail data for optimistic narrower zoom", () => {
    const cropped = cropComparisonRange(detail, 1.4, 2.6);
    expect(cropped.distanceStart).toBe(1.5);
    expect(cropped.distanceEnd).toBe(2.5);
    expect(cropped.traces.distance).toEqual([1.5, 2, 2.5]);
    expect(cropped.traces.speedA).toEqual([10.5, 11, 11.5]);
    expect(cropped.timeDelta).toEqual([10.5, 11, 11.5]);
  });

  test("preserves visible range while chart data refreshes", () => {
    expect(clampVisibleRange({ min: 20, max: 40 }, { min: 0, max: 100 })).toEqual({ min: 20, max: 40 });
    expect(clampVisibleRange({ min: -10, max: 120 }, { min: 0, max: 100 })).toEqual({ min: 0, max: 100 });
  });
});
