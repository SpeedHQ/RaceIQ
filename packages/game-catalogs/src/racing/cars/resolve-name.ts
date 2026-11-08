import { tryGetGame } from "@raceiq/shared/games/registry";
import { getFmCarName } from "@raceiq/game-fm-2023-metadata/racing/cars/fm";

/** Resolve display name through registered game adapter, then Forza fallback. */
export function resolveCarName(carId: string, gameId?: string): string {
  const adapter = gameId ? tryGetGame(gameId) : undefined;
  return adapter?.getCarName(carId)
    ?? (gameId === "fm-2023" && /^\d+$/.test(carId)
      ? getFmCarName(Number(carId))
      : carId);
}
