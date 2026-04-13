import { expect } from "bun:test";
import type { CapturedLap } from "../../server/pipeline-adapters";
import type { TelemetryPacket, LapSavedNotification } from "../../shared/types";

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
 * Assert that a valid lap has non-null sector times and they sum to the lap time.
 * Use this for valid laps where sectors must be computed.
 */
export function assertValidLapHasSectors(lap: CapturedLap, tolerance: number = 0.5): void {
  expect(lap.sectors).not.toBeNull();
  expect(lap.sectors!.s1).toBeGreaterThan(0);
  expect(lap.sectors!.s2).toBeGreaterThan(0);
  expect(lap.sectors!.s3).toBeGreaterThan(0);
  const sectorSum = lap.sectors!.s1 + lap.sectors!.s2 + lap.sectors!.s3;
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

// ────────────────────────────────────────────────────────────────────────────
// Common assertions for all games
// ────────────────────────────────────────────────────────────────────────────

/**
 * Assert that all laps have valid metadata.
 * Checks: sessionId, lapNumber, isValid flag are defined.
 */
export function assertLapMetadataValid(laps: CapturedLap[]): void {
  for (const lap of laps) {
    expect(lap.sessionId).toBeTruthy();
    expect(lap.lapNumber).toBeGreaterThanOrEqual(0);
    expect(lap.isValid).toBeDefined();
  }
}

/**
 * Assert that all laps have telemetry packets.
 */
export function assertLapsHavePackets(laps: CapturedLap[]): void {
  for (const lap of laps) {
    expect(lap.packets.length).toBeGreaterThan(0);
  }
}

/**
 * Assert that all valid laps have proper lap timing.
 * Skips invalid laps.
 */
export function assertValidLapsHaveProperTiming(laps: CapturedLap[]): void {
  for (const lap of laps) {
    if (lap.isValid) {
      assertLapTimesProper(lap.packets, lap.lapTime);
    }
  }
}

/**
 * Assert that all valid laps with sectors have times that sum correctly.
 */
export function assertValidLapsSectorTimesMatch(laps: CapturedLap[]): void {
  for (const lap of laps) {
    if (lap.isValid) {
      assertSectorTimesMatchLapTime(lap);
    }
  }
}

/**
 * Assert that all lap times are positive (no negative or zero times for valid laps).
 */
export function assertLapTimesPositive(laps: CapturedLap[]): void {
  for (const lap of laps) {
    if (lap.isValid) {
      expect(lap.lapTime).toBeGreaterThan(0);
      if (lap.sectors) {
        expect(lap.sectors.s1).toBeGreaterThan(0);
        expect(lap.sectors.s2).toBeGreaterThan(0);
        expect(lap.sectors.s3).toBeGreaterThan(0);
      }
    }
  }
}

/**
 * Assert that sector times between consecutive laps don't have unrealistic jumps.
 * Common causes: ghost lap, corrupted data, or parsing error.
 *
 * @param laps Laps to validate
 * @param maxDeltaSeconds Max realistic sector improvement (default: 2s)
 */
export function assertSectorDeltasRealistic(
  laps: CapturedLap[],
  maxDeltaSeconds: number = 2.0
): void {
  for (let i = 1; i < laps.length; i++) {
    const prev = laps[i - 1];
    const curr = laps[i];

    // Only check if both laps are valid and have sectors
    if (!prev.isValid || !curr.isValid || !prev.sectors || !curr.sectors) continue;

    expect(Math.abs(curr.sectors.s1 - prev.sectors.s1)).toBeLessThan(maxDeltaSeconds);
    expect(Math.abs(curr.sectors.s2 - prev.sectors.s2)).toBeLessThan(maxDeltaSeconds);
    expect(Math.abs(curr.sectors.s3 - prev.sectors.s3)).toBeLessThan(maxDeltaSeconds);
  }
}

/**
 * Assert that WebSocket lap-saved notifications match completed laps exactly.
 * Notifications are generated for laps that cross the finish line (both valid and invalid).
 * Incomplete/ongoing laps do NOT generate notifications.
 *
 * @param laps Laps from dump
 * @param notifications WebSocket notifications from pipeline
 */
export function assertLapSavedNotificationsExist(
  laps: CapturedLap[],
  notifications: any[]
): void {
  const lapSavedNotifications = notifications.filter(
    (n): n is LapSavedNotification => n.type === "lap-saved"
  );

  // Count completed laps (both valid and invalid, excluding incomplete)
  const completedLaps = laps.filter((l) => l.invalidReason !== "incomplete");

  // Must have exactly one notification per completed lap
  expect(lapSavedNotifications.length).toBe(completedLaps.length);
}

/**
 * Run all common cross-game assertions on a set of laps.
 */
export function assertCommonLapValidations(
  laps: CapturedLap[],
  notifications: any[] = [],
  options?: {
    expectedLapCount?: number;
  }
): void {
  // Metadata
  assertLapMetadataValid(laps);

  // Packets and timing
  assertLapsHavePackets(laps);
  assertValidLapsHaveProperTiming(laps);

  // Times and sectors
  assertLapTimesPositive(laps);
  assertValidLapsSectorTimesMatch(laps);

  // Notifications
  if (notifications.length > 0) {
    assertLapSavedNotificationsExist(laps, notifications);
  }

  // Count check
  if (options?.expectedLapCount !== undefined) {
    expect(laps.length).toBe(options.expectedLapCount);
  }
}
