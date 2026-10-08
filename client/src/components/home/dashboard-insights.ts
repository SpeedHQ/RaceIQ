import type { GameId } from "@raceiq/shared/games/ids";
import { isPracticeSession } from "@raceiq/shared/racing/sessions/session-type";
import type { LapMeta, SessionMeta } from "@raceiq/shared/racing/sessions/types";
import { parseUtcTimestamp } from "../../lib/utc-date";
import { resolveLMUTrack } from "@raceiq/game-lmu-metadata/catalog";
export type TrackLengthLookup = Readonly<Record<string, number>>;


export interface FavouriteInsight {
  gameId: GameId;
  identity: number | string;
  ordinal?: number;
  seconds: number;
  laps: number;
  sessions: number;
  distanceMeters: number | null;
  distanceLaps: number;
  podiums: number | null;
}

export interface DashboardInsights {
  clean: {
    valid: number;
    total: number;
    rate: number | null;
    trend: { lapId: number; timestamp: number; valid: number; total: number; rate: number }[];
  };
  podiums: {
    total: number;
    first: number;
    second: number;
    third: number;
    available: boolean;
    otherPositions: { position: number; count: number }[];
    rate: number | null;
    trend: { sessionId: number; timestamp: number; podiums: number; first: number; second: number; third: number; total: number; rate: number }[];
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
  sessionStats: {
    sessionTypes: { kind: SessionTypeKind; seconds: number; share: number }[];
    sessionTypeTotalSeconds: number;
    unclassifiedSeconds: number;
    unclassifiedShare: number;
  };
  favouriteTrack: FavouriteInsight | null;
  favouriteCar: FavouriteInsight | null;
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

function classifySessionType(value: string | null | undefined): SessionTypeKind | null {
  const type = value?.trim().toLowerCase();
  if (isPracticeSession(type)) return "practice";
  if (type?.startsWith("qualifying") || type?.startsWith("qualify")) return "qualifying";
  if (type?.startsWith("race")) return "race";
  return null;
}
function buildFavouriteInsight(
  laps: readonly LapMeta[],
  sessions: readonly SessionMeta[],
  selectedGameId: GameId | null,
  nowTime: number,
  kind: "track" | "car",
  trackLengths: TrackLengthLookup,
): FavouriteInsight | null {
  type Aggregate = {
    gameId: GameId; identity: number | string; ordinal?: number; seconds: number; laps: number;
    sessionIds: Set<number>; distanceMeters: number; distanceLaps: number; hasDistance: boolean;
    podiums: number; hasPodiumEvidence: boolean;
  };
  const identityFor = (item: LapMeta | SessionMeta): string | null => kind === "track"
    ? identity(item.trackId, item.trackOrdinal, "track")
    : identity(item.carId, item.carOrdinal, "car");
  const aggregates = new Map<string, Aggregate>();
  const uniqueLaps = new Map<number, LapMeta>();
  for (const lap of laps) {
    const time = timestamp(lap);
    if (lap.ownership === "others" || !lap.gameId || (selectedGameId !== null && lap.gameId !== selectedGameId)
      || lap.invalidReason === "incomplete" || !positiveFinite(lap.lapTime) || !Number.isFinite(time) || time > nowTime || !identityFor(lap)) continue;
    const current = uniqueLaps.get(lap.id);
    if (!current || time < timestamp(current)) uniqueLaps.set(lap.id, lap);
  }
  const lengths = new Map<string, number | null>();
  for (const lap of uniqueLaps.values()) {
    const raw = kind === "track" ? lap.trackId : lap.carId;
    const ordinal = kind === "track" ? lap.trackOrdinal : lap.carOrdinal;
    const entityIdentity = identityFor(lap);
    if (!entityIdentity || !lap.gameId) continue;
    const key = JSON.stringify([lap.gameId, entityIdentity]);
    const entity = raw != null && !(typeof raw === "number" && raw === -1) ? raw : ordinal;
    if (entity === undefined) continue;
    let aggregate = aggregates.get(key);
    if (!aggregate) {
      aggregate = {
        gameId: lap.gameId, identity: entity,
        ...(ordinal !== undefined && ordinal !== -1 ? { ordinal } : {}),
        seconds: 0, laps: 0, sessionIds: new Set(), distanceMeters: 0,
        distanceLaps: 0, hasDistance: false, podiums: 0, hasPodiumEvidence: false,
      };
      aggregates.set(key, aggregate);
    }
    aggregate.seconds += lap.lapTime;
    aggregate.laps++;
    aggregate.sessionIds.add(lap.sessionId);
    const trackIdentity = identity(lap.trackId, lap.trackOrdinal, "track");
    const lengthKey = JSON.stringify([lap.gameId, lap.trackOrdinal, lap.trackId]);
    let length = lengths.get(lengthKey);
    if (length === undefined) {
      const nativeTrackId = typeof lap.trackId === "string" || typeof lap.trackId === "number" ? lap.trackId : undefined;
      const ordinalTrackId = lap.trackOrdinal !== undefined && lap.trackOrdinal !== -1 ? lap.trackOrdinal : undefined;
      const catalogKey = ordinalTrackId !== undefined ? `${lap.gameId}:${ordinalTrackId}`
        : nativeTrackId !== undefined && nativeTrackId !== -1 ? `${lap.gameId}:${nativeTrackId}` : undefined;
      const catalogLengthKm = catalogKey === undefined ? undefined : trackLengths[catalogKey];
      if (lap.gameId === "lmu") {
        const track = typeof lap.trackId === "string" ? resolveLMUTrack(lap.trackId) : undefined;
        length = track?.lengthKm && track.lengthKm > 0 ? track.lengthKm * 1_000
          : catalogLengthKm !== undefined && positiveFinite(catalogLengthKm) ? catalogLengthKm * 1_000 : null;
      } else {
        length = catalogLengthKm !== undefined && positiveFinite(catalogLengthKm) ? catalogLengthKm * 1_000 : null;
      }
      lengths.set(lengthKey, length);
    }
    if (trackIdentity && length !== null && positiveFinite(length)) {
      aggregate.distanceMeters += length;
      aggregate.distanceLaps++;
      aggregate.hasDistance = true;
    }
  }
  const sessionsById = new Map<number, SessionMeta>();
  for (const session of sessions) {
    if (session.ownership === "others" || !session.gameId || (selectedGameId !== null && session.gameId !== selectedGameId)) continue;
    const date = parseUtcTimestamp(session.createdAt).getTime();
    if (!Number.isFinite(date) || date > nowTime) continue;
    const prior = sessionsById.get(session.id);
    if (!prior || date < parseUtcTimestamp(prior.createdAt).getTime()) sessionsById.set(session.id, session);
  }
  for (const session of sessionsById.values()) {
    const entityIdentity = identityFor(session);
    if (!entityIdentity || !session.gameId) continue;
    const aggregate = aggregates.get(JSON.stringify([session.gameId, entityIdentity]));
    if (!aggregate) continue;
    aggregate.sessionIds.add(session.id);
    if (session.resultOutcomeStatus === "confirmed" && session.resultClassification === "finished"
      && classifySessionType(session.sessionType) === "race" && validPosition(session.finishingPosition)) {
      aggregate.hasPodiumEvidence = true;
      if (session.finishingPosition <= 3) aggregate.podiums++;
    }
  }
  const ranked = [...aggregates.values()].sort((a, b) =>
    b.seconds - a.seconds || a.gameId.localeCompare(b.gameId)
      || `${typeof a.identity}:${a.identity}`.localeCompare(`${typeof b.identity}:${b.identity}`));
  const winner = ranked[0];
  return winner ? {
    gameId: winner.gameId, identity: winner.identity, ...(winner.ordinal === undefined ? {} : { ordinal: winner.ordinal }),
    seconds: winner.seconds, laps: winner.laps, sessions: winner.sessionIds.size,
    distanceMeters: winner.hasDistance ? winner.distanceMeters : null,
    distanceLaps: winner.distanceLaps, podiums: winner.hasPodiumEvidence ? winner.podiums : null,
  } : null;
}




export function buildDashboardInsights(
  laps: readonly LapMeta[],
  sessions: readonly SessionMeta[],
  gameId: GameId | null,
  now = new Date(),
  trackLengths: TrackLengthLookup = {},
): DashboardInsights {
  const nowTime = now.getTime();
  const eligibleLaps = laps
    .filter((lap) => lap.ownership !== "others" && (gameId === null || lap.gameId === gameId))
    .filter((lap) => {
      const time = timestamp(lap);
      return Number.isFinite(time) && time <= nowTime;
    })
    .sort((a, b) => timestamp(a) - timestamp(b) || a.id - b.id);
  const cleanLaps = eligibleLaps.filter((lap) => positiveFinite(lap.lapTime));
  let valid = 0;
  const cleanTrend = cleanLaps.map((lap, index) => {
    if (lap.isValid) valid++;
    const total = index + 1;
    return { lapId: lap.id, timestamp: timestamp(lap), valid, total, rate: valid / total };
  });
  const cleanTotal = cleanLaps.length;

  const seenSessions = new Set<number>();
  let first = 0;
  let second = 0;
  let third = 0;
  const otherPositionCounts = new Map<number, number>();
  let podiumsAvailable = false;
  const podiumRaces: { sessionId: number; timestamp: number; position: number }[] = [];
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
    podiumRaces.push({ sessionId: session.id, timestamp: date.getTime(), position: session.finishingPosition });
    if (session.finishingPosition === 1) first += 1;
    else if (session.finishingPosition === 2) second += 1;
    else if (session.finishingPosition === 3) third += 1;
    else otherPositionCounts.set(session.finishingPosition, (otherPositionCounts.get(session.finishingPosition) ?? 0) + 1);
  }
  podiumRaces.sort((a, b) => a.timestamp - b.timestamp || a.sessionId - b.sessionId);
  const periodPlaces: [number, number, number] = [0, 0, 0];
  const podiumTrend = podiumRaces.map((race, index) => {
    if (race.position <= 3) periodPlaces[race.position - 1] = periodPlaces[race.position - 1]! + 1;
    const total = index + 1;
    const podiums = periodPlaces[0] + periodPlaces[1] + periodPlaces[2];
    return { sessionId: race.sessionId, timestamp: race.timestamp, podiums, first: periodPlaces[0], second: periodPlaces[1], third: periodPlaces[2], total, rate: podiums / total };
  });

  const sessionsById = new Map<number, { session: SessionMeta; time: number }>();
  for (const session of sessions) {
    if (session.ownership === "others" || (gameId !== null && session.gameId !== gameId)) continue;
    const time = parseUtcTimestamp(session.createdAt).getTime();
    if (!Number.isFinite(time) || time > nowTime) continue;
    const existing = sessionsById.get(session.id);
    if (!existing || time > existing.time) sessionsById.set(session.id, { session, time });
  }
  const orderedSessions = [...sessionsById.values()].sort((a, b) => b.time - a.time || b.session.id - a.session.id);

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

  const sessionLapGroups = new Map<number, LapMeta[]>();
  for (const lap of uniqueLaps) {
    if (!lap.isValid || !positiveFinite(lap.lapTime)) continue;
    const group = sessionLapGroups.get(lap.sessionId) ?? [];
    group.push(lap);
    sessionLapGroups.set(lap.sessionId, group);
  }
  const sessionDeviations: number[] = [];
  for (const { session } of orderedSessions) {
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

  const sessionTypeSeconds = new Map<SessionTypeKind, number>([["practice", 0], ["qualifying", 0], ["race", 0]]);
  let unclassifiedSeconds = 0;
  for (const { session } of orderedSessions) {
    const elapsedSeconds = session.elapsedSeconds;
    if (typeof elapsedSeconds !== "number" || !Number.isFinite(elapsedSeconds) || elapsedSeconds < 0) continue;
    const kind = classifySessionType(session.sessionType);
    if (!kind) {
      unclassifiedSeconds += elapsedSeconds;
      continue;
    }
    sessionTypeSeconds.set(kind, (sessionTypeSeconds.get(kind) ?? 0) + elapsedSeconds);
  }
  const sessionTypeTotalSeconds = [...sessionTypeSeconds.values()].reduce((total, seconds) => total + seconds, unclassifiedSeconds);
  const sessionTypes = (["practice", "qualifying", "race"] as const).map((kind) => {
    const seconds = sessionTypeSeconds.get(kind) ?? 0;
    return { kind, seconds, share: sessionTypeTotalSeconds > 0 ? seconds / sessionTypeTotalSeconds : 0 };
  });
  const unclassifiedShare = sessionTypeTotalSeconds > 0 ? unclassifiedSeconds / sessionTypeTotalSeconds : 0;
  const favouriteTrack = buildFavouriteInsight(uniqueLaps, sessions, gameId, nowTime, "track", trackLengths);
  const favouriteCar = buildFavouriteInsight(uniqueLaps, sessions, gameId, nowTime, "car", trackLengths);

  return {
    clean: { valid, total: cleanTotal, rate: cleanTotal === 0 ? null : valid / cleanTotal, trend: cleanTrend },
    podiums: {
      total: first + second + third,
      first,
      second,
      third,
      available: podiumsAvailable,
      rate: podiumTrend[podiumTrend.length - 1]?.rate ?? null,
      trend: podiumTrend,
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
    sessionStats: {
      sessionTypes,
      sessionTypeTotalSeconds,
      unclassifiedSeconds,
      unclassifiedShare,
    },
    favouriteTrack,
    favouriteCar,
  };
}
