import { describe, expect, test } from "bun:test";
import { hasTelemetryGap } from "../src/components/analyse/AnalyseTelemetryChart";
import { interpolateReplayCursorIndex, REACT_STATE_INTERVAL_MS } from "../src/hooks/useLapPlayback";

describe("Analyse playback cadence", () => {
  test("publishes React playback state at 60Hz", () => {
    expect(REACT_STATE_INTERVAL_MS).toBeCloseTo(1000 / 60, 5);
  });

  test("interpolates playback cursor between adjacent telemetry times", () => {
    expect(interpolateReplayCursorIndex(4, 10, 12, 11)).toBe(4.5);
    expect(interpolateReplayCursorIndex(4, 10, 12, 9)).toBe(4);
    expect(interpolateReplayCursorIndex(4, 12, 12, 12)).toBe(4);
  });

  test("does not mark floating-point 10 Hz samples as gaps", () => {
    expect(
      hasTelemetryGap(0.055000000000063665, 0.15499999999997272),
    ).toBe(false);
    expect(hasTelemetryGap(0.055, 0.157)).toBe(true);
  });
});
