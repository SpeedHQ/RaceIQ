import { KNOWN_GAME_IDS, type GameId } from "../../games/ids";
import { isPracticeSession } from "./session-type";
import type { LapMeta, SessionMeta } from "./types";

export interface DashboardRequest {
  from: string;
  to: string;
  gameId?: GameId;
}
export interface DashboardMetricTotals {
  laps: number;
  positiveLaps: number;
  validLaps: number;
  drivenSeconds: number;
  validSeconds: number;
  bestLapSeconds: number | null;
  averageLapSeconds: number | null;
  tracks: number;
  cars: number;
  sessions: number;
}
export interface DashboardCoverage {
  status: "complete" | "pending" | "unavailable";
  /** False only when exact metadata aggregates could not be computed. */
  metadataComplete: boolean;
  mineSessions: number;
  readySessions: number;
  pendingSessions: number;
}
export interface DashboardCardTotal { laps: number; drivenSeconds: number }
export interface DashboardCalendarBucket {
  day: string;
  from: string;
  to: string;
  validLaps: number;
  positiveLaps: number;
  cleanRate: number | null;
  drivenSeconds: number;
  podiums: number;
}
export interface DashboardEntityTotal {
  gameId: GameId;
  identity: string;
  ordinal: number | null;
  seconds: number;
  share: number;
}
export interface DashboardDistribution {
  totalSeconds: number;
  topFive: DashboardEntityTotal[];
  othersSeconds: number;
  othersShare: number;
  othersCount: number;
}
export interface DashboardFavourite {
  gameId: GameId;
  identity: string;
  nativeId: number | string | null;
  ordinal: number | null;
  seconds: number;
  laps: number;
  sessions: number;
  distanceMeters: number | null;
  distanceLaps: number;
  /** Null = no confirmed result evidence; zero = confirmed no podiums. */
  podiums: number | null;
}
export interface DashboardConsistency {
  sessions: number;
  averageStandardDeviation: number | null;
  /** Seven ascending bins: <0.1, 0.1–<0.2, 0.2–<0.5, 0.5–<1, 1–<2, 2–5 (inclusive), >5 seconds. */
  deviations: number[];
}
export type DashboardSessionType = "practice" | "qualifying" | "race" | "unknown";
export interface DashboardSessionTypeShare { kind: DashboardSessionType; seconds: number; share: number }
/** Allow-listed display DTO. Never expose generic source rows or capture fields. */
export interface DashboardRecentSession {
  id: number;
  gameId: GameId;
  createdAt: string;
  sessionType: string | null;
  car: { id: number | string | null; ordinal: number | null; name: string | null };
  track: { id: number | string | null; ordinal: number | null; name: string | null };
  lapCount: number;
  bestLapSeconds: number | null;
}
export interface DashboardResponse {
  request: DashboardRequest;
  revision: number;
  coverage: DashboardCoverage;
  cards: Record<GameId, DashboardCardTotal>;
  totals: DashboardMetricTotals;
  calendar: DashboardCalendarBucket[];
  trackDistribution: DashboardDistribution;
  favouriteTrack: DashboardFavourite | null;
  favouriteCar: DashboardFavourite | null;
  consistency: DashboardConsistency;
  sessionTypes: {
    shares: DashboardSessionTypeShare[];
    totalSeconds: number;
    unknownSeconds: number;
    unknownShare: number;
    sessionsWithDuration: number;
    sessionsWithoutDuration: number;
  };
  podiums: { total: number; first: number; second: number; third: number; available: boolean };
  recentSessions: DashboardRecentSession[];
  latestRecapSessionId: number | null;
}
export interface DashboardReductionInput {
  revision?: number;
  coverage?: DashboardCoverage;
  carNames?: Readonly<Record<string, string>>;
  trackNames?: Readonly<Record<string, string>>;
  trackLengthsMeters?: Readonly<Record<string, number>>;
}
export interface DashboardRecapIdentity {
  sessionId: number;
  gameId: GameId;
  carId: number | string | null;
  carOrdinal: number | null;
  trackId: number | string | null;
  trackOrdinal: number | null;
  sectorLayoutKey: string | null;
  sectorCount: number;
}
export interface DashboardRecapHistory {
  bestLapSeconds: number | null;
  bestSectorSeconds: Array<number | null> | null;
}
export interface DashboardUpdatedMessage { type: "dashboard_updated" }

