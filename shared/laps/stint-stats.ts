import { clamp } from "../math/numbers";
import type { LapMeta } from "../sessions/types";

/**
 * Stint-level pace statistics. Lives in shared/ rather than client/ because the
 * driver-profile aggregator (server-side) needs the same consistency and
 * degradation numbers the stint view shows — two implementations would drift
 * and quietly disagree about how consistent a driver is.
 *
 * Mirrors the precedent set by @shared/laps/trace/build, which moved out of the
 * client for the same reason.
 */

export interface StintStats {
  /** clamp(100 - (sd/mean)*100*28, 0, 100); undefined when n < 2. */
  consistency: number | undefined;
  sdS: number | undefined;
  bestS: number | undefined;
  meanS: number | undefined;
  /** OLS slope of lapTime vs lapNumber (s/lap); undefined when n < 3. */
  degSlopeSPerLap: number | undefined;
  n: number;
}

export function repeatabilityStats(values: readonly number[]): {
  n: number;
  mean: number | null;
  sd: number | null;
  consistency: number | null;
} {
  let n = 0;
  let mean = 0;
  for (const value of values) {
    if (!Number.isFinite(value) || value <= 0) continue;
    n += 1;
    mean += (value - mean) / n;
  }
  if (n === 0) return { n, mean: null, sd: null, consistency: null };
  if (n === 1) return { n, mean, sd: null, consistency: null };

  let scale = 0;
  let sumSquares = 0;
  for (const value of values) {
    if (!Number.isFinite(value) || value <= 0) continue;
    const deviation = Math.abs(value - mean);
    if (deviation === 0) continue;
    if (deviation > scale) {
      const ratio = scale / deviation;
      sumSquares = sumSquares * ratio * ratio + 1;
      scale = deviation;
    } else {
      sumSquares += (deviation / scale) ** 2;
    }
  }
  const sd = scale * Math.sqrt(sumSquares / n);
  const consistency = clamp(100 - (sd / mean) * 100 * 28, 0, 100);
  return { n, mean, sd, consistency };
}

/**
 * Stint-level stats computed purely from LapMeta lap times — valid,
 * non-experiment-excluded laps, excluding the stint's first lap
 * (lapNumber === Math.min(...)) which is treated as an out-lap.
 *
 * Pass `dropOutLap: false` when `laps` is already a curated pool (e.g. the
 * evaluation laps from selectEvaluationLaps) — that pool has dropped the
 * out-lap itself, so dropping the lowest lap number again would silently
 * throw away one legitimate fast lap and make `n` disagree with the caller's
 * own lap count.
 */
export function stintStats(laps: LapMeta[], opts?: { dropOutLap?: boolean }): StintStats {
  const dropOutLap = opts?.dropOutLap ?? true;
  const eligible = laps.filter((l) => l.isValid && !l.experimentExcluded);
  const minLapNumber = dropOutLap && eligible.length > 0 ? Math.min(...eligible.map((l) => l.lapNumber)) : null;
  const scored = minLapNumber === null ? eligible : eligible.filter((l) => l.lapNumber !== minLapNumber);
  const repeatability = repeatabilityStats(scored.map((l) => l.lapTime));
  const n = repeatability.n;

  if (n === 0) {
    return { consistency: undefined, sdS: undefined, bestS: undefined, meanS: undefined, degSlopeSPerLap: undefined, n };
  }

  const scoredQualifying = scored.filter((l) => Number.isFinite(l.lapTime) && l.lapTime > 0);
  const times = scoredQualifying.map((l) => l.lapTime);
  const bestS = Math.min(...times);
  const meanS = repeatability.mean!;
  const sdS = repeatability.sd === null ? undefined : repeatability.sd;
  const consistency = repeatability.consistency === null ? undefined : repeatability.consistency;

  let degSlopeSPerLap: number | undefined;
  if (n >= 3) {
    const xs = scoredQualifying.map((l) => l.lapNumber);
    const xMean = xs.reduce((a, b) => a + b, 0) / n;
    const yMean = meanS;
    let num = 0;
    let den = 0;
    for (let i = 0; i < n; i++) {
      num += (xs[i] - xMean) * (times[i] - yMean);
      den += (xs[i] - xMean) ** 2;
    }
    degSlopeSPerLap = den > 0 ? num / den : 0;
  }

  return { consistency, sdS, bestS, meanS, degSlopeSPerLap, n };
}
