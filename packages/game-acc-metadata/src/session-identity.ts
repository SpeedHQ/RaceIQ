import { getAllAccCars } from "./racing/cars/acc";
import { getAccTracks } from "./racing/tracks/catalogs/acc";

export function isCatalogCarId(carId: string): boolean {
  return /^\d+$/.test(carId) && getAllAccCars().some((car) => String(car.id) === carId);
}

export function isCatalogTrackId(trackId: string): boolean {
  return /^\d+$/.test(trackId) && getAccTracks().has(Number(trackId));
}
