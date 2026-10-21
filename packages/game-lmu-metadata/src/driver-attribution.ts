import type { NativeDriverSourceCapability } from "@raceiq/shared/driver-attribution";

/** LMU scoring exposes current driver label and control role for the selected local vehicle. */
export const lmuDriverAttributionCapability: NativeDriverSourceCapability = {
  gameId: "lmu",
  source: "lmu-shared-memory-player-scoring",
  nativeActorEvidence: "playerScoring.isPlayer + mControl (0=local player, 1=local AI, 2=remote)",
  stintBoundaryEvidence: "mControl changes in fresh selected-player scoring frames",
  limitation: "mControl identifies controller role, not globally authenticated person; require explicit installation-user binding of local-player role. Invalid/replay/missing scoring stays Unknown.",
};