const DAY_MS = 86_400_000;
const CONSISTENCY_BOUNDS = [0.1, 0.2, 0.5, 1, 2, 5] as const;

/** SQLite's legacy timezone-naive datetime text means UTC, on every host. */
export function dashboardInstant(value: string): number {
  const isNaiveSqlite = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(value)
    && !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value);
  const timestamp = Date.parse(isNaiveSqlite ? `${value.replace(" ", "T")}Z` : value);
  return Number.isFinite(timestamp) ? timestamp : Number.NaN;
}

export function isDashboardOwned(ownership: string | null | undefined): boolean {
  return ownership === "mine";
}

/** Exact half-open UTC instant membership. */
export function isInDashboardInterval(createdAt: string, from: string, to: string): boolean {
  const timestamp = dashboardInstant(createdAt);
  const start = dashboardInstant(from);
  const end = dashboardInstant(to);
  return Number.isFinite(timestamp) && Number.isFinite(start) && Number.isFinite(end)
    && start < end && timestamp >= start && timestamp < end;
}

function canonicalIdentity(native: number | string | null | undefined, ordinal: number | null | undefined): { key: string; display: number | string } | null {
  if (native != null && !(typeof native === "number" && native === -1)) {
    if (typeof native === "number") {
      if (Number.isFinite(native)) return { key: `n:${native}`, display: native };
    } else {
      const normalized = native.trim();
      if (normalized !== "") {
        const numeric = Number(normalized);
        if (Number.isInteger(numeric) && Number.isFinite(numeric)) {
          if (numeric !== -1) return { key: `n:${numeric}`, display: numeric };
        } else if (normalized !== "") {
          return { key: `s:${native}`, display: native };
        }
      }
    }
  }
  return ordinal != null && Number.isInteger(ordinal) && Number.isFinite(ordinal) && ordinal !== -1
    ? { key: `n:${ordinal}`, display: ordinal }
    : null;
}

export function dashboardTrackIdentity(gameId: GameId, trackId: number | string | null | undefined, trackOrdinal: number | null | undefined): string | null {
  const identity = canonicalIdentity(trackId, trackOrdinal);
  return identity ? JSON.stringify([gameId, identity.key]) : null;
}
export function dashboardCarIdentity(gameId: GameId, carId: number | string | null | undefined, carOrdinal: number | null | undefined): string | null {
  const identity = canonicalIdentity(carId, carOrdinal);
  return identity ? JSON.stringify([gameId, identity.key]) : null;
}

export function validateDashboardRequest(request: DashboardRequest): boolean {
  const from = dashboardInstant(request.from);
  const to = dashboardInstant(request.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to || to - from > 366 * DAY_MS) return false;
  if (request.gameId !== undefined && !(KNOWN_GAME_IDS as readonly string[]).includes(request.gameId)) return false;
  return true;
}

function calendarBounds(request: DashboardRequest): Array<{ day: string; from: number; to: number }> {
  const start = dashboardInstant(request.from);
  const end = dashboardInstant(request.to);
  const firstDate = new Date(start);
  firstDate.setUTCHours(0, 0, 0, 0);
  const lastDate = new Date(end - 1);
  lastDate.setUTCHours(0, 0, 0, 0);
  const count = Math.floor((lastDate.getTime() - firstDate.getTime()) / DAY_MS) + 1;
  if (count < 1 || count > 367) return [];
  const result: Array<{ day: string; from: number; to: number }> = [];
  for (let index = 0; index < count; index++) {
    const dayStart = firstDate.getTime() + index * DAY_MS;
    const dayEnd = dayStart + DAY_MS;
    result.push({
      day: new Date(dayStart).toISOString().slice(0, 10),
      from: Math.max(start, dayStart),
      to: Math.min(end, dayEnd),
    });
  }
  return result;
}

