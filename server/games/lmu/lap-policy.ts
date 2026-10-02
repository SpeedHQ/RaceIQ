import type { TelemetryPacket } from "../../../shared/telemetry/types";
import { classifyPitCycleLap, type PitCycleReason } from "../../../shared/racing/laps/pit-cycle";
import type { LapDetectorPolicy } from "../../lap-detection/types";

export function resolveLMULapTime(
  packets: readonly TelemetryPacket[],
  newLapFirstPacket: TelemetryPacket,
): number {
  if (newLapFirstPacket.LastLap > 0) return newLapFirstPacket.LastLap;
  if (packets.length <= 30) return 0;
  return packets.reduce((peak, packet) => Math.max(peak, packet.CurrentLap), 0);
}

export function classifyLMUPitCycle(
  packets: readonly TelemetryPacket[],
  completedLapCount: number,
): PitCycleReason | null {
  const reason = classifyPitCycleLap(packets);
  return reason ?? (completedLapCount === 0 ? "outlap" : null);
}
export function resolveLMUInvalidReason(
  packets: readonly TelemetryPacket[],
): string | null {
  return packets.some((packet) => packet.lmu?.lapInvalidated)
    ? "game-invalidated"
    : null;
}


export const lmuLapPolicy: LapDetectorPolicy = {
  resolveLapTime: resolveLMULapTime,
  classifyPitCycle: classifyLMUPitCycle,
  invalidReason: resolveLMUInvalidReason,
};
