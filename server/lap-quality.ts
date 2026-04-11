import type { TelemetryPacket } from "@shared/types";

export interface LapQualityResult {
  valid: boolean;
  reason: string | null;
}

/**
 * Assess recording quality of a completed lap.
 * Returns { valid: false, reason } when the telemetry indicates a bad recording.
 * Returns { valid: true, reason: null } when the lap looks clean.
 *
 * This is a pure function — no side effects, no DB access.
 */
export function assessLapRecording(
  packets: TelemetryPacket[],
  lapTime: number
): LapQualityResult {
  if (packets.length < 30) {
    return { valid: false, reason: "too few telemetry packets" };
  }

  const startDist = packets[0].DistanceTraveled;
  const endDist = packets[packets.length - 1].DistanceTraveled;
  const lapDistance = endDist - startDist;

  if (lapDistance < 100) {
    return { valid: false, reason: "telemetry distance too short" };
  }

  // Lap time in telemetry should roughly match stored lapTime (within 2s).
  // Use peak CurrentLap across the buffer rather than the last packet — in ACC,
  // iCurrentTime can reset to ~0 and start counting the new lap before completedLaps
  // increments, so the last few packets may show the new lap's elapsed time instead.
  const peakTelemetryLapTime = Math.max(...packets.map((p) => p.CurrentLap));
  if (peakTelemetryLapTime > 0 && Math.abs(peakTelemetryLapTime - lapTime) > 2) {
    return { valid: false, reason: "telemetry lap time mismatch" };
  }

  // Start and end positions must be close (circuit lap should return to start/finish).
  // ACC lap 0 is always the starting/formation lap — mark invalid regardless of data.
  if (packets[0].gameId === "acc" && packets[0].LapNumber === 0) {
    return { valid: false, reason: "starting lap" };
  }

  // Start and end positions must be close (circuit lap should return to start/finish).
  // Skip for ACC — carCoordinates are in a different scale to DistanceTraveled.
  if (packets[0].gameId !== "acc") {
    const first = packets[0];
    const last = packets[packets.length - 1];
    const dx = last.PositionX - first.PositionX;
    const dz = last.PositionZ - first.PositionZ;
    const gap = Math.sqrt(dx * dx + dz * dz);
    if (gap > lapDistance * 0.15 && gap > 100) {
      return { valid: false, reason: "start/end positions too far apart" };
    }
  }

  return { valid: true, reason: null };
}
