import { clamp } from "../stint-trace";
import type { LapMeta } from "../types";

/**
 * Stint-level pace statistics. Lives in shared/ rather than client/ because the
 * driver-profile aggregator (server-side) needs the same consistency and
 * degradation numbers the stint view shows — two implementations would drift
 * and quietly disagree about how consistent a driver is.
 *
 * Mirrors the precedent set by @shared/stint-trace, which moved out of the
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

/**
 * Stint-level stats computed purely from LapMeta lap times — valid,
 * non-tuning-excluded laps, excluding the stint's first lap
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
  const eligible = laps.filter((l) => l.isValid && !l.tuningExcluded);
  const minLapNumber = dropOutLap && eligible.length > 0 ? Math.min(...eligible.map((l) => l.lapNumber)) : null;
  const scored = minLapNumber === null ? eligible : eligible.filter((l) => l.lapNumber !== minLapNumber);
  const n = scored.length;

  if (n === 0) {
    return { consistency: undefined, sdS: undefined, bestS: undefined, meanS: undefined, degSlopeSPerLap: undefined, n };
  }

  const times = scored.map((l) => l.lapTime);
  const bestS = Math.min(...times);
  const meanS = times.reduce((a, b) => a + b, 0) / n;

  let sdS: number | undefined;
  let consistency: number | undefined;
  if (n >= 2) {
    const variance = times.reduce((a, t) => a + (t - meanS) ** 2, 0) / n;
    sdS = Math.sqrt(variance);
    consistency = meanS > 0 ? clamp(100 - (sdS / meanS) * 100 * 28, 0, 100) : undefined;
  }

  let degSlopeSPerLap: number | undefined;
  if (n >= 3) {
    const xs = scored.map((l) => l.lapNumber);
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
