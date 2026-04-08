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
  const trackLength = endDist; // endDist ≈ full track length when lap ends at S/F

  if (trackLength < 100) {
    return { valid: false, reason: "telemetry distance too short" };
  }

  // Recording started more than 5% into the lap — sector data and analysis will be unreliable
  if (startDist / trackLength > 0.05) {
    return { valid: false, reason: "recording started mid-lap" };
  }

  // Lap time in telemetry should roughly match stored lapTime (within 2s)
  const telemetryLapTime = packets[packets.length - 1].CurrentLap;
  if (telemetryLapTime > 0 && Math.abs(telemetryLapTime - lapTime) > 2) {
    return { valid: false, reason: "telemetry lap time mismatch" };
  }

  return { valid: true, reason: null };
}
