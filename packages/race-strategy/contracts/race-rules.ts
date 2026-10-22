import type { GameId } from "@raceiq/shared/games/ids";

/** F1 2025 race pit stops cannot replenish fuel. Fuel usage remains a measured resource. */
export function supportsRaceRefueling(gameId: GameId): boolean {
  return gameId !== "f1-2025";
}
