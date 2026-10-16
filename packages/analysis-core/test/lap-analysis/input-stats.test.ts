import { describe, expect, test } from "bun:test";
import { computeStatsRange } from "@raceiq/analysis-core/racing/analysis/laps/input-stats";

describe("computeStatsRange", () => {
  test("aggregates inputs and locates events over selected half-open range", () => {
    const result = computeStatsRange(
      [0, 1, 0.5, 1], [0, 0.2, 0, 0.1], [0, 64, -64, 0],
      [10, 20, 30, 40], [0, 10, 20, 30], 1, 4, { center: 0, range: 127 },
    );
    const { brakeAvg, ...stats } = result;
    expect(stats).toEqual({
      throttleAvg: 5 / 6, throttleMax: 1, fullThrottlePctDist: 2 / 3,
      brakeMax: 0.2, brakingPctDist: 2 / 3, brakeApplications: 2,
      steerAbsAvg: 128 / 381, steerAbsMax: 64 / 127,
      steeringSmoothness: (128 / 127 + 64 / 127) / 2,
      brakeOnDist: 10, brakeOffDist: 30, peakBrakeValue: 0.2, peakBrakeDist: 10,
      fullThrottleDist: 10, liftOffThrottleDist: 20,
      minSpeed: 20 * 1.609344, minSpeedDist: 10,
      maxSpeed: 40 * 1.609344, maxSpeedDist: 30,
    });
    expect(brakeAvg).toBeCloseTo(0.1);
  });

  test("single sample has zero steering smoothness and empty channels yield defined metrics", () => {
    const single = computeStatsRange([1], [0], [0], [0], [7], 0, 1, { center: 0, range: 127 });
    expect(single.steeringSmoothness).toBe(0);
    expect(single.fullThrottleDist).toBe(7);
    const empty = computeStatsRange([], [], [], [], [], 0, 0, { center: 0, range: 127 });
    expect(empty.throttleAvg).toBeNaN();
    expect(empty.minSpeed).toBe(0);
    expect(empty.maxSpeed).toBe(0);
  });
});