interface MutableTotals {
  laps: number; positiveLaps: number; validLaps: number; drivenSeconds: number; validSeconds: number;
  bestLapSeconds: number | null; tracks: Set<string>; cars: Set<string>; sessions: Set<number>;
}
function emptyTotals(): MutableTotals {
  return { laps: 0, positiveLaps: 0, validLaps: 0, drivenSeconds: 0, validSeconds: 0, bestLapSeconds: null, tracks: new Set(), cars: new Set(), sessions: new Set() };
}
function finishTotals(value: MutableTotals): DashboardMetricTotals {
  return {
    laps: value.laps, positiveLaps: value.positiveLaps, validLaps: value.validLaps,
    drivenSeconds: value.drivenSeconds, validSeconds: value.validSeconds,
    bestLapSeconds: value.bestLapSeconds,
    averageLapSeconds: value.validLaps ? value.validSeconds / value.validLaps : null,
    tracks: value.tracks.size, cars: value.cars.size, sessions: value.sessions.size,
  };
}
function finitePositive(value: number): boolean { return Number.isFinite(value) && value > 0 }
function classifySessionType(value: string | null | undefined): DashboardSessionType {
  const kind = value?.trim().toLowerCase();
  if (isPracticeSession(kind)) return "practice";
  if (kind?.startsWith("qualifying") || kind?.startsWith("qualify")) return "qualifying";
  if (kind?.startsWith("race")) return "race";
  return "unknown";
}
function entityKey(gameId: GameId, identity: string): string { return JSON.stringify([gameId, identity]) }
function fieldIdentity(item: LapMeta | SessionMeta, field: "track" | "car") {
  return field === "track" ? canonicalIdentity(item.trackId, item.trackOrdinal) : canonicalIdentity(item.carId, item.carOrdinal);
}

interface EntityAccumulator {
  gameId: GameId; identity: string; display: number | string; ordinal: number | null;
  seconds: number; laps: number; sessionIds: Set<number>; distanceMeters: number; distanceLaps: number;
  hasDistance: boolean; podiums: number; hasPodiumEvidence: boolean;
}
function addEntityLap(
  aggregates: Map<string, EntityAccumulator>, lap: LapMeta, field: "track" | "car",
  identity: { key: string; display: number | string }, trackLength: number | undefined,
): void {
  const key = entityKey(lap.gameId!, identity.key);
  let aggregate = aggregates.get(key);
  if (!aggregate) {
    aggregate = {
      gameId: lap.gameId!, identity: identity.key, display: identity.display,
      ordinal: (field === "track" ? lap.trackOrdinal : lap.carOrdinal) ?? null,
      seconds: 0, laps: 0, sessionIds: new Set(), distanceMeters: 0, distanceLaps: 0,
      hasDistance: false, podiums: 0, hasPodiumEvidence: false,
    };
    aggregates.set(key, aggregate);
  }
  aggregate.seconds += lap.lapTime;
  aggregate.laps++;
  aggregate.sessionIds.add(lap.sessionId);
  if (trackLength !== undefined && finitePositive(trackLength)) {
    aggregate.distanceMeters += trackLength;
    aggregate.distanceLaps++;
    aggregate.hasDistance = true;
  }
}
function exactOwnedSessions(sessions: readonly SessionMeta[], request: DashboardRequest): Map<number, SessionMeta> {
  const result = new Map<number, SessionMeta>();
  for (const session of sessions) {
    if (!isDashboardOwned(session.ownership) || !session.gameId || (request.gameId && session.gameId !== request.gameId)
      || !isInDashboardInterval(session.createdAt, request.from, request.to)) continue;
    const prior = result.get(session.id);
    if (!prior || dashboardInstant(session.createdAt) > dashboardInstant(prior.createdAt)) result.set(session.id, session);
  }
  return result;
}

export function selectDashboardRecentSessions(
  sessions: readonly SessionMeta[], request: DashboardRequest,
  names: { carNames?: Readonly<Record<string, string>>; trackNames?: Readonly<Record<string, string>> } = {},
  limit = 10,
): DashboardRecentSession[] {
  const safeLimit = Number.isFinite(limit) ? Math.max(0, Math.min(10, Math.floor(limit))) : 0;
  return [...exactOwnedSessions(sessions, request).values()]
    .sort((a, b) => dashboardInstant(b.createdAt) - dashboardInstant(a.createdAt) || b.id - a.id)
    .slice(0, safeLimit)
    .map((session) => ({
      id: session.id, gameId: session.gameId!, createdAt: session.createdAt, sessionType: session.sessionType ?? null,
      car: { id: session.carId ?? null, ordinal: session.carOrdinal ?? null, name: names.carNames?.[`${session.gameId}:${session.carOrdinal}`] ?? null },
      track: { id: session.trackId ?? null, ordinal: session.trackOrdinal ?? null, name: names.trackNames?.[`${session.gameId}:${session.trackOrdinal}`] ?? null },
      lapCount: session.lapCount ?? 0, bestLapSeconds: session.bestLapTime ?? null,
    }));
}

