export function sortIRacingCars<T extends { ordinal: number; name: string }>(cars: readonly T[]): T[] {
  return cars.toSorted(
    (a, b) =>
      a.name.replace(/^\[Legacy\]\s*/i, "").localeCompare(b.name.replace(/^\[Legacy\]\s*/i, "")) ||
      a.name.localeCompare(b.name) ||
      a.ordinal - b.ordinal,
  );
}
