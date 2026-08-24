import { clamp } from "@shared/core/numbers";
import type { LapMeta } from "../sessions/types";
import type { EligibilityDecision } from "../quality/contracts";
import { evaluateAllEligibility, evaluateGroupEligibility, isEligibilityUsable, resolveEligibilityDecision } from "../quality/policies";

/**
 * Stint-level pace statistics. Lives in shared/ rather than client/ because the
 * driver-profile aggregator (server-side) needs the same consistency and
 * degradation numbers the stint view shows — two implementations would drift
 * and quietly disagree about how consistent a driver is.
 *
 * Mirrors the precedent set by @shared/racing/laps/trace/build, which moved out of the
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
  falloffEligibility: EligibilityDecision;
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
 * Stint-level pace stats. Existing callers use validity and explicit out-lap
 * curation; canonical session runs opt into policy-backed eligibility.
 */
export function stintStats(
  laps: LapMeta[],
  options: {
    dropOutLap?: boolean;
    paceSegmentId?: string | null;
  } = {},
): StintStats {
  const policyBacked = options.paceSegmentId !== undefined;
  const eligible = policyBacked
    ? laps.flatMap((lap) => {
        const normalPace = resolveEligibilityDecision(lap, "normal-pace");
        return Number.isFinite(lap.lapTime) &&
          lap.lapTime > 0 &&
          isEligibilityUsable(normalPace) &&
          !lap.experimentExcluded
          ? [{ lap, normalPace }]
          : [];
      })
    : laps
        .filter((lap) => lap.isValid && !lap.experimentExcluded)
        .map((lap) => ({
          lap,
          normalPace: resolveEligibilityDecision(lap, "normal-pace"),
        }));
  const dropOutLap = options.dropOutLap ?? !policyBacked;
  const firstLapNumber =
    dropOutLap && eligible.length > 0
      ? Math.min(...eligible.map(({ lap }) => lap.lapNumber))
      : null;
  const scored =
    firstLapNumber === null
      ? eligible
      : eligible.filter(({ lap }) => lap.lapNumber !== firstLapNumber);
  const falloffDecision = evaluateGroupEligibility(
    "stint-falloff",
    scored.flatMap(({ lap, normalPace }) =>
      lap.quality
        ? [
            {
              lapId: lap.id,
              lapTime: lap.lapTime,
              quality: lap.quality,
              eligibility: { ...evaluateAllEligibility(lap.quality), ...lap.eligibility, "normal-pace": normalPace },
            },
          ]
        : [],
    ),
    { paceSegmentId: options.paceSegmentId ?? null },
  );
  const repeatability = repeatabilityStats(scored.map(({ lap }) => lap.lapTime));
  const n = repeatability.n;

  if (n === 0) {
    return { consistency: undefined, sdS: undefined, bestS: undefined, meanS: undefined, degSlopeSPerLap: undefined, n, falloffEligibility: falloffDecision };
  }

  const scoredQualifying = scored.map(({ lap }) => lap).filter((lap) => Number.isFinite(lap.lapTime) && lap.lapTime > 0);
  const times = scoredQualifying.map((lap) => lap.lapTime);
  const bestS = Math.min(...times);
  const meanS = repeatability.mean!;
  const sdS = repeatability.sd === null ? undefined : repeatability.sd;
  const consistency = repeatability.consistency === null ? undefined : repeatability.consistency;

  let degSlopeSPerLap: number | undefined;
  if (n >= 3 && (!policyBacked || isEligibilityUsable(falloffDecision))) {
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

  return { consistency, sdS, bestS, meanS, degSlopeSPerLap, n, falloffEligibility: falloffDecision };
}