export function isDashboardRecapEligible(session: Pick<SessionMeta, "ownership" | "gameId">, gameId: GameId): boolean {
  return isDashboardOwned(session.ownership) && session.gameId === gameId;
}

export function reduceDashboardRecapHistory(
  current: DashboardRecapIdentity, sessions: readonly SessionMeta[], laps: readonly LapMeta[],
  sectorLayoutBySession: Readonly<Record<number, string | null>>,
): DashboardRecapHistory {
  const ids = new Set<number>();
  const car = dashboardCarIdentity(current.gameId, current.carId, current.carOrdinal);
  const track = dashboardTrackIdentity(current.gameId, current.trackId, current.trackOrdinal);
  if (car === null || track === null) return { bestLapSeconds: null, bestSectorSeconds: null };
  for (const session of sessions) {
    if (session.id === current.sessionId || !isDashboardOwned(session.ownership) || session.gameId !== current.gameId
      || dashboardCarIdentity(current.gameId, session.carId, session.carOrdinal) !== car
      || dashboardTrackIdentity(current.gameId, session.trackId, session.trackOrdinal) !== track) continue;
    ids.add(session.id);
  }
  let bestLapSeconds: number | null = null;
  let sectorEvidence = false;
  const bestSectorSeconds: Array<number | null> = Array.from({ length: current.sectorCount }, () => null);
  for (const lap of laps) {
    if (!ids.has(lap.sessionId) || lap.gameId !== current.gameId || !isDashboardOwned(lap.ownership)
      || !lap.isValid || !finitePositive(lap.lapTime)) continue;
    bestLapSeconds = bestLapSeconds === null ? lap.lapTime : Math.min(bestLapSeconds, lap.lapTime);
    if (current.sectorCount < 2 || current.sectorLayoutKey === null || sectorLayoutBySession[lap.sessionId] !== current.sectorLayoutKey
      || !lap.sectorTimes || lap.sectorTimes.length !== current.sectorCount || !lap.sectorTimes.every(finitePositive)) continue;
    sectorEvidence = true;
    for (let index = 0; index < current.sectorCount; index++) {
      const time = lap.sectorTimes[index]!;
      bestSectorSeconds[index] = bestSectorSeconds[index] === null ? time : Math.min(bestSectorSeconds[index]!, time);
    }
  }
  return { bestLapSeconds, bestSectorSeconds: sectorEvidence ? bestSectorSeconds : null };
}

/** Independent simple reference reducer; retains no source rows or per-lap arrays. */
export function reduceDashboardLaps(laps: readonly LapMeta[], request: DashboardRequest): DashboardMetricTotals {
  const totals = emptyTotals();
  for (const lap of laps) {
    if (!isDashboardOwned(lap.ownership) || !lap.gameId || (request.gameId && lap.gameId !== request.gameId)
      || !isInDashboardInterval(lap.createdAt, request.from, request.to)) continue;
    totals.laps++;
    totals.sessions.add(lap.sessionId);
    const track = dashboardTrackIdentity(lap.gameId, lap.trackId, lap.trackOrdinal);
    const car = dashboardCarIdentity(lap.gameId, lap.carId, lap.carOrdinal);
    if (track) totals.tracks.add(track);
    if (car) totals.cars.add(car);
    if (!finitePositive(lap.lapTime)) continue;
    totals.positiveLaps++;
    totals.drivenSeconds += lap.lapTime;
    if (lap.isValid) {
      totals.validLaps++;
      totals.validSeconds += lap.lapTime;
      totals.bestLapSeconds = totals.bestLapSeconds === null ? lap.lapTime : Math.min(totals.bestLapSeconds, lap.lapTime);
    }
  }
  return finishTotals(totals);
}

