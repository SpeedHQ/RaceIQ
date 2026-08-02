/**
 * Small, dependency-free lap-time statistics shared across the recap and
 * setup-engineer clean-lap aggregate. Pure — no DB, no throwing.
 */

export function stddevPopulation(values: number[]): number {
  const n = values.length;
  if (n === 0) return 0;
  const mean = values.reduce((sum, v) => sum + v, 0) / n;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / n;
  return Math.sqrt(variance);
}

export function consistencyRating(stdDevSec: number, bestLapSec: number): 1 | 2 | 3 | 4 | 5 {
  if (bestLapSec <= 0) return 1;
  const ratio = stdDevSec / bestLapSec;
  if (ratio < 0.01) return 5;
  if (ratio < 0.02) return 4;
  if (ratio < 0.04) return 3;
  if (ratio < 0.07) return 2;
  return 1;
}
