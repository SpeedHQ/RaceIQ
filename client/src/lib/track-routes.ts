import { tryGetGame } from "@shared/games/registry";
import type { GameId } from "../../../shared/games/ids";

/**
 * Paths for the track routes.
 *
 * Kept in one place because the route prefix belongs to the game adapter
 * (`fm23`, `acc`, `f125`, `ac-evo`), and a tab's path and its route file have
 * to agree — a mismatch is a dead link, not a type error.
 */

/** "info" is the index route, so it has no path segment of its own. */
export const TRACK_INDEX_TAB = "info";

export function tracksIndexPath(gameId: GameId): string {
  return `/${tryGetGame(gameId)?.routePrefix ?? gameId}/tracks`;
}

export function trackRoutePath(gameId: GameId, ordinal: number, tab: string = TRACK_INDEX_TAB): string {
  const base = `${tracksIndexPath(gameId)}/${ordinal}`;
  return tab === TRACK_INDEX_TAB ? base : `${base}/${tab}`;
}
