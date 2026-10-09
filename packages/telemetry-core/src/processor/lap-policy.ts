import { classifyLMUPitCycle, resolveLMULapTime, resolveLMUInvalidReason } from "./kunos-policy";
import { classifyPitCycleLap, type PitCycleReason } from "@raceiq/analysis-core/racing/laps/pit-cycle";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
export interface LapDetectorPolicy {
  resolveLapTime(packets: readonly TelemetryPacket[], newLapFirstPacket: TelemetryPacket): number;
  classifyPitCycle(packets: readonly TelemetryPacket[], completedLapCount: number): PitCycleReason | null;
  invalidReason?(packets: readonly TelemetryPacket[]): string | null;
}

export interface LapQualityResult {
  valid: boolean;
  reason: string | null;
}

export const DEFAULT_LAP_DETECTOR_POLICY: LapDetectorPolicy = {
  resolveLapTime(_packets, newLapFirstPacket) {
    return newLapFirstPacket.LastLap > 0 ? newLapFirstPacket.LastLap : 0;
  },
  classifyPitCycle(packets) {
    return classifyPitCycleLap(packets);
  },
};

export const LMU_LAP_DETECTOR_POLICY: LapDetectorPolicy = {
  resolveLapTime: resolveLMULapTime,
  classifyPitCycle: classifyLMUPitCycle,
  invalidReason: resolveLMUInvalidReason,
};

export function mergePitCycleReason(current: PitCycleReason | null, next: PitCycleReason | null): PitCycleReason | null {
  if (!current) return next;
  if (!next || current === next) return current;
  return "pit lap";
}

export function assessLapRecording(packets: readonly TelemetryPacket[], lapTime: number): LapQualityResult {
  if (packets.length < 30) return { valid: false, reason: "too few telemetry packets" };
  const first = packets[0]!;
  const last = packets[packets.length - 1]!;
  const lapDistance = last.DistanceTraveled - first.DistanceTraveled;
  if (lapDistance < 100) return { valid: false, reason: "telemetry distance too short" };

  let peakTelemetryLapTime = -Infinity;
  for (const packet of packets) peakTelemetryLapTime = Math.max(peakTelemetryLapTime, packet.CurrentLap);
  if (peakTelemetryLapTime > 0 && Math.abs(peakTelemetryLapTime - lapTime) > 2) {
    return { valid: false, reason: "telemetry lap time mismatch" };
  }
  if (first.gameId === "acc" && first.LapNumber === 0 && lapTime < 30) {
    return { valid: false, reason: "starting lap" };
  }
  if (first.gameId !== "acc") {
    const dx = last.PositionX - first.PositionX;
    const dz = last.PositionZ - first.PositionZ;
    if (Math.sqrt(dx * dx + dz * dz) > 20) {
      return { valid: false, reason: "start/end positions too far apart" };
    }
  }
  return { valid: true, reason: null };
}
