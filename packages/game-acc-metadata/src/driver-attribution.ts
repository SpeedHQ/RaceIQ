import type { NativeDriverSourceCapability } from "@raceiq/shared/driver-attribution";

/** Current ACC shared-memory projection exposes player/car slots, not active-controller or handoff evidence. */
export const accDriverAttributionCapability: NativeDriverSourceCapability = {
  gameId: "acc",
  source: "acc-shared-memory",
  nativeActorEvidence: null,
  stintBoundaryEvidence: null,
  limitation: "PlayerCarID and display fields identify a slot/car, not the active human controller; current projection lacks controller/handoff evidence, so attribution remains Unknown.",
};
