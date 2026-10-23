import { getAllAccCars } from "@raceiq/game-acc-metadata/racing/cars/acc";
import { getAccTracks } from "@raceiq/game-acc-metadata/racing/tracks/catalogs/acc";
import { getAllAcEvoCars } from "@raceiq/game-ac-evo-metadata/racing/cars/ac-evo";
import { getAcEvoTracks } from "@raceiq/game-ac-evo-metadata/racing/tracks/catalogs/ac-evo";
import { getAllF1Cars } from "@raceiq/game-f1-2025-metadata/racing/cars/f1";
import { getF1Tracks } from "@raceiq/game-f1-2025-metadata/racing/tracks/catalogs/f1";
import { getAllIRacingCars } from "@raceiq/game-iracing-metadata/racing/cars/iracing";
import { getAllIRacingTracks } from "@raceiq/game-iracing-metadata/racing/tracks/catalogs/iracing";
import { getLMUCar, getLMUTrack } from "@raceiq/game-lmu-metadata/catalog";
import type { BoardIdentifierResolver, CanonicalBoardKey, LocalBoardKey } from "./adapter";

export interface BoardIdentifierMapping {
  local: LocalBoardKey;
  canonical: CanonicalBoardKey;
}

const SUPPORTED_GAMES: Record<string, true> = { acc: true, "ac-evo": true, "f1-2025": true, iracing: true, lmu: true };

const indexed = (tracks: Set<string>, cars: Set<string>) => ({
  hasTrack: (id: string) => tracks.has(id),
  hasCar: (id: string) => cars.has(id),
});

const NATIVE_IDENTIFIERS: Record<string, { hasTrack: (id: string) => boolean; hasCar: (id: string) => boolean }> = {
  acc: indexed(new Set([...getAccTracks().keys()].map(String)), new Set(getAllAccCars().map(({ id }) => String(id)))),
  "ac-evo": indexed(new Set(getAcEvoTracks().keys()), new Set(getAllAcEvoCars().map(({ id }) => id))),
  "f1-2025": indexed(new Set([...getF1Tracks().keys()].map(String)), new Set(getAllF1Cars().map(({ id }) => id))),
  iracing: indexed(
    new Set(getAllIRacingTracks().map(({ ordinal }) => String(ordinal))),
    new Set(getAllIRacingCars().map(({ ordinal }) => String(ordinal))),
  ),
  lmu: {
    hasTrack: (id) => getLMUTrack(id) !== undefined,
    hasCar: (id) => getLMUCar(id) !== undefined,
  },
};

function nativeIdentifiers(gameId: string) {
  return NATIVE_IDENTIFIERS[gameId];
}

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

/** Resolve local native IDs to the exact same opaque selectors; upstream owns cloud membership checks. */
export function createNativeBoardIdentifierResolver(): BoardIdentifierResolver {
  return {
    resolve(input) {
      const { gameId, trackId, carId } = input;
      if (!Object.hasOwn(SUPPORTED_GAMES, gameId)) return { status: "unsupported_game" };
      const identifiers = nativeIdentifiers(gameId);
      if (!identifiers) return { status: "unsupported_game" };
      if (!identifiers.hasTrack(trackId)) return { status: "unknown_track" };
      if (!identifiers.hasCar(carId)) return { status: "unknown_car" };
      return { status: "mapped", key: { gameId, trackId, carId } };
    },
  };
}


