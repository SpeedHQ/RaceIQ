import type { NativeDriverSourceCapability } from "@raceiq/shared/driver-attribution";

/** Native SessionInfo carries the active driver's UserID from the DriverCarIdx row. */
export const iracingDriverAttributionCapability: NativeDriverSourceCapability = {
  gameId: "iracing",
  source: "iracing-sdk-session-info",
  nativeActorEvidence: "SessionInfo.DriverInfo.Drivers[DriverCarIdx].UserID",
  stintBoundaryEvidence: "SessionInfo revision updates and active UserID changes",
  limitation: "UserID is a native iRacing account actor, not the RaceIQ account; require explicit installation-user binding, and missing/stale/conflicting SessionInfo stays Unknown.",
};
