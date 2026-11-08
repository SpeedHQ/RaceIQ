import { lmuCarCatalog, lmuTrackCatalog } from "./catalog";

export function isCatalogCarId(carId: string): boolean {
  return lmuCarCatalog.some((car) => car.id === carId);
}

export function isCatalogTrackId(trackId: string): boolean {
  return lmuTrackCatalog.some((track) => track.id === trackId);
}
