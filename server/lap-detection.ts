/**
 * Pure detection functions for lap and session boundary logic.
 *
 * These functions take all their inputs as parameters and return a result —
 * no class state, no DB, no side effects. Extracted from LapDetector so they
 * can be unit-tested independently.
 */
import type { TelemetryPacket } from "../shared/types";

const SESSION_TIMEOUT_MS = 5 * 60_000;

export interface SessionSnapshot {
  carOrdinal: number;
  trackOrdinal: number;
  sessionUID?: string;
}

// ── Session boundary detection ────────────────────────────────────────────────

export type SessionBoundaryReason =
  | "no-session"
  | "session-uid-changed"
  | "lap-number-reset"
  | "distance-reset"
  | "car-changed"
  | "track-changed"
  | "silence-timeout";

/**
 * Returns the reason a new session should start, or null if the current
 * session should continue.
 */
export function detectSessionBoundary(
  session: SessionSnapshot | null,
  currentLapNumber: number,
  lastBufferedDistance: number | null, // DistanceTraveled of the last buffered packet, or null
  lastPacketTime: number,             // wall-clock ms of last received packet (0 = never)
  packet: TelemetryPacket,
  now: number
): SessionBoundaryReason | null {
  if (!session) return "no-session";

  if (
    packet.sessionUID &&
    session.sessionUID &&
    packet.sessionUID !== session.sessionUID
  ) return "session-uid-changed";

  if (
    currentLapNumber > 1 &&
    packet.LapNumber === 1 &&
    packet.LapNumber < currentLapNumber
  ) return "lap-number-reset";

  if (
    !session.sessionUID &&
    lastBufferedDistance !== null &&
    lastBufferedDistance > 1000 &&
    packet.DistanceTraveled < 500
  ) return "distance-reset";

  if (packet.CarOrdinal !== session.carOrdinal) return "car-changed";

  if (packet.TrackOrdinal && packet.TrackOrdinal !== session.trackOrdinal)
    return "track-changed";

  if (
    !session.sessionUID &&
    lastPacketTime > 0 &&
    now - lastPacketTime > SESSION_TIMEOUT_MS
  ) return "silence-timeout";

  return null;
}

// ── Lap boundary detection ────────────────────────────────────────────────────

export type LapBoundaryResult =
  | { action: "none" }
  | { action: "complete" }
  | { action: "complete-skip"; invalidReason: string }  // lap skip (>1 lap jumped)
  | { action: "reset-rewind" };                          // lap number went backward

/**
 * Determines what to do when LapNumber changes.
 * Only called when currentLapNumber >= 0 and packet.LapNumber !== currentLapNumber.
 */
export function detectLapBoundary(
  currentLapNumber: number,
  packet: TelemetryPacket
): LapBoundaryResult {
  if (packet.LapNumber < currentLapNumber) {
    return { action: "reset-rewind" };
  }
  if (packet.LapNumber > currentLapNumber + 1) {
    return {
      action: "complete-skip",
      invalidReason: `lap skip (${currentLapNumber} → ${packet.LapNumber})`,
    };
  }
  return { action: "complete" };
}

// ── Lap reset detection (race restart / final lap) ────────────────────────────

export type LapResetResult =
  | { action: "none" }
  | { action: "complete-final-lap" }  // LastLap changed — it was actually a completed lap
  | { action: "reset-restart" };       // Genuine race restart or teleport

/**
 * Detects whether a mid-lap CurrentLap/Distance reset should trigger a lap
 * completion (final race lap) or discard (race restart / teleport).
 *
 * Only called when LapNumber === currentLapNumber and buffer.length > 30.
 */
export function detectLapReset(
  lastBufferedPacket: TelemetryPacket,
  lastLastLap: number,
  packet: TelemetryPacket
): LapResetResult {
  const lapTimeReset = lastBufferedPacket.CurrentLap > 5 && packet.CurrentLap === 0;
  const distanceDrop = lastBufferedPacket.DistanceTraveled - packet.DistanceTraveled > 500;

  if (!lapTimeReset && !distanceDrop) return { action: "none" };

  const lastLapChanged =
    packet.LastLap > 0 && lastLastLap > 0 && packet.LastLap !== lastLastLap;

  if (lastLapChanged) return { action: "complete-final-lap" };
  return { action: "reset-restart" };
}
