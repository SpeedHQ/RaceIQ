import { describe, test, expect } from "bun:test";
import { suggestLapTarget, TARGET_GREEN_MIN, AVG_SPEED_MPS, DEFAULT_LAP_SEC } from "../shared/experiments/stint-target";

describe("suggestLapTarget", () => {
  test("short lap (fast track) -> clamps to 4", () => {
    // A ~60s lap would suggest 6 laps for TARGET_GREEN_MIN=6 minutes; clamped to 4.
    expect(suggestLapTarget(60, null)).toBe(4);
  });

  test("long lap (25km-class track) -> clamps to 1", () => {
    // A ~10 minute lap would suggest well under 1 lap; clamped to 1.
    expect(suggestLapTarget(600, null)).toBe(1);
  });

  test("mid-length lap lands within range without clamping", () => {
    // 120s laps -> 3 laps for 6 minutes of green running.
    expect(suggestLapTarget(120, null)).toBe(3);
  });

  test("falls back to trackLengthM / AVG_SPEED_MPS when no lap time known", () => {
    const trackLengthM = 5000;
    const expectedLapSec = trackLengthM / AVG_SPEED_MPS;
    const expectedTarget = Math.min(4, Math.max(1, Math.round((TARGET_GREEN_MIN * 60) / expectedLapSec)));
    expect(suggestLapTarget(null, trackLengthM)).toBe(expectedTarget);
  });

  test("falls back to a fixed default when neither lap time nor track length is known", () => {
    const expectedTarget = Math.min(4, Math.max(1, Math.round((TARGET_GREEN_MIN * 60) / DEFAULT_LAP_SEC)));
    expect(suggestLapTarget(null, null)).toBe(expectedTarget);
    expect(suggestLapTarget(undefined, undefined)).toBe(expectedTarget);
  });

  test("ignores non-positive lap time / track length inputs", () => {
    expect(suggestLapTarget(0, null)).toBe(suggestLapTarget(null, null));
    expect(suggestLapTarget(-5, 5000)).toBe(suggestLapTarget(null, 5000));
    expect(suggestLapTarget(null, -100)).toBe(suggestLapTarget(null, null));
  });

  test("result is always between 1 and 4 inclusive", () => {
    for (const lapSec of [10, 30, 60, 90, 120, 180, 300, 600, 1200]) {
      const target = suggestLapTarget(lapSec, null);
      expect(target).toBeGreaterThanOrEqual(1);
      expect(target).toBeLessThanOrEqual(4);
    }
  });
});
