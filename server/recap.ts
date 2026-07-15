import type { GameId, SessionRecap } from "../shared/types";

/** Plain lap data needed to compute a recap. Nullable sectors are legacy laps. */
export interface RecapLapInput {
  id: number;
  lapNumber: number;
  lapTime: number;
  isValid: boolean;
  s1Time: number | null;
  s2Time: number | null;
  s3Time: number | null;
}

export interface RecapSessionInput {
  id: number;
  carOrdinal: number;
  trackOrdinal: number;
  gameId: GameId;
  createdAt: string;
}

export interface ComputeRecapInput {
  session: RecapSessionInput;
  laps: RecapLapInput[];
  carName: string;
  trackName: string;
  /** Track length in metres, null when no outline is available. */
  trackLengthM: number | null;
  /**
   * Best valid lap time (seconds) for this track + car + game, across all
   * OTHER sessions. Null when this is the first-ever session on this
   * track + car combination.
   */
  allTimeBestSec: number | null;
}

function isValidLap(lap: RecapLapInput): boolean {
  return lap.isValid === true && lap.lapTime > 0;
}

function stddevPopulation(values: number[]): number {
  const n = values.length;
  if (n === 0) return 0;
  const mean = values.reduce((sum, v) => sum + v, 0) / n;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / n;
  return Math.sqrt(variance);
}

function consistencyRating(stdDevSec: number, bestLapSec: number): 1 | 2 | 3 | 4 | 5 {
  if (bestLapSec <= 0) return 1;
  const ratio = stdDevSec / bestLapSec;
  if (ratio < 0.01) return 5;
  if (ratio < 0.02) return 4;
  if (ratio < 0.04) return 3;
  if (ratio < 0.07) return 2;
  return 1;
}

/**
 * Compute a SessionRecap from plain fetched data. Pure — no DB, no throwing.
 * Every edge case in docs/superpowers/specs/2026-07-15-session-recap-design.md
 * resolves to a defined value; see the "Metric rules" section there.
 */
export function computeRecap(input: ComputeRecapInput): SessionRecap {
  const { session, laps, carName, trackName, trackLengthM, allTimeBestSec } = input;

  const lapsTotal = laps.length;
  const validLaps = laps.filter(isValidLap);
  const lapsValid = validLaps.length;

  // Track the best lap itself, not just its time — the client deep-links to analysing it.
  const bestLap = validLaps.reduce<RecapLapInput | null>((best, l) => (best === null || l.lapTime < best.lapTime ? l : best), null);
  const bestLapSec = bestLap?.lapTime ?? null;
  const bestLapId = bestLap?.id ?? null;

  // Valid laps only. Invalid laps are frequently detector artifacts — a real session
  // carried a single invalid 13207s lap, which rendered as "0 laps · 3h 40m on track".
  // Counting only valid laps keeps these two honest and consistent with every other metric.
  const timeOnTrackSec = validLaps.reduce((sum, l) => sum + l.lapTime, 0);

  const distanceM = trackLengthM !== null ? trackLengthM * lapsValid : null;

  const sparkline = laps.map((l) => ({
    lapNumber: l.lapNumber,
    lapTimeSec: l.lapTime,
    isValid: isValidLap(l),
  }));

  let theoretical: SessionRecap["theoretical"] = null;
  const completeSectorLaps = validLaps.filter(
    (l) => l.s1Time !== null && l.s2Time !== null && l.s3Time !== null,
  );
  if (completeSectorLaps.length > 0 && bestLapSec !== null) {
    const bestS1 = Math.min(...completeSectorLaps.map((l) => l.s1Time as number));
    const bestS2 = Math.min(...completeSectorLaps.map((l) => l.s2Time as number));
    const bestS3 = Math.min(...completeSectorLaps.map((l) => l.s3Time as number));
    const sumSec = bestS1 + bestS2 + bestS3;
    theoretical = {
      bestS1,
      bestS2,
      bestS3,
      sumSec,
      deltaToBestSec: Math.max(0, bestLapSec - sumSec),
    };
  }

  let improvementSec: number | null = null;
  if (lapsValid >= 2 && bestLapSec !== null) {
    const firstValidLap = validLaps.reduce((earliest, l) =>
      l.lapNumber < earliest.lapNumber ? l : earliest,
    );
    improvementSec = Math.max(0, firstValidLap.lapTime - bestLapSec);
  }

  let consistency: SessionRecap["consistency"] = null;
  if (lapsValid >= 3 && bestLapSec !== null) {
    const stdDevSec = stddevPopulation(validLaps.map((l) => l.lapTime));
    consistency = { stdDevSec, rating: consistencyRating(stdDevSec, bestLapSec) };
  }

  let personalBest: SessionRecap["personalBest"] = null;
  if (bestLapSec !== null) {
    const isNew = allTimeBestSec === null || bestLapSec < allTimeBestSec;
    personalBest = { isNew, previousBestSec: allTimeBestSec };
  }

  return {
    sessionId: session.id,
    gameId: session.gameId,
    carName,
    trackName,
    createdAt: session.createdAt,
    carOrdinal: session.carOrdinal,
    trackOrdinal: session.trackOrdinal,
    lapsValid,
    lapsTotal,
    bestLapSec,
    bestLapId,
    timeOnTrackSec,
    distanceM,
    sparkline,
    theoretical,
    improvementSec,
    consistency,
    personalBest,
  };
}
