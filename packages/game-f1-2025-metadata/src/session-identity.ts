import { hasF1CarOrdinal } from "./racing/cars/f1";
import { getF1Tracks } from "./racing/tracks/catalogs/f1";

export function isCatalogCarId(carId: string): boolean {
  return /^\d+$/.test(carId) && hasF1CarOrdinal(Number(carId));
}

export function isCatalogTrackId(trackId: string): boolean {
  return /^\d+$/.test(trackId) && getF1Tracks().has(Number(trackId));
}
