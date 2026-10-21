import type { NativeDriverActor, NativeDriverSourceCapability } from "@raceiq/shared/driver-attribution";

/** F1's selected participant carries human/AI control state and network ID; neither is a RaceIQ account. */
export const f1DriverAttributionCapability: NativeDriverSourceCapability = {
  gameId: "f1-2025",
  source: "f1-2025-udp-participant",
  nativeActorEvidence: "participants[playerCarIndex].aiControlled=human + networkId",
  stintBoundaryEvidence: "selected participant networkId changes in fresh UDP frames",
  limitation: "AI-controlled entries and networkId 255 have no human actor identity; valid network participants require a session-scoped installation-user binding. Missing/stale frames stay Unknown.",
};

/** Build a session-scoped human actor token from validated native participant and session-clock fields. */
export function f1ActorFromParticipant(
  sessionUID: string,
  aiControlled: number | undefined,
  networkId: number | undefined,
  sessionTimeSeconds: number,
): NativeDriverActor | null {
  if (!/^\d+$/.test(sessionUID) || sessionUID === "0" || aiControlled !== 0 ||
      typeof networkId !== "number" || !Number.isInteger(networkId) || networkId < 0 || networkId >= 255 ||
      !Number.isFinite(sessionTimeSeconds) || sessionTimeSeconds < 0) return null;
  return {
    gameId: "f1-2025",
    source: f1DriverAttributionCapability.source,
    actorId: `${sessionUID}:network:${networkId}`,
    bindingScope: "session",
    sessionId: sessionUID,
    clockDomain: `f1-2025-session:${sessionUID}`,
    observedAtMs: Math.round(sessionTimeSeconds * 1000),
  };
}
