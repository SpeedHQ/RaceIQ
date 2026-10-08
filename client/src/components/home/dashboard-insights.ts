import type { GameId } from "@raceiq/shared/games/ids";
import { isPracticeSession } from "@raceiq/shared/racing/sessions/session-type";
import type { LapMeta, SessionMeta } from "@raceiq/shared/racing/sessions/types";
import { parseUtcTimestamp } from "../../lib/utc-date";

export interface DashboardInsights {
  clean: { valid: number; total: number; rate: number | null };
  podiums: {
    total: number;
    first: number;
    second: number;
    third: number;
    available: boolean;
    otherPositions: { position: number; count: number }[];
  };
  trackDistribution: {
    totalSeconds: number;
    tracks: { key: string; gameId: GameId; trackIdentity: string; trackOrdinal?: number; seconds: number; share: number }[];
    othersSeconds: number;
    othersShare: number;
    othersCount: number;
  };
  consistency: {
    sessions: number;
    averageStandardDeviation: number | null;
    deviations: number[];
  };
  trackContext: DashboardTrackContext | null;
  trackAnalytics: {
    sessionTypes: { kind: SessionTypeKind; seconds: number; share: number }[];
    sessionTypeTotalSeconds: number;
  } | null;
}

export interface DashboardTrackContext {
  gameId: GameId;
  trackIdentity: string;
  trackOrdinal?: number;
  carIdentity: string;
  carOrdinal?: number;
  latestTimestamp: number;
  latestLapId: number;
}

export type SessionTypeKind = "practice" | "qualifying" | "race";

export const CONSISTENCY_DEVIATION_BOUNDS = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9] as const;
function timestamp(lap: LapMeta): number {
  const date = parseUtcTimestamp(lap.createdAt);
  return Number.isFinite(date.getTime()) ? date.getTime() : Number.NaN;
}

function positiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function validPosition(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value > 0;
}

function identity(value: number | string | null | undefined, fallback: number | undefined, prefix: string): string | null {
  const isKnown = (candidate: number | string | null | undefined): candidate is number | string =>
    candidate != null && !(typeof candidate === "number" && candidate === -1);
  const selected = isKnown(value) ? value : isKnown(fallback) ? fallback : null;
  return selected == null ? null : `${prefix}:${typeof selected}:${selected}`;
}

function lapTrackIdentity(lap: LapMeta): string | null {
  return identity(lap.trackId, lap.trackOrdinal, "track");
}

function lapCarIdentity(lap: LapMeta): string | null {
  return identity(lap.carId, lap.carOrdinal, "car");
}

function trackContextForLap(lap: LapMeta): DashboardTrackContext | null {
  if (!lap.gameId) return null;
  const trackIdentity = lapTrackIdentity(lap);
  const carIdentity = lapCarIdentity(lap);
  if (!trackIdentity || !carIdentity) return null;
  const date = timestamp(lap);
  return {
    gameId: lap.gameId,
    trackIdentity,
    trackOrdinal: lap.trackOrdinal === -1 ? undefined : lap.trackOrdinal,
    carIdentity,
    carOrdinal: lap.carOrdinal === -1 ? undefined : lap.carOrdinal,
    latestTimestamp: date,
    latestLapId: lap.id,
  };
}

function classifySessionType(value: string | null | undefined): SessionTypeKind | null {
  const type = value?.trim().toLowerCase();
  if (isPracticeSession(type)) return "practice";
  if (type?.startsWith("qualifying") || type?.startsWith("qualify")) return "qualifying";
  if (type?.startsWith("race")) return "race";
  return null;
}

