import type { NativeDriverSourceCapability } from "@raceiq/shared/driver-attribution";

/** AC Evo's native player-control role is distinct from driver names and inferred slots. */
export const acEvoDriverAttributionCapability: NativeDriverSourceCapability = {
  gameId: "ac-evo",
  source: "ac-evo-shared-memory",
  nativeActorEvidence: "Live physics isAIControlled plus graphics focused/player full 128-bit car GUIDs; matching local control role identifies this installation binding.",
  stintBoundaryEvidence: "Each native page must independently advance in a continuous LIVE capture; cached reads retain the original evidence time for at most 500 ms, while pause, replay, reset, conflict, gaps, and stale pages become Unknown.",
  limitation: "Control role establishes local player control, not external human identity; AI takeover and focused foreign cars remain Other. Missing native GUIDs or unsupported/blank ABI versions remain Unknown and are native-source release gaps.",
};
