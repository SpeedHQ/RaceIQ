import type { GameId } from "@shared/types";

export interface StoredSectorTimes {
  gameId?: GameId;
  s1Time?: number | null;
  s2Time?: number | null;
  s3Time?: number | null;
}

/**
 * The lap table has three fixed sector slots. Native two-sector iRacing laps
 * populate s1/s2 and leave the intentionally unused third slot at zero.
 */
export function storedLapSectorCount(lap: StoredSectorTimes, gameId = lap.gameId): 2 | 3 {
  return gameId === "iracing" && (lap.s1Time ?? 0) > 0 && (lap.s2Time ?? 0) > 0 && (lap.s3Time ?? 0) === 0 ? 2 : 3;
}

export function storedLapsSectorCount(laps: readonly StoredSectorTimes[], gameId?: GameId): 2 | 3 {
  return laps.some((lap) => storedLapSectorCount(lap, gameId) === 2) ? 2 : 3;
}
