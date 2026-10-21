import type { NativeDriverActor } from "@raceiq/shared/driver-attribution";
import { iracingDriverAttributionCapability } from "@raceiq/game-iracing-metadata/driver-attribution";
import { parseIRacingDriverUserId } from "@raceiq/capture-formats/iracing/session-info";

/** Extract active native SessionInfo UserID; missing or malformed evidence stays absent. */
export function iracingActorFromSessionInfo(
  sessionInfo: string,
  sessionId: string,
  observedAtMs: number,
  clockDomain: string,
): NativeDriverActor | null {
  const actorId = parseIRacingDriverUserId(sessionInfo);
  if (!actorId || !sessionId || !clockDomain || !Number.isFinite(observedAtMs) || observedAtMs < 0) return null;
  return {
    gameId: "iracing",
    source: iracingDriverAttributionCapability.source,
    actorId,
    bindingScope: "installation",
    sessionId,
    clockDomain,
    observedAtMs,
  };
}
