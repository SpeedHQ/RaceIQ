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

  // Lap time in telemetry should roughly match stored lapTime (within 2s)
  const telemetryLapTime = packets[packets.length - 1].CurrentLap;
  if (telemetryLapTime > 0 && Math.abs(telemetryLapTime - lapTime) > 2) {
    return { valid: false, reason: "telemetry lap time mismatch" };
  }

  // Start and end positions must be close (circuit lap should return to start/finish)
  const first = packets[0];
  const last = packets[packets.length - 1];
  const dx = last.PositionX - first.PositionX;
  const dz = last.PositionZ - first.PositionZ;
  const gap = Math.sqrt(dx * dx + dz * dz);
  // Allow up to 15% of lap distance as tolerance (covers pit entry, wide S/F zones)
  if (gap > lapDistance * 0.15 && gap > 100) {
    return { valid: false, reason: "start/end positions too far apart" };
  }

  return { valid: true, reason: null };
}
