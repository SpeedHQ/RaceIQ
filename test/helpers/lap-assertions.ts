import { expect } from "bun:test";
import type { CapturedLap } from "../../server/pipeline-adapters";
import type { TelemetryPacket } from "../../shared/types";

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

/**
 * Assert that a lap's telemetry shows proper start/end times.
 * Detects lap splitting issues by checking that:
 * - Lap starts with CurrentLap time near 0
 * - Lap ends with CurrentLap time near the full lap time (not reset to 0)
 *
 * @param packets Telemetry packets for the lap
 * @param lapTime Total lap time in seconds
 * @param tolerance Floating point tolerance in seconds (default: 0.5s)
 */
export function assertLapTimesProper(
  packets: TelemetryPacket[],
  lapTime: number,
  tolerance: number = 0.5
): void {
  expect(packets.length).toBeGreaterThan(0);

  const firstPacket = packets[0];
  const lastPacket = packets[packets.length - 1];

  // Lap should start near 0
  expect(firstPacket.CurrentLap).toBeLessThan(tolerance);

  // Lap should end near the full lap time, not reset to 0
  expect(lastPacket.CurrentLap).toBeGreaterThan(lapTime - tolerance);
}
