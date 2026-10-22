import { iracingLiveCapabilities } from "@raceiq/game-iracing/live-capabilities";
import type { GameId } from "@raceiq/shared/games/ids";

export type PositionDependentSceneFeature = "track" | "racingLine" | "trails" | "inputs";

/** Scene overlays requiring world-space car position share the source capability. */
export function supportsPositionDependentSceneFeature(
  gameId: GameId,
  _feature: PositionDependentSceneFeature,
): boolean {
  return gameId === "iracing" ? iracingLiveCapabilities.worldPosition : true;
}
