import { tryGetGame } from "@raceiq/shared/games/registry";
import { getFmCarName } from "@raceiq/game-fm-2023-metadata/racing/cars/fm";

/** Resolve display name through registered game adapter, then Forza fallback. */
export function resolveCarName(ordinal: number, gameId?: string): string {
  const adapter = gameId ? tryGetGame(gameId) : undefined;
  return adapter?.getCarName(ordinal) ?? getFmCarName(ordinal);
}
