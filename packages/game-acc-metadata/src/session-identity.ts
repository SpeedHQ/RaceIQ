import { getAccCarById } from "./racing/cars/acc";
import { getAccTrackById } from "./racing/tracks/catalogs/acc";

export function isCatalogCarId(carId: string): boolean {
  return getAccCarById(carId) !== undefined;
}

export function isCatalogTrackId(trackId: string): boolean {
  return getAccTrackById(trackId) !== undefined;
}
