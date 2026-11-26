import { getAllIRacingCars } from "./racing/cars/iracing";
import { getAllIRacingTracks } from "./racing/tracks/catalogs/iracing";

export function isCatalogCarId(carId: string): boolean {
  return getAllIRacingCars().some((car) => String(car.ordinal) === carId);
}

export function isCatalogTrackId(trackId: string): boolean {
  return getAllIRacingTracks().some((track) => String(track.ordinal) === trackId);
}
