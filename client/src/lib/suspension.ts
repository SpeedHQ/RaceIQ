/**
 * Convert absolute suspension travel in metres to the normalized 0–1 range
 * used by load-transfer visualizations.
 */
export interface SuspensionTravelRangeMm {
  min: number;
  max: number;
}

export const DEFAULT_SUSPENSION_TRAVEL_RANGE_MM: SuspensionTravelRangeMm = { min: 20, max: 80 };

export function normalizeSuspensionTravel(values: readonly unknown[] | null | undefined, range: SuspensionTravelRangeMm = DEFAULT_SUSPENSION_TRAVEL_RANGE_MM): [number, number, number, number] {
  const span = range.max - range.min;
  if (span <= 0 || !values) return [0, 0, 0, 0];
  return [0, 1, 2, 3].map((index) => {
    const value = values[index];
    if (typeof value !== "number" || !Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(1, (value * 1000 - range.min) / span));
  }) as [number, number, number, number];
}

/** Display-only suspension-travel balance, not a measurement of wheel load.
 * Positive lateral values point right; positive longitudinal values point rearward.
 */
export function suspensionTravelBias(values: readonly unknown[] | null | undefined): { lateral: number; longitudinal: number } | null {
  if (!values || values.length < 4 || !values.slice(0, 4).every(value => typeof value === "number" && Number.isFinite(value))) return null;
  const [fl, fr, rl, rr] = (values as readonly number[]).slice(0, 4).map(Math.abs);
  const total = fl + fr + rl + rr;
  if (total <= 1e-6) return { lateral: 0, longitudinal: 0 };
  return { lateral: (fr - fl + rr - rl) / total, longitudinal: (rl + rr - fl - fr) / total };
}
