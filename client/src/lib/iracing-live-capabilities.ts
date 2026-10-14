import type { GameId } from "@raceiq/shared/games/ids";

export type PositionDependentSceneFeature = "track" | "racingLine" | "trails" | "inputs";

/** Live iRacing SDK samples expose lap distance, not world-space car position. */
export function supportsPositionDependentSceneFeature(
  gameId: GameId,
  _feature: PositionDependentSceneFeature,
): boolean {
  return gameId !== "iracing";
}
