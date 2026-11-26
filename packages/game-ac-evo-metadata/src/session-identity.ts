import { getAllAcEvoCars } from "./racing/cars/ac-evo";
import { getAcEvoTracks } from "./racing/tracks/catalogs/ac-evo";

export function isCatalogCarId(carId: string): boolean {
  return getAllAcEvoCars().some((car) => car.id === carId);
}

export function isCatalogTrackId(trackId: string): boolean {
  return getAcEvoTracks().has(trackId);
}
