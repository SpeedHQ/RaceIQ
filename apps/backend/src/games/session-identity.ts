import type { GameId } from "@raceiq/shared/games/ids";
import * as fm from "@raceiq/game-fm-2023-metadata/session-identity";
import * as iracing from "@raceiq/game-iracing-metadata/session-identity";
import * as acc from "@raceiq/game-acc-metadata/session-identity";
import * as f1 from "@raceiq/game-f1-2025-metadata/session-identity";
import * as acEvo from "@raceiq/game-ac-evo-metadata/session-identity";
import * as lmu from "@raceiq/game-lmu-metadata/session-identity";
import { hasAMS2CarIdentity, hasAMS2TrackIdentity } from "@raceiq/game-ams2-metadata/index";

export function isCatalogCarId(gameId: GameId, carId: string): boolean {
  switch (gameId) {
    case "fm-2023": return fm.isCatalogCarId(carId);
    case "iracing": return iracing.isCatalogCarId(carId);
    case "acc": return acc.isCatalogCarId(carId);
    case "f1-2025": return f1.isCatalogCarId(carId);
    case "ac-evo": return acEvo.isCatalogCarId(carId);
    case "lmu": return lmu.isCatalogCarId(carId);
    case "ams2": return hasAMS2CarIdentity(carId);
    default: return false;
  }
}

export function isCatalogTrackId(gameId: GameId, trackId: string): boolean {
  switch (gameId) {
    case "fm-2023": return fm.isCatalogTrackId(trackId);
    case "iracing": return iracing.isCatalogTrackId(trackId);
    case "acc": return acc.isCatalogTrackId(trackId);
    case "f1-2025": return f1.isCatalogTrackId(trackId);
    case "ac-evo": return acEvo.isCatalogTrackId(trackId);
    case "lmu": return lmu.isCatalogTrackId(trackId);
    case "ams2": return hasAMS2TrackIdentity(trackId);
    default: return false;
  }
}

export function isSessionIdentityInCatalog(gameId: GameId, carId: string, trackId: string): boolean {
  return isCatalogCarId(gameId, carId) && isCatalogTrackId(gameId, trackId);
}
