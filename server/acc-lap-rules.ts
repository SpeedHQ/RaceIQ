/**
 * ACC-specific lap validation rules, extracted from lap-detector-v2 so each
 * rule has a clear name and can be unit tested independently.
 *
 * All functions are no-ops for non-ACC packets — they check gameId internally.
 */
import type { TelemetryPacket } from "../shared/types";

/**
 * Returns true if the very first packet of an ACC recording was captured while
 * the driver was already several seconds into a lap.
 *
 * This is a recording-side artifact, not an ACC feature: ACC's shared memory
 * continuously exposes `iCurrentTime`, so if the recorder attaches mid-lap the
 * first packet we see will have `CurrentLap > 0`. Other games start CurrentLap
 * at 0 on each new session, so this heuristic only applies to ACC.
 */
export function accFirstPacketIsMidLap(packet: TelemetryPacket): boolean {
  return packet.gameId === "acc" && packet.CurrentLap > 5;
}

/**
 * Classifies an ACC lap based on where the pit lane touches it. Returns the
 * invalid reason string if the lap should be marked invalid, or `null` if the
 * lap never touched pit (and is thus pit-wise valid).
 *
 * - `outlap`:  first packet in pit, last on track (driver exited pit this lap)
 * - `inlap`:   first on track, last in pit    (driver entered pit this lap)
 * - `pit lap`: both first and last in pit     (entirely within pit lane / box)
 *
 * Applies to any lap regardless of lap number — a mid-race pit stop produces
 * inlap → pit lap → outlap on laps N → N+1 → N+2. Non-ACC packets always
 * return null because this rule depends on `packet.acc.pitStatus`.
 */
export function classifyAccPitLap(
  packets: TelemetryPacket[]
): "outlap" | "inlap" | "pit lap" | null {
  if (packets.length === 0) return null;
  if (packets[0].gameId !== "acc") return null;

  const firstPit = packets[0].acc?.pitStatus ?? "out";
  const lastPit = packets[packets.length - 1].acc?.pitStatus ?? "out";
  const startInPit = firstPit !== "out";
  const endInPit = lastPit !== "out";

  if (startInPit && endInPit) return "pit lap";
  if (startInPit) return "outlap";
  if (endInPit) return "inlap";
  return null;
}
