import type { TelemetryPacket } from "../../shared/telemetry/types";

/** Attach recorder UTC separately from simulator time; Kunos has no source UTC clock. */
export function applyFrameTime(packet: Pick<TelemetryPacket, "gameId" | "TimestampMS" | "extendedRaceIQ">, frameTimeMs?: number): void {
  if (frameTimeMs === undefined) return;
  (packet.extendedRaceIQ ??= {}).frameTimeMs = frameTimeMs;
  if (packet.gameId === "acc" || packet.gameId === "ac-evo") packet.TimestampMS = frameTimeMs;
}