export function buildDashboardInsights(
  laps: readonly LapMeta[],
  sessions: readonly SessionMeta[],
  gameId: GameId | null,
  now = new Date(),
): DashboardInsights {
  const nowTime = now.getTime();
  const eligibleLaps = laps
    .filter((lap) => lap.ownership !== "others" && (gameId === null || lap.gameId === gameId))
    .filter((lap) => {
      const time = timestamp(lap);
      return Number.isFinite(time) && time <= nowTime;
    })
    .sort((a, b) => timestamp(a) - timestamp(b) || a.id - b.id);
  const cleanLaps = eligibleLaps.filter((lap) => positiveFinite(lap.lapTime)).slice(-20);
  const valid = cleanLaps.filter((lap) => lap.isValid).length;

  const seenSessions = new Set<number>();
  let first = 0;
  let second = 0;
  let third = 0;
  const otherPositionCounts = new Map<number, number>();
  let podiumsAvailable = false;
  for (const session of sessions) {
    if (
      session.ownership === "others" ||
      (gameId !== null && session.gameId !== gameId) ||
      session.resultOutcomeStatus !== "confirmed" ||
      session.resultClassification !== "finished"
    ) continue;
    if (seenSessions.has(session.id)) continue;
    seenSessions.add(session.id);
    const date = parseUtcTimestamp(session.createdAt);
    if (!Number.isFinite(date.getTime()) || date.getTime() > nowTime) continue;
    const sessionType = session.sessionType?.trim().toLowerCase();
    if (isPracticeSession(sessionType) || !sessionType?.startsWith("race") || !validPosition(session.finishingPosition)) continue;
    podiumsAvailable = true;
    if (session.finishingPosition === 1) first += 1;
    else if (session.finishingPosition === 2) second += 1;
    else if (session.finishingPosition === 3) third += 1;
    else otherPositionCounts.set(session.finishingPosition, (otherPositionCounts.get(session.finishingPosition) ?? 0) + 1);
  }

  const sessionsById = new Map<number, { session: SessionMeta; time: number }>();
  for (const session of sessions) {
    if (session.ownership === "others" || (gameId !== null && session.gameId !== gameId)) continue;
    const time = parseUtcTimestamp(session.createdAt).getTime();
    if (!Number.isFinite(time) || time > nowTime) continue;
    const existing = sessionsById.get(session.id);
    if (!existing || time > existing.time) sessionsById.set(session.id, { session, time });
  }
  const orderedSessions = [...sessionsById.values()].sort((a, b) => b.time - a.time || b.session.id - a.session.id);
  const sessionMap = new Map(orderedSessions.map(({ session }) => [session.id, session]));
  const recentSessions = orderedSessions.slice(0, 10).map(({ session }) => session);

  const seenLapIds = new Set<number>();
  const uniqueLaps = eligibleLaps.filter((lap) => {
    if (seenLapIds.has(lap.id)) return false;
    seenLapIds.add(lap.id);
    return true;
  });

  const trackSeconds = new Map<string, { gameId: GameId; trackIdentity: string; trackOrdinal?: number; seconds: number }>();
  for (const lap of uniqueLaps) {
    if (!positiveFinite(lap.lapTime) || !lap.gameId) continue;
    const knownTrackIdentity = lapTrackIdentity(lap);
    const trackIdentity = knownTrackIdentity ?? "track:unknown";
    const trackOrdinal = knownTrackIdentity && lap.trackOrdinal !== -1 ? lap.trackOrdinal : undefined;
    const key = JSON.stringify([lap.gameId, trackIdentity]);
    const aggregate = trackSeconds.get(key) ?? { gameId: lap.gameId, trackIdentity, trackOrdinal, seconds: 0 };
    aggregate.seconds += lap.lapTime;
    trackSeconds.set(key, aggregate);
  }
  const rankedTracks = [...trackSeconds.entries()]
    .map(([key, track]) => ({ key, ...track }))
    .sort((a, b) => b.seconds - a.seconds || a.trackIdentity.localeCompare(b.trackIdentity));
  const totalTrackSeconds = rankedTracks.reduce((total, track) => total + track.seconds, 0);
  const topTracks = rankedTracks.slice(0, 5).map((track) => ({ ...track, share: track.seconds / totalTrackSeconds }));
  const otherTracks = rankedTracks.slice(5);
  const othersSeconds = otherTracks.reduce((total, track) => total + track.seconds, 0);

  let newestRecordedContext: DashboardTrackContext | null = null;
  let newestValidContext: DashboardTrackContext | null = null;
  for (const lap of uniqueLaps) {
    if (!positiveFinite(lap.lapTime)) continue;
    const context = trackContextForLap(lap);
    if (!context) continue;
    if (!newestRecordedContext || context.latestTimestamp > newestRecordedContext.latestTimestamp || (context.latestTimestamp === newestRecordedContext.latestTimestamp && context.latestLapId > newestRecordedContext.latestLapId)) {
      newestRecordedContext = context;
    }
    if (lap.isValid && (!newestValidContext || context.latestTimestamp > newestValidContext.latestTimestamp || (context.latestTimestamp === newestValidContext.latestTimestamp && context.latestLapId > newestValidContext.latestLapId))) {
      newestValidContext = context;
    }
  }
  const trackContext = newestValidContext ?? newestRecordedContext;
  const sessionLapGroups = new Map<number, LapMeta[]>();
  for (const lap of uniqueLaps) {
    if (!lap.isValid || !positiveFinite(lap.lapTime)) continue;
    const group = sessionLapGroups.get(lap.sessionId) ?? [];
    group.push(lap);
    sessionLapGroups.set(lap.sessionId, group);
  }
  const sessionDeviations: number[] = [];
  for (const session of recentSessions) {
    const validLaps = sessionLapGroups.get(session.id) ?? [];
    if (validLaps.length < 2) continue;
    const firstLap = validLaps[0];
    const trackIdentity = lapTrackIdentity(firstLap);
    const carIdentity = lapCarIdentity(firstLap);
    if (!firstLap.gameId || !trackIdentity || !carIdentity || (session.gameId && session.gameId !== firstLap.gameId)) continue;
    const contextIsConsistent = validLaps.every((lap) => (
      lap.gameId === firstLap.gameId &&
      lapTrackIdentity(lap) === trackIdentity &&
      lapCarIdentity(lap) === carIdentity &&
      (!session.gameId || session.gameId === lap.gameId)
    ));
    if (!contextIsConsistent) continue;
    const mean = validLaps.reduce((sum, lap) => sum + lap.lapTime, 0) / validLaps.length;
    sessionDeviations.push(Math.sqrt(validLaps.reduce((sum, lap) => sum + (lap.lapTime - mean) ** 2, 0) / validLaps.length));
  }
  const averageStandardDeviation = sessionDeviations.length > 0
    ? sessionDeviations.reduce((sum, deviation) => sum + deviation, 0) / sessionDeviations.length
    : null;
  const deviationCounts = Array<number>(CONSISTENCY_DEVIATION_BOUNDS.length + 1).fill(0);
  for (const deviation of sessionDeviations) {
    const boundIndex = CONSISTENCY_DEVIATION_BOUNDS.findIndex((bound) => deviation < bound);
    const bucket = boundIndex === -1 ? CONSISTENCY_DEVIATION_BOUNDS.length : boundIndex;
    deviationCounts[bucket] += 1;
  }

  const trackAnalyticsLaps = trackContext
    ? uniqueLaps.filter((lap) => positiveFinite(lap.lapTime) && lap.gameId === trackContext.gameId && lapTrackIdentity(lap) === trackContext.trackIdentity)
    : [];
  const sessionTypeSeconds = new Map<SessionTypeKind, number>([["practice", 0], ["qualifying", 0], ["race", 0]]);
  for (const lap of trackAnalyticsLaps) {
    const session = sessionMap.get(lap.sessionId);
    if (!session || (session.gameId && session.gameId !== lap.gameId)) continue;
    const kind = classifySessionType(session.sessionType);
    if (!kind) continue;
    sessionTypeSeconds.set(kind, (sessionTypeSeconds.get(kind) ?? 0) + lap.lapTime);
  }
  const sessionTypeTotalSeconds = [...sessionTypeSeconds.values()].reduce((total, seconds) => total + seconds, 0);
  const sessionTypes = (["practice", "qualifying", "race"] as const).map((kind) => {
    const seconds = sessionTypeSeconds.get(kind) ?? 0;
    return { kind, seconds, share: sessionTypeTotalSeconds > 0 ? seconds / sessionTypeTotalSeconds : 0 };
  });

  return {
    clean: { valid, total: cleanLaps.length, rate: cleanLaps.length === 0 ? null : valid / cleanLaps.length },
    podiums: {
      total: first + second + third,
      first,
      second,
      third,
      available: podiumsAvailable,
      otherPositions: [...otherPositionCounts]
        .sort(([a], [b]) => a - b)
        .map(([position, count]) => ({ position, count })),
    },
    trackDistribution: {
      totalSeconds: totalTrackSeconds,
      tracks: topTracks,
      othersSeconds,
      othersShare: totalTrackSeconds > 0 ? othersSeconds / totalTrackSeconds : 0,
      othersCount: otherTracks.length,
    },
    consistency: {
      sessions: sessionDeviations.length,
      averageStandardDeviation,
      deviations: deviationCounts,
    },
    trackContext,
    trackAnalytics: trackContext ? {
      sessionTypes,
      sessionTypeTotalSeconds,
    } : null,
  };
}
