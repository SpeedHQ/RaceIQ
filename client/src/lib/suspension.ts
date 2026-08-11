/**
 * Convert absolute suspension travel in metres to the normalized 0–1 range
 * used by load-transfer visualizations.
 */
export interface SuspensionTravelRangeMm {
  min: number;
  max: number;
}

export const DEFAULT_SUSPENSION_TRAVEL_RANGE_MM: SuspensionTravelRangeMm = { min: 20, max: 80 };

export function normalizeSuspensionTravel(
  values: readonly unknown[],
  range: SuspensionTravelRangeMm = DEFAULT_SUSPENSION_TRAVEL_RANGE_MM,
): [number, number, number, number] {
  const span = range.max - range.min;
  if (span <= 0) return [0, 0, 0, 0];
  return [0, 1, 2, 3].map((index) => {
    const value = values[index];
    if (typeof value !== "number" || !Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(1, (value * 1000 - range.min) / span));
  }) as [number, number, number, number];
}
