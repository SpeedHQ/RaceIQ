import { expect } from "bun:test";
import type { CapturedLap } from "../../server/pipeline-adapters";

/**
 * Assert that a lap's sector times sum to the total lap time.
 * Skips assertion if sectors are not available.
 *
 * @param lap The lap to validate
 * @param tolerance Floating point tolerance in seconds (default: 0.01s)
 */
export function assertSectorTimesMatchLapTime(lap: CapturedLap, tolerance: number = 0.01): void {
  if (!lap.sectors) return;
  const sectorSum = lap.sectors.s1 + lap.sectors.s2 + lap.sectors.s3;
  expect(Math.abs(sectorSum - lap.lapTime)).toBeLessThan(tolerance);
}
