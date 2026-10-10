import type { GameId } from "@raceiq/shared/games/ids";
import type { DashboardFavourite, DashboardResponse } from "@raceiq/shared/racing/sessions/dashboard";

export interface FavouriteInsight extends Omit<DashboardFavourite, "identity"> { identity: number | string }
export type SessionTypeKind = "practice" | "qualifying" | "race";
export interface DashboardInsights {
  clean: { valid: number; total: number; rate: number | null; trend: { timestamp: number; valid: number; total: number; rate: number }[] };
  podiums: { total: number; first: number; second: number; third: number; available: boolean; trend: { timestamp: number; podiums: number }[] };
  trackDistribution: { totalSeconds: number; tracks: { key: string; gameId: GameId; trackIdentity: string; trackOrdinal?: number; seconds: number; share: number }[]; othersSeconds: number; othersShare: number; othersCount: number };
  consistency: { sessions: number; averageStandardDeviation: number | null; deviations: number[] };
  sessionStats: { sessionTypes: { kind: SessionTypeKind; seconds: number; share: number }[]; sessionTypeTotalSeconds: number; unclassifiedSeconds: number; unclassifiedShare: number };
  favouriteTrack: FavouriteInsight | null;
  favouriteCar: FavouriteInsight | null;
}

export function dashboardInsights(response: DashboardResponse): DashboardInsights {
  let valid = 0;
  let total = 0;
  // Trend charts use cumulative daily bucket counts with exact interval endpoints; no client-side source-row reconstruction.
  const cleanTrend = [{ timestamp: Date.parse(response.request.from), valid, total, rate: 0 }, ...response.calendar.map((bucket) => {
    valid += bucket.validLaps;
    total += bucket.positiveLaps;
    return { timestamp: Date.parse(bucket.to), valid, total, rate: total ? valid / total : 0 };
  })];
  let cumulativePodiums = 0;
  const podiumTrend = [{ timestamp: Date.parse(response.request.from), podiums: 0 }, ...response.calendar.map((bucket) => {
    cumulativePodiums += bucket.podiums;
    return { timestamp: Date.parse(bucket.to), podiums: cumulativePodiums };
  })];
  const end = Date.parse(response.request.to);
  const cleanLast = cleanTrend[cleanTrend.length - 1]!;
  if (cleanLast.timestamp !== end) cleanTrend.push({ ...cleanLast, timestamp: end });
  const podiumLast = podiumTrend[podiumTrend.length - 1]!;
  if (podiumLast.timestamp !== end) podiumTrend.push({ ...podiumLast, timestamp: end });
  const distribution = response.trackDistribution;
  return {
    clean: { valid: response.totals.validLaps, total: response.totals.positiveLaps, rate: response.totals.positiveLaps ? response.totals.validLaps / response.totals.positiveLaps : null, trend: cleanTrend },
    podiums: { total: response.podiums.total, first: response.podiums.first, second: response.podiums.second, third: response.podiums.third, available: response.podiums.available, trend: podiumTrend },
    trackDistribution: { totalSeconds: distribution.totalSeconds, tracks: distribution.topFive.map((track) => ({ key: `${track.gameId}:${track.identity}`, gameId: track.gameId, trackIdentity: track.identity, ...(track.ordinal == null ? {} : { trackOrdinal: track.ordinal }), seconds: track.seconds, share: track.share })), othersSeconds: distribution.othersSeconds, othersShare: distribution.othersShare, othersCount: distribution.othersCount },
    consistency: response.consistency,
    sessionStats: { sessionTypes: response.sessionTypes.shares.filter((share): share is typeof share & { kind: SessionTypeKind } => share.kind !== "unknown"), sessionTypeTotalSeconds: response.sessionTypes.totalSeconds, unclassifiedSeconds: response.sessionTypes.unknownSeconds, unclassifiedShare: response.sessionTypes.unknownShare },
    favouriteTrack: response.favouriteTrack ? { ...response.favouriteTrack, identity: response.favouriteTrack.nativeId ?? response.favouriteTrack.identity } : null,
    favouriteCar: response.favouriteCar ? { ...response.favouriteCar, identity: response.favouriteCar.nativeId ?? response.favouriteCar.identity } : null,
  };
}
