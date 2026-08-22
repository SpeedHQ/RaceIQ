import type { TelemetryPacket } from "../../shared/telemetry/types";

export interface LapQualityResult {
  valid: boolean;
  reason: string | null;
}

/**
 * Assess source-recording integrity before semantic replay exists. This is part
 * of lap capture, not downstream analysis; normal consumers use persisted
 * quality plus resolver-backed semantic samples.
 */
export function assessLapRecording(packets: readonly TelemetryPacket[], lapTime: number): LapQualityResult {
  if (packets.length < 30) {
    return { valid: false, reason: "too few telemetry packets" };
  }

  const first = packets[0];
  const last = packets[packets.length - 1];
  const lapDistance = last.DistanceTraveled - first.DistanceTraveled;

  if (lapDistance < 100) {
    return { valid: false, reason: "telemetry distance too short" };
  }

  let peakTelemetryLapTime = -Infinity;
  for (const packet of packets) {
    peakTelemetryLapTime = Math.max(peakTelemetryLapTime, packet.CurrentLap);
  }
  if (peakTelemetryLapTime > 0 && Math.abs(peakTelemetryLapTime - lapTime) > 2) {
    return { valid: false, reason: "telemetry lap time mismatch" };
  }

  if (first.gameId === "acc" && first.LapNumber === 0 && lapTime < 30) {
    return { valid: false, reason: "starting lap" };
  }

  if (first.gameId !== "acc") {
    const dx = last.PositionX - first.PositionX;
    const dz = last.PositionZ - first.PositionZ;
    const gap = Math.sqrt(dx * dx + dz * dz);
    if (gap > lapDistance * 0.15 && gap > 100) {
      return { valid: false, reason: "start/end positions too far apart" };
    }
  }

  return { valid: true, reason: null };
}
