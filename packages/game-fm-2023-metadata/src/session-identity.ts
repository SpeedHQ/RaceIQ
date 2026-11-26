import { fmCarCatalog } from "./racing/cars/fm";
import { fmTrackCatalog } from "./racing/tracks/catalogs/fm";

export function isCatalogCarId(carId: string): boolean {
  return /^\d+$/.test(carId) && fmCarCatalog.has(Number(carId));
}

export function isCatalogTrackId(trackId: string): boolean {
  return /^\d+$/.test(trackId) && fmTrackCatalog.has(Number(trackId));
}
