import { describe, expect, test } from "bun:test";
import { hasTelemetryGap } from "@raceiq/lap-replay/ui";

describe("Replay telemetry gaps", () => {
  test("does not mark floating-point 10 Hz samples as gaps", () => {
    expect(
      hasTelemetryGap(0.055000000000063665, 0.15499999999997272),
    ).toBe(false);
    expect(hasTelemetryGap(0.055, 0.157)).toBe(true);
  });

  test("accepts regular sparse samples while preserving missing-sample gaps", () => {
    const times = [0, 0.25, 0.5, 0.75, 1.25, 1.5];
    const threshold = telemetryGapThreshold(times);
    expect(hasTelemetryGap(times[0], times[1], threshold)).toBe(false);
    expect(hasTelemetryGap(times[3], times[4], threshold)).toBe(true);
  });

  test("ignores duplicate and invalid intervals when measuring cadence", () => {
    const threshold = telemetryGapThreshold([0, 0, 0.25, 0.5, 0.75, NaN]);
    expect(hasTelemetryGap(0, 0.25, threshold)).toBe(false);
    expect(hasTelemetryGap(0, 1, threshold)).toBe(true);
    expect(telemetryGapThreshold([])).toBe(0.1);
    expect(telemetryGapThreshold([0, 1])).toBe(0.1);
  });
});
