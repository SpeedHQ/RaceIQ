/**
 * Kunos lap validation rules shared by ACC and AC Evo detectors.
 */
import type { TelemetryPacket } from "../../../shared/telemetry/types";

/**
 * Returns true if the very first packet of a Kunos (ACC / AC Evo) recording
 * was captured while the driver was already several seconds into a lap.
 *
 * This is a recording-side artifact: both games' shared memory continuously
 * expose current lap time, so if the recorder attaches mid-lap the first
 * packet we see will have `CurrentLap > 0`. Non-Kunos games (Forza, F1) start
 * CurrentLap at 0 on each new session, so this heuristic is Kunos-only.
 */
export function kunosFirstPacketIsMidLap(packet: TelemetryPacket): boolean {
  const isKunos = packet.gameId === "acc" || packet.gameId === "ac-evo";
  return isKunos && packet.CurrentLap > 5;
}


/** Consecutive invalid frames required before we believe a cut is real. */
const TRACK_LIMITS_MIN_FRAMES = 2;

/**
 * Detects a track-limits cut on a Kunos (ACC / AC Evo) lap from the per-frame
 * `is_valid_lap` graphics flag, returning `"track limits"` if the lap was
 * invalidated on track or `null` otherwise.
 *
 * Both games clear `is_valid_lap` the moment the car puts too many wheels off
 * the racing surface, and leave it cleared for the remainder of the lap. So a
 * true → false transition anywhere inside the lap is the cut, and a lap that is
 * already false at its first frame inherited the state from the previous lap
 * boundary rather than earning it here.
 *
 * A short run of false frames is ignored: the flag can flicker for a frame
 * across the start/finish line and during pit-lane transitions. Frames where
 * the flag is `null` (unknown — parser could not trust it, e.g. in the pits)
 * break a run rather than extending it.
 *
 * Returns null for non-Kunos packets, since no other game exposes this flag.
 */
export function classifyKunosTrackLimits(
  packets: TelemetryPacket[]
): "track limits" | null {
  if (packets.length === 0) return null;
  const gameId = packets[0].gameId;
  if (gameId !== "acc" && gameId !== "ac-evo") return null;

  // A lap that starts already-invalid did not earn the cut on this lap.
  if (packets[0].acc?.isValidLap === false) return null;

  let run = 0;
  for (const p of packets) {
    if (p.acc?.isValidLap === false) {
      run += 1;
      if (run >= TRACK_LIMITS_MIN_FRAMES) return "track limits";
    } else {
      run = 0;
    }
  }
  return null;
}
