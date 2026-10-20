import type { GameId } from "@raceiq/shared/games/ids";
import { fmCarCatalog } from "@raceiq/game-fm-2023-metadata/racing/cars/fm";
import { getAllIRacingCars } from "@raceiq/game-iracing-metadata/racing/cars/iracing";
import { lmuCarCatalog, lmuTrackCatalog } from "@raceiq/game-lmu-metadata/catalog";
import { getF1Tracks } from "@raceiq/game-f1-2025-metadata/racing/tracks/catalogs/f1";
import { getAccTracks } from "@raceiq/game-acc-metadata/racing/tracks/catalogs/acc";
import { getAcEvoTracks } from "@raceiq/game-ac-evo-metadata/racing/tracks/catalogs/ac-evo";
import { getAllIRacingTracks } from "@raceiq/game-iracing-metadata/racing/tracks/catalogs/iracing";
import { hasF1CarOrdinal } from "@raceiq/game-f1-2025-metadata/racing/cars/f1";
import { getAllAccCars } from "@raceiq/game-acc-metadata/racing/cars/acc";
import { getAllAcEvoCars } from "@raceiq/game-ac-evo-metadata/racing/cars/ac-evo";
import { fmTrackCatalog } from "@raceiq/game-fm-2023-metadata/racing/tracks/catalogs/fm";

export function isCatalogCarId(gameId: GameId, carId: string): boolean {
  switch (gameId) {
    case "fm-2023": return /^\d+$/.test(carId) && fmCarCatalog.has(Number(carId));
    case "iracing": return getAllIRacingCars().some((car) => String(car.ordinal) === carId);
    case "acc": return /^\d+$/.test(carId) && getAllAccCars().some((car) => String(car.id) === carId);
    case "f1-2025": return /^\d+$/.test(carId) && hasF1CarOrdinal(Number(carId));
    case "ac-evo": return getAllAcEvoCars().some((car) => car.id === carId);
    case "lmu": return lmuCarCatalog.some((car) => car.id === carId);
    default: return false;
  }
}

export function isCatalogTrackId(gameId: GameId, trackId: string): boolean {
  switch (gameId) {
    case "fm-2023": return /^\d+$/.test(trackId) && fmTrackCatalog.has(Number(trackId));
    case "iracing": return getAllIRacingTracks().some((track) => String(track.ordinal) === trackId);
    case "acc": return /^\d+$/.test(trackId) && getAccTracks().has(Number(trackId));
    case "f1-2025": return /^\d+$/.test(trackId) && getF1Tracks().has(Number(trackId));
    case "ac-evo": return getAcEvoTracks().has(trackId);
    case "lmu": return lmuTrackCatalog.some((track) => track.id === trackId);
    default: return false;
  }
}

export function isSessionIdentityInCatalog(gameId: GameId, carId: string, trackId: string): boolean {
  return isCatalogCarId(gameId, carId) && isCatalogTrackId(gameId, trackId);
}
