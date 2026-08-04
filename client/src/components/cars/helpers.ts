import { piClass } from "@/components/forza/PiBadge";
import type { Car, SortKey } from "./types";

export { piClass };
export const PI_CLASSES = ["D", "C", "B", "A", "S", "R", "P", "X"] as const;
export const DRIVETRAINS = ["FWD", "RWD", "AWD"] as const;

export function filterAndSortCars(cars: Car[], search: string, classFilter: string | null, driveFilter: string | null, sort: SortKey, sortDir: 1 | -1) {
  let list = cars.filter((car) => car.specs);
  if (classFilter) list = list.filter((car) => car.specs && piClass(car.specs.pi) === classFilter);
  if (driveFilter) list = list.filter((car) => car.specs?.drivetrain === driveFilter);
  if (search) {
    const query = search.toLowerCase();
    list = list.filter((car) => car.name.toLowerCase().includes(query) || car.specs?.division?.toLowerCase().includes(query) || car.specs?.engine?.toLowerCase().includes(query));
  }
  return [...list].sort((a, b) => {
    if (sort === "name") return sortDir * a.name.localeCompare(b.name);
    if (sort === "division") return sortDir * (a.specs?.division ?? "").localeCompare(b.specs?.division ?? "");
    const av = a.specs?.[sort] ?? -Infinity;
    const bv = b.specs?.[sort] ?? -Infinity;
    return sortDir * ((av as number) - (bv as number));
  });
}

export function formatSpeed(mph: number, speedLabel: string, fromMph: (mph: number) => number) {
  return mph ? `${fromMph(mph).toFixed(1)} ${speedLabel}` : "—";
}

export function formatBrake(ft: number, isMetric: boolean) {
  return ft ? `${isMetric ? `${(ft * 0.3048).toFixed(1)} m` : `${ft} ft`}` : "—";
}

export function formatWeight(kg: number, lbs: number, isMetric: boolean) {
  return kg ? `${isMetric ? `${kg} kg` : `${lbs} lb`}` : "—";
}
