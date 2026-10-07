import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";

const SESSION_TIMEOUT_MS = 5 * 60_000;

export interface SessionSnapshot {
  carOrdinal: number;
  trackOrdinal: number;
  sessionUID?: string;
  carId?: string;
  trackId?: string;
}

export type SessionBoundaryReason =
  | "no-session"
  | "session-uid-changed"
  | "lap-number-reset"
  | "distance-reset"
  | "car-changed"
  | "track-changed"
  | "silence-timeout";

export function detectSessionBoundary(
  session: SessionSnapshot | null,
  currentLapNumber: number,
  lastBufferedDistance: number | null,
  lastPacketTime: number,
  packet: TelemetryPacket,
  now: number,
): SessionBoundaryReason | null {
  if (!session) return "no-session";
  if (packet.sessionUID && session.sessionUID && packet.sessionUID !== session.sessionUID) {
    return "session-uid-changed";
  }
  if (currentLapNumber > 1 && packet.LapNumber === 1 && packet.LapNumber < currentLapNumber) {
    return "lap-number-reset";
  }
  if (!session.sessionUID && lastBufferedDistance !== null && lastBufferedDistance > 1000 && packet.DistanceTraveled < 500) {
    return "distance-reset";
  }
  if (packet.gameId === "lmu" && packet.lmu) {
    if (packet.lmu.carId !== session.carId) return "car-changed";
    if (packet.lmu.trackId !== session.trackId) return "track-changed";
  } else {
    if (packet.CarOrdinal !== session.carOrdinal) return "car-changed";
    if (packet.TrackOrdinal && packet.TrackOrdinal !== session.trackOrdinal) return "track-changed";
  }
  if (!session.sessionUID && lastPacketTime > 0 && now - lastPacketTime > SESSION_TIMEOUT_MS) {
    return "silence-timeout";
  }
  return null;
}

export type LapBoundaryResult =
  | { action: "complete" }
  | { action: "complete-skip"; invalidReason: string }
  | { action: "reset-rewind" };

export function detectLapBoundary(currentLapNumber: number, packet: TelemetryPacket): LapBoundaryResult {
  if (packet.LapNumber < currentLapNumber) return { action: "reset-rewind" };
  if (packet.LapNumber > currentLapNumber + 1) {
    return { action: "complete-skip", invalidReason: `lap skip (${currentLapNumber} → ${packet.LapNumber})` };
  }
  return { action: "complete" };
}

export type LapResetResult =
  | { action: "none" }
  | { action: "complete-final-lap" }
  | { action: "reset-restart" };

export function detectLapReset(
  lastBufferedPacket: TelemetryPacket,
  lastLastLap: number,
  packet: TelemetryPacket,
): LapResetResult {
  const lapTimeReset = lastBufferedPacket.CurrentLap > 5 && packet.CurrentLap === 0;
  const distanceDrop = lastBufferedPacket.DistanceTraveled - packet.DistanceTraveled > 500;
  if (!lapTimeReset && !distanceDrop) return { action: "none" };
  const lastLapChanged = packet.LastLap > 0 && lastLastLap > 0 && packet.LastLap !== lastLastLap;
  return lastLapChanged ? { action: "complete-final-lap" } : { action: "reset-restart" };
}
