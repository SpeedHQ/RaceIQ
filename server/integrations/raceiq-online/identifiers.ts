import type { BoardIdentifierResolver, CanonicalBoardKey, LocalBoardKey } from "./adapter";

export interface BoardIdentifierMapping {
  local: LocalBoardKey;
  canonical: CanonicalBoardKey;
}

const SUPPORTED_GAMES: Record<string, true> = { acc: true, "ac-evo": true, "f1-2025": true, iracing: true, lmu: true };

/** Exact mappings must come from reviewed service/game catalog evidence; this helper never normalizes or guesses IDs. */
export function createBoardIdentifierResolver(mappings: readonly BoardIdentifierMapping[]): BoardIdentifierResolver {
  const byLocalKey = new Map<string, CanonicalBoardKey>();
  const knownTracks = new Set<string>();
  for (const mapping of mappings) {
    const local = mapping.local;
    const canonical = mapping.canonical;
    if (!local.gameId || !local.trackId || !local.carId || !canonical.gameId || !canonical.trackId || !canonical.carId) {
      throw new TypeError("Board identifiers must be nonempty");
    }
    const trackKey = JSON.stringify([local.gameId, local.trackId]);
    const key = JSON.stringify([local.gameId, local.trackId, local.carId]);
    if (byLocalKey.has(key)) throw new TypeError("Duplicate local leaderboard identifier mapping");
    knownTracks.add(trackKey);
    byLocalKey.set(key, { ...canonical });
  }
  return {
    resolve(input) {
      const { gameId, trackId, carId } = input;
      if (!Object.hasOwn(SUPPORTED_GAMES, gameId)) return { status: "unsupported_game" };
      const trackKey = JSON.stringify([gameId, trackId]);
      const key = JSON.stringify([gameId, trackId, carId]);
      const mapped = byLocalKey.get(key);
      if (mapped) return { status: "mapped", key: mapped };
      return { status: knownTracks.has(trackKey) ? "unknown_car" : "unknown_track" };
    },
  };
}