function bucketIndex(timestamp: number, buckets: readonly { from: number; to: number }[]): number {
  let low = 0;
  let high = buckets.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const bucket = buckets[middle]!;
    if (timestamp < bucket.from) high = middle - 1;
    else if (timestamp >= bucket.to) low = middle + 1;
    else return middle;
  }
  return -1;
}

export function reduceDashboard(
  laps: readonly LapMeta[], sessions: readonly SessionMeta[], request: DashboardRequest,
  input: DashboardReductionInput = {},
): DashboardResponse {
  if (!validateDashboardRequest(request)) throw new RangeError("Invalid dashboard request");
  const coverage = input.coverage ?? { status: "complete", metadataComplete: true, mineSessions: 0, readySessions: 0, pendingSessions: 0 };
  const cardFacts: Record<GameId, { laps: number; drivenSeconds: number }> = Object.fromEntries(KNOWN_GAME_IDS.map((id) => [id, { laps: 0, drivenSeconds: 0 }])) as Record<GameId, { laps: number; drivenSeconds: number }>;
  const totals = emptyTotals();
  const buckets = calendarBounds(request).map((bucket) => ({ ...bucket, validLaps: 0, positiveLaps: 0, drivenSeconds: 0, podiums: 0 }));
  const tracks = new Map<string, EntityAccumulator>();
  const cars = new Map<string, EntityAccumulator>();
  const favouriteTracks = new Map<string, EntityAccumulator>();
  const favouriteCars = new Map<string, EntityAccumulator>();
  const consistency = new Map<number, { count: number; mean: number; m2: number; context: string | null; mismatch: boolean }>();
  const sessionFacts = new Map<number, { laps: number; best: number | null }>();
  const ownedSessions = exactOwnedSessions(sessions, request);

  for (const lap of laps) {
    if (!isDashboardOwned(lap.ownership) || !lap.gameId || !isInDashboardInterval(lap.createdAt, request.from, request.to)) continue;
    const card = cardFacts[lap.gameId];
    if (card) {
      card.laps++;
      if (finitePositive(lap.lapTime)) card.drivenSeconds += lap.lapTime;
    }
    if (request.gameId && lap.gameId !== request.gameId) continue;
    totals.laps++;
    totals.sessions.add(lap.sessionId);
    const track = canonicalIdentity(lap.trackId, lap.trackOrdinal);
    const car = canonicalIdentity(lap.carId, lap.carOrdinal);
    if (track) totals.tracks.add(entityKey(lap.gameId, track.key));
    if (car) totals.cars.add(entityKey(lap.gameId, car.key));
    const time = dashboardInstant(lap.createdAt);
    const day = bucketIndex(time, buckets);
    const sessionFact = sessionFacts.get(lap.sessionId) ?? { laps: 0, best: null };
    sessionFact.laps++;
    if (lap.isValid && finitePositive(lap.lapTime)) sessionFact.best = sessionFact.best === null ? lap.lapTime : Math.min(sessionFact.best, lap.lapTime);
    sessionFacts.set(lap.sessionId, sessionFact);

    if (finitePositive(lap.lapTime)) {
      totals.positiveLaps++;
      totals.drivenSeconds += lap.lapTime;
      if (day >= 0) { buckets[day]!.positiveLaps++; buckets[day]!.drivenSeconds += lap.lapTime; }
      if (lap.isValid) {
        totals.validLaps++;
        totals.validSeconds += lap.lapTime;
        totals.bestLapSeconds = totals.bestLapSeconds === null ? lap.lapTime : Math.min(totals.bestLapSeconds, lap.lapTime);
        if (day >= 0) buckets[day]!.validLaps++;
      }
      const trackLength = lap.trackOrdinal != null && lap.trackOrdinal !== -1
        ? input.trackLengthsMeters?.[`${lap.gameId}:${lap.trackOrdinal}`]
        : undefined;
      if (track) {
        addEntityLap(tracks, lap, "track", track, trackLength);
        if (lap.invalidReason !== "incomplete") addEntityLap(favouriteTracks, lap, "track", track, trackLength);
      }
      if (car) {
        addEntityLap(cars, lap, "car", car, trackLength);
        if (lap.invalidReason !== "incomplete") addEntityLap(favouriteCars, lap, "car", car, trackLength);
      }
      if (lap.isValid) {
        const session = ownedSessions.get(lap.sessionId);
        if (session) {
          const trackKey = dashboardTrackIdentity(lap.gameId, lap.trackId, lap.trackOrdinal);
          const carKey = dashboardCarIdentity(lap.gameId, lap.carId, lap.carOrdinal);
          const context = trackKey && carKey ? JSON.stringify([lap.gameId, trackKey, carKey]) : null;
          const state = consistency.get(lap.sessionId) ?? { count: 0, mean: 0, m2: 0, context, mismatch: false };
          if (state.context !== context || !context) state.mismatch = true;
          state.count++;
          const delta = lap.lapTime - state.mean;
          state.mean += delta / state.count;
          state.m2 += delta * (lap.lapTime - state.mean);
          consistency.set(lap.sessionId, state);
        }
      }
    }
  }

  for (const session of ownedSessions.values()) {
    if (!session.gameId) continue;
    for (const field of ["track", "car"] as const) {
      const identity = fieldIdentity(session, field);
      const aggregate = identity && (field === "track" ? favouriteTracks : favouriteCars).get(entityKey(session.gameId, identity.key));
      aggregate?.sessionIds.add(session.id);
    }
  }
  let first = 0, second = 0, third = 0;
  let podiumEvidence = false;
  for (const session of ownedSessions.values()) {
    const position = session.finishingPosition;
    if (session.resultOutcomeStatus !== "confirmed" || session.resultClassification !== "finished"
      || !session.sessionType?.trim().toLowerCase().startsWith("race")
      || typeof position !== "number" || !Number.isFinite(position) || !Number.isInteger(position) || position <= 0) continue;
    podiumEvidence = true;
    if (position === 1) first++;
    else if (position === 2) second++;
    else if (position === 3) third++;
    const day = bucketIndex(dashboardInstant(session.createdAt), buckets);
    if (day >= 0 && position <= 3) buckets[day]!.podiums++;
    for (const field of ["track", "car"] as const) {
      const identity = fieldIdentity(session, field);
      const aggregate = identity && (field === "track" ? favouriteTracks : favouriteCars).get(entityKey(session.gameId!, identity.key));
      if (!aggregate) continue;
      aggregate.hasPodiumEvidence = true;
      if (position <= 3) aggregate.podiums++;
    }
  }

  const deviations: number[] = [];
  for (const value of consistency.values()) {
    if (value.count < 2 || value.mismatch || value.context === null) continue;
    const variance = value.m2 / value.count;
    if (!Number.isFinite(value.mean) || !Number.isFinite(value.m2) || !Number.isFinite(variance)) {
      throw new RangeError("Non-finite dashboard consistency variance");
    }
    // Only absorb floating-point roundoff; materially negative variance signals corrupt state.
    const tolerance = Number.EPSILON * Math.max(1, value.mean * value.mean) * value.count * 16;
    if (!Number.isFinite(tolerance)) throw new RangeError("Non-finite dashboard consistency tolerance");
    if (variance < -tolerance) throw new RangeError("Negative dashboard consistency variance");
    const deviation = Math.sqrt(variance < 0 ? 0 : variance);
    if (!Number.isFinite(deviation)) throw new RangeError("Non-finite dashboard consistency deviation");
    deviations.push(deviation);
  }
  const deviationBins = Array<number>(CONSISTENCY_BOUNDS.length + 1).fill(0);
  let deviationSum = 0;
  for (const deviation of deviations) {
    deviationSum += deviation;
    const bucket = CONSISTENCY_BOUNDS.findIndex((bound, index) =>
      index === CONSISTENCY_BOUNDS.length - 1 ? deviation <= bound : deviation < bound);
    deviationBins[bucket < 0 ? CONSISTENCY_BOUNDS.length : bucket]!++;
  }

  const typeSeconds: Record<DashboardSessionType, number> = { practice: 0, qualifying: 0, race: 0, unknown: 0 };
  let sessionsWithDuration = 0;
  let sessionsWithoutDuration = 0;
  for (const session of ownedSessions.values()) {
    const duration = session.elapsedSeconds;
    if (typeof duration !== "number" || !Number.isFinite(duration) || duration < 0) {
      sessionsWithoutDuration++;
      continue;
    }
    sessionsWithDuration++;
    typeSeconds[classifySessionType(session.sessionType)] += duration;
  }
  const durationTotal = Object.values(typeSeconds).reduce((sum, duration) => sum + duration, 0);
  const sessionTypeShares = (Object.entries(typeSeconds) as Array<[DashboardSessionType, number]>).map(([kind, seconds]) => ({ kind, seconds, share: durationTotal ? seconds / durationTotal : 0 }));

  const rankedTracks = [...tracks.values()].sort((a, b) => b.seconds - a.seconds || a.gameId.localeCompare(b.gameId) || a.identity.localeCompare(b.identity));
  const totalTrackSeconds = rankedTracks.reduce((sum, entity) => sum + entity.seconds, 0);
  const otherTracks = rankedTracks.slice(5);
  const favorite = (entities: Map<string, EntityAccumulator>): DashboardFavourite | null => {
    let winner: EntityAccumulator | undefined;
    for (const entity of entities.values()) {
      if (!winner || entity.seconds > winner.seconds || (entity.seconds === winner.seconds
        && (entity.laps > winner.laps || (entity.laps === winner.laps
          && (entity.gameId.localeCompare(winner.gameId) < 0
            || (entity.gameId === winner.gameId && entity.identity.localeCompare(winner.identity) < 0)))))) winner = entity;
    }
    return winner ? {
      gameId: winner.gameId, identity: winner.identity, nativeId: winner.display, ordinal: winner.ordinal,
      seconds: winner.seconds, laps: winner.laps, sessions: winner.sessionIds.size,
      distanceMeters: winner.hasDistance ? winner.distanceMeters : null, distanceLaps: winner.distanceLaps,
      podiums: winner.hasPodiumEvidence ? winner.podiums : null,
    } : null;
  };
  const recentSessions = selectDashboardRecentSessions(sessions, request, {
    carNames: input.carNames, trackNames: input.trackNames,
  }).map((session) => {
    const facts = sessionFacts.get(session.id);
    return { ...session, lapCount: session.lapCount || facts?.laps || 0, bestLapSeconds: session.bestLapSeconds ?? facts?.best ?? null };
  });
  const calendar: DashboardCalendarBucket[] = buckets.map((bucket) => ({
    day: bucket.day, from: new Date(bucket.from).toISOString(), to: new Date(bucket.to).toISOString(),
    validLaps: bucket.validLaps, positiveLaps: bucket.positiveLaps,
    cleanRate: bucket.positiveLaps ? bucket.validLaps / bucket.positiveLaps : null,
    drivenSeconds: bucket.drivenSeconds, podiums: bucket.podiums,
  }));
  const cards = Object.fromEntries(KNOWN_GAME_IDS.map((gameId) => [gameId, cardFacts[gameId]])) as Record<GameId, DashboardCardTotal>;
  const trackDistribution: DashboardDistribution = {
    totalSeconds: totalTrackSeconds,
    topFive: rankedTracks.slice(0, 5).map((entity) => ({
      gameId: entity.gameId, identity: entity.identity, ordinal: entity.ordinal,
      seconds: entity.seconds, share: totalTrackSeconds ? entity.seconds / totalTrackSeconds : 0,
    })),
    othersSeconds: otherTracks.reduce((sum, entity) => sum + entity.seconds, 0),
    othersShare: totalTrackSeconds ? otherTracks.reduce((sum, entity) => sum + entity.seconds, 0) / totalTrackSeconds : 0,
    othersCount: otherTracks.length,
  };
  return {
    request, revision: input.revision ?? 0, coverage, cards, totals: finishTotals(totals), calendar,
    trackDistribution, favouriteTrack: favorite(favouriteTracks), favouriteCar: favorite(favouriteCars),
    consistency: {
      sessions: deviations.length,
      averageStandardDeviation: deviations.length ? deviationSum / deviations.length : null,
      deviations: deviationBins,
    },
    sessionTypes: {
      shares: sessionTypeShares, totalSeconds: durationTotal, unknownSeconds: typeSeconds.unknown,
      unknownShare: durationTotal ? typeSeconds.unknown / durationTotal : 0,
      sessionsWithDuration, sessionsWithoutDuration,
    },
    podiums: { total: first + second + third, first, second, third, available: podiumEvidence },
    recentSessions, latestRecapSessionId: recentSessions[0]?.id ?? null,
  };
}
