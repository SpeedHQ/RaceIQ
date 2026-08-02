import type { GameId, SessionRecap } from "../shared/types";
import { stddevPopulation, consistencyRating } from "./lap-analysis/stats"

/** Plain lap data needed to compute a recap. Null sectors are legacy laps. */
export interface RecapLapInput {
  id: number;
  lapNumber: number;
  lapTime: number;
  isValid: boolean;
  sectorTimes: number[] | null;
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
  /**
   * Fastest ever time in each source-defined sector for this track + car +
   * game, across all OTHER sessions.
   */
  allTimeBestSectors: Array<number | null> | null;
  /** Source-defined sector starts for the session, when telemetry supplies them. */
  sectorStarts?: number[] | null;
}

function isValidLap(lap: RecapLapInput): boolean {
  return lap.isValid === true && lap.lapTime > 0;
}

/**
 * Compute a SessionRecap from plain fetched data. Pure — no DB, no throwing.
 * All edge cases resolve to a defined value; focused tests own the metric rules.
 */
export function computeRecap(input: ComputeRecapInput): SessionRecap {
  const { session, laps, carName, trackName, trackLengthM, allTimeBestSec, allTimeBestSectors } = input;

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
  let sectors: SessionRecap["sectors"] = null;
  const sectorCount =
    validLaps.find(
      (lap) =>
        lap.sectorTimes != null &&
        lap.sectorTimes.length >= 2 &&
        lap.sectorTimes.every((time) => time > 0),
    )?.sectorTimes?.length ?? 0;
  const completeSectorLaps = validLaps.filter(
    (lap) =>
      lap.sectorTimes?.length === sectorCount &&
      lap.sectorTimes.every((time) => time > 0),
  );
  if (completeSectorLaps.length > 0 && bestLapSec !== null) {
    const sessionBests = Array.from({ length: sectorCount }, (_, index) =>
      Math.min(
        ...completeSectorLaps.map((lap) => lap.sectorTimes![index]),
      ),
    );
    const sumSec = sessionBests.reduce((sum, time) => sum + time, 0);
    theoretical = {
      bestSectorTimes: sessionBests,
      sumSec,
      deltaToBestSec: Math.max(0, bestLapSec - sumSec),
    };

    // The best lap may not itself have complete sectors (a different valid lap
    // could own the fastest overall time with gaps in its sector splits). In
    // that case fall back to the session bests for every sector, and never
    // report "lost" since we have no real per-sector time from the best lap.
    const bestLapHasCompleteSectors =
      bestLap !== null &&
      bestLap.sectorTimes?.length === sectorCount &&
      bestLap.sectorTimes.every((time) => time > 0);
    const bestLapSectors = bestLapHasCompleteSectors
      ? bestLap!.sectorTimes!
      : sessionBests;

    const EPS = 1e-6;
    sectors = sessionBests.map((sessionBestSec, i) => {
      const index = i + 1;
      const bestLapSectorSec = bestLapSectors[i];
      const sectorAllTimeBestSec = allTimeBestSectors?.[i] ?? null;

      let status: "record" | "session-best" | "lost";
      if (sectorAllTimeBestSec === null || sessionBestSec < sectorAllTimeBestSec) {
        status = "record";
      } else if (!bestLapHasCompleteSectors) {
        status = "session-best";
      } else if (Math.abs(bestLapSectorSec - sessionBestSec) < EPS) {
        status = "session-best";
      } else {
        status = "lost";
      }

      return {
        index,
        bestLapSec: bestLapSectorSec,
        sessionBestSec,
        allTimeBestSec: sectorAllTimeBestSec,
        status,
      };
    });
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
    sectorStarts:
      sectors !== null && input.sectorStarts?.length === sectorCount
        ? [...input.sectorStarts]
        : null,
    theoretical,
    improvementSec,
    consistency,
    personalBest,
    sectors,
  };
}
