import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import { classifyPitCycleLap } from "@raceiq/analysis-core/racing/laps/pit-cycle";

export function classifyAMS2PitCycle(packets: readonly TelemetryPacket[], completedLapCount: number) {
  const pitCycle = classifyPitCycleLap(packets);
  if (pitCycle) return pitCycle;
  const first = packets[0];
  const capturedRaceStart = first?.ams2?.sessionType === "race"
    && first.LapNumber === 1 && first.CurrentLap <= 0;
  return completedLapCount === 0 && !capturedRaceStart ? "outlap" : null;
}

export function resolveAMS2InvalidReason(packets: readonly TelemetryPacket[]): string | null {
  const first = packets[0];
  // Only a captured, untimed race start can establish the initial grid flag.
  const gridStart = first?.ams2?.sessionType === "race" && first.LapNumber === 1
    && first.CurrentLap <= 0 && first.ams2.lapInvalidated;
  if (!gridStart) return packets.some(p => p.ams2?.lapInvalidated) ? "game-invalidated" : null;

  const cleared = packets.findIndex(p => p.ams2?.lapInvalidated === false);
  // An initial flag that never clears is still invalid. Any later flag counts too.
  return cleared < 0 || packets.slice(cleared + 1).some(p => p.ams2?.lapInvalidated)
    ? "game-invalidated" : null;
}
