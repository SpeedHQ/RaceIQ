import type { GameId } from "../../shared/games/ids";
import type { SessionRecap } from "../../shared/sessions/types";
import { stddevPopulation, consistencyRating } from "./stats";

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
  const validLaps: RecapLapInput[] = [];
  const validLapTimes: number[] = [];
  let bestLap: RecapLapInput | null = null;
  let firstValidLap: RecapLapInput | null = null;
  let timeOnTrackSec = 0;
  for (const lap of laps) {
    if (!isValidLap(lap)) continue;
    validLaps.push(lap);
    validLapTimes.push(lap.lapTime);
    timeOnTrackSec += lap.lapTime;
    if (bestLap === null || lap.lapTime < bestLap.lapTime) bestLap = lap;
    if (firstValidLap === null || lap.lapNumber < firstValidLap.lapNumber) firstValidLap = lap;
  }
  const lapsValid = validLaps.length;
  const bestLapSec = bestLap?.lapTime ?? null;
  const bestLapId = bestLap?.id ?? null;

  const distanceM = trackLengthM !== null ? trackLengthM * lapsValid : null;

  const sparkline = laps.map((l) => ({
    lapId: l.id,
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
    const sessionBests = new Array<number>(sectorCount).fill(Infinity);
    for (const lap of completeSectorLaps) {
      for (let index = 0; index < sectorCount; index++) {
        sessionBests[index] = Math.min(sessionBests[index], lap.sectorTimes![index]);
      }
    }
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
  if (lapsValid >= 2 && bestLapSec !== null && firstValidLap !== null) {
    improvementSec = Math.max(0, firstValidLap.lapTime - bestLapSec);
  }

  let consistency: SessionRecap["consistency"] = null;
  if (lapsValid >= 3 && bestLapSec !== null) {
    const stdDevSec = stddevPopulation(validLapTimes);
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
