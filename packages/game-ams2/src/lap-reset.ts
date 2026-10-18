import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import { detectLapReset, type LapResetResult } from "@raceiq/telemetry-core/processor/boundaries";

export function resolveAMS2LapReset(previous: TelemetryPacket, lastLastLap: number, packet: TelemetryPacket): LapResetResult {
  const result = detectLapReset(previous, lastLastLap, packet);
  if (result.action !== "reset-restart") return result;
  const before = previous.ams2;
  const after = packet.ams2;
  if (!before || !after || previous.gameId !== "ams2" || packet.gameId !== "ams2") return result;

  // AMS2 can leave lap 1 unchanged and report -1 timing across the start line
  // during the untimed lead-in. Distance wrapping alone is not a restart.
  const elapsedMs = packet.TimestampMS - previous.TimestampMS;
  const continuousStartLineWrap =
    previous.sessionUID === packet.sessionUID && previous.trackId === packet.trackId &&
    previous.carId === packet.carId && previous.LapNumber === packet.LapNumber &&
    previous.CurrentLap < 0 && packet.CurrentLap >= -1 && packet.CurrentLap <= 1 &&
    previous.LastLap <= 0 && packet.LastLap <= 0 &&
    before.trackLengthM > 60 && before.trackLengthM === after.trackLengthM &&
    before.lapDistanceM >= before.trackLengthM - 30 && before.lapDistanceM <= before.trackLengthM &&
    after.lapDistanceM >= 0 && after.lapDistanceM <= 30 &&
    elapsedMs > 0 && elapsedMs <= 1000 &&
    Math.hypot(packet.PositionX - previous.PositionX, packet.PositionZ - previous.PositionZ) <= 50;
  return continuousStartLineWrap ? { action: "reset-untimed-lap" } : result;
}
