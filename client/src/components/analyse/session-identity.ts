import { cars, tracks } from "@raceiq/game-acc-metadata/parser-data";
import type { GameId } from "@raceiq/shared/games/ids";

const accCars = new Set<string>(cars.map((car) => car.model));
const accTracks = new Set<string>(tracks.map((track) => track.setupFolder));

export function isKnownSessionIdentity(
  gameId: GameId,
  carId: string,
  trackId: string,
  carIds: ReadonlySet<string>,
  trackIds: ReadonlySet<string>,
): boolean {
  return (carIds.has(carId) || (gameId === "acc" && accCars.has(carId))) &&
    (trackIds.has(trackId) || (gameId === "acc" && accTracks.has(trackId)));
}
