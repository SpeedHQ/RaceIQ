import { afterEach, expect, test } from "bun:test";
import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { GameIdSchema, type GameId } from "@raceiq/shared/games/ids";
import {
  dashboardCarIdentity,
  dashboardTrackIdentity,
  isDashboardOwned,
  isDashboardRecapEligible,
  isInDashboardInterval,
  reduceDashboard,
  reduceDashboardLaps,
  reduceDashboardRecapHistory,
  selectDashboardRecentSessions,
  validateDashboardRequest,
  type DashboardRequest,
  type DashboardResponse,
  type DashboardSessionType,
} from "@raceiq/shared/racing/sessions/dashboard";
import { dashboardSummaryState, dashboardSessionSummaries, laps, sessions } from "@raceiq/backend-core/db/schema";
import { deleteSession } from "@raceiq/backend-core/db/session-queries";
import type { LapMeta, SessionMeta, SessionOwnership } from "@raceiq/shared/racing/sessions/types";
import { DASHBOARD_PROCESSOR_VERSION, prepareDashboardPublicationCandidate, publishDashboardSession } from "@raceiq/backend-core/db/dashboard-summary-queries";
import { getDashboard } from "@raceiq/backend-core/db/dashboard-queries";
import { client, db } from "@raceiq/backend-core/db/index";
import { dashboardRoutes } from "../../src/routes/dashboard-routes";

const ownedSessionIds: number[] = [];
const request: DashboardRequest = {
  from: "2026-01-01T00:00:00.000Z",
  to: "2027-01-01T00:00:00.000Z",
  timeZone: "America/Los_Angeles",
};

afterEach(async () => {
  for (const id of ownedSessionIds.splice(0)) await deleteSession(id);
});

async function addSession(
  gameId: GameId, createdAt: string, ownership: SessionOwnership = "mine",
  carId: number | string | null = 7, trackId: number | string | null = 8,
) {
  const inserted = await db.insert(sessions).values({
    gameId, carId: carId === null ? null : String(carId), trackId: trackId === null ? null : String(trackId),
    carOrdinal: typeof carId === "number" ? carId : 0,
    trackOrdinal: typeof trackId === "number" ? trackId : 0,
    ownership, createdAt,
  }).returning({ id: sessions.id }).get();
  ownedSessionIds.push(inserted.id);
  return inserted.id;
}

async function addLap(
  sessionId: number, lapNumber: number, lapTime: number, isValid = true,
  createdAt = "2026-06-01T12:00:00.000Z",
) {
  await db.insert(laps).values({ sessionId, lapNumber, lapTime, isValid, createdAt }).run();
}

function parseGameId(value: string): GameId {
  return GameIdSchema.parse(value);
}

function asLap(row: {
  id: number; sessionId: number; lapNumber: number; lapTime: number; isValid: boolean;
  createdAt: string; gameId: string; ownership: string; carId: number | string | null;
  trackId: number | string | null; carOrdinal: number | null; trackOrdinal: number | null;
}): LapMeta {
  if (row.ownership !== "mine" && row.ownership !== "others") throw new Error(`Unexpected session ownership: ${row.ownership}`);
  return {
    ...row,
    gameId: parseGameId(row.gameId),
    carOrdinal: row.carOrdinal ?? undefined,
    trackOrdinal: row.trackOrdinal ?? undefined,
    ownership: row.ownership,
    invalidReason: undefined,
  };
}

const baseLap = (overrides: Partial<LapMeta> = {}): LapMeta => ({
  id: 1, sessionId: 1, lapNumber: 1, lapTime: 90, isValid: true,
  createdAt: "2026-06-01T12:00:00.000Z", gameId: "acc" as GameId,
  ownership: "mine", carId: 7, carOrdinal: 7, trackId: 8, trackOrdinal: 8,
  ...overrides,
});
const baseSession = (overrides: Partial<SessionMeta> = {}): SessionMeta => ({
  id: 1, gameId: "acc" as GameId, carId: 7, carOrdinal: 7, trackId: 8, trackOrdinal: 8,
  ownership: "mine", createdAt: "2026-06-01T12:00:00.000Z", sessionType: "race",
  ...overrides,
});

function referenceDashboardFacts(
  laps: readonly LapMeta[], sessions: readonly SessionMeta[], req: DashboardRequest,
  trackLengths: Readonly<Record<string, number>> = {},
) {
  const stamp = (value: string) => Date.parse(value.replace(" ", "T").replace(/(T\d\d:\d\d:\d\d)(?:\.(\d+))?$/, "$1$2Z"));
  const inside = (value: string) => stamp(value) >= stamp(req.from) && stamp(value) < stamp(req.to);
  const owns = (row: { ownership?: string | null; gameId?: GameId | null }) =>
    row.ownership === "mine" && !!row.gameId && (!req.gameId || row.gameId === req.gameId);
  const periodSessions = sessions.filter((session) => owns(session) && inside(session.createdAt));
  const sessionById = new Map(periodSessions.map((session) => [session.id, session]));
  const identity = (gameId: GameId, native: number | string | null | undefined, ordinal: number | null | undefined) => {
    let value: number | string | null = native ?? null;
    if (typeof value === "number" && value === -1) value = null;
    if (typeof value === "string") {
      const normalized = value.trim();
      const numeric = normalized === "" ? Number.NaN : Number(normalized);
      if (Number.isInteger(numeric) && Number.isFinite(numeric)) value = numeric === -1 ? null : numeric;
      else if (normalized === "") value = null;
    }
    if (value == null || typeof value === "number" && !Number.isFinite(value)) {
      value = ordinal != null && Number.isInteger(ordinal) && ordinal !== -1 ? ordinal : null;
    }
    if (value == null) return null;
    const key = `${gameId}:${typeof value === "number" ? `n:${value}` : `s:${value}`}`;
    return { key, value };
  };
  const rows = laps.filter((lap) => owns(lap) && inside(lap.createdAt) && sessionById.has(lap.sessionId));
  const distribution = new Map<string, { gameId: GameId; ordinal: number | null; seconds: number }>();
  type ReferenceFavourite = {
    gameId: GameId; nativeId: number | string; ordinal: number | null; seconds: number; laps: number;
    sessions: Set<number>; distanceMeters: number; distanceLaps: number; podiums: number; hasEvidence: boolean;
  };
  const favourites: Record<"track" | "car", Map<string, ReferenceFavourite>> = { track: new Map(), car: new Map() };
  for (const lap of rows) {
    const track = identity(lap.gameId!, lap.trackId, lap.trackOrdinal);
    if (track) {
      const row = distribution.get(track.key) ?? { gameId: lap.gameId!, ordinal: lap.trackOrdinal ?? null, seconds: 0 };
      if (Number.isFinite(lap.lapTime) && lap.lapTime > 0) row.seconds += lap.lapTime;
      distribution.set(track.key, row);
    }
    if (!Number.isFinite(lap.lapTime) || lap.lapTime <= 0 || lap.invalidReason === "incomplete") continue;
    for (const [field, native, ordinal] of [
      ["track", lap.trackId, lap.trackOrdinal],
      ["car", lap.carId, lap.carOrdinal],
    ] as const) {
      const item = identity(lap.gameId!, native, ordinal);
      if (!item) continue;
      const map = favourites[field];
      const aggregate = map.get(item.key) ?? { gameId: lap.gameId!, nativeId: item.value, ordinal: ordinal ?? null, seconds: 0, laps: 0, sessions: new Set<number>(), distanceMeters: 0, distanceLaps: 0, podiums: 0, hasEvidence: false };
      aggregate.seconds += lap.lapTime;
      aggregate.laps++;
      aggregate.sessions.add(lap.sessionId);
      const distance = trackLengths[`${lap.gameId}:${lap.trackOrdinal}`];
      if (Number.isFinite(distance) && distance > 0) { aggregate.distanceMeters += distance; aggregate.distanceLaps++; }
      map.set(item.key, aggregate);
    }
  }
  for (const session of periodSessions) {
    if (!session.gameId) continue;
    for (const field of ["track", "car"] as const) {
      const item = field === "track" ? identity(session.gameId, session.trackId, session.trackOrdinal) : identity(session.gameId, session.carId, session.carOrdinal);
      const aggregate = item && favourites[field].get(item.key);
      if (aggregate) aggregate.sessions.add(session.id);
    }
  }
  let first = 0, second = 0, third = 0, podiumEvidence = false;
  const calendar = new Map<string, { validLaps: number; positiveLaps: number; drivenSeconds: number; podiums: number }>();
  const dayFormatter = new Intl.DateTimeFormat("en-US", { timeZone: req.timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const dayOf = (value: string) => {
    const parts = Object.fromEntries(dayFormatter.formatToParts(new Date(stamp(value))).map(({ type, value: part }) => [type, part]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  };
  for (const lap of rows) {
    const day = dayOf(lap.createdAt);
    const bucket = calendar.get(day) ?? { validLaps: 0, positiveLaps: 0, drivenSeconds: 0, podiums: 0 };
    if (Number.isFinite(lap.lapTime) && lap.lapTime > 0) {
      bucket.positiveLaps++;
      bucket.drivenSeconds += lap.lapTime;
      if (lap.isValid) bucket.validLaps++;
    }
    calendar.set(day, bucket);
  }
  const firstDay = dayOf(req.from);
  const lastDay = dayOf(new Date(stamp(req.to) - 1).toISOString());
  const [firstYear, firstMonth, firstDate] = firstDay.split("-").map(Number);
  const [lastYear, lastMonth, lastDate] = lastDay.split("-").map(Number);
  const firstUtcDay = Date.UTC(firstYear!, firstMonth! - 1, firstDate!);
  const lastUtcDay = Date.UTC(lastYear!, lastMonth! - 1, lastDate!);
  const dayCount = (lastUtcDay - firstUtcDay) / 86_400_000 + 1;
  if (dayCount >= 1 && dayCount <= 367) {
    for (let cursor = firstUtcDay; cursor <= lastUtcDay; cursor += 86_400_000) {
      const day = new Date(cursor).toISOString().slice(0, 10);
      if (!calendar.has(day)) calendar.set(day, { validLaps: 0, positiveLaps: 0, drivenSeconds: 0, podiums: 0 });
    }
  } else {
    calendar.clear();
  }
  for (const session of periodSessions) {
    if (session.resultOutcomeStatus !== "confirmed" || session.resultClassification !== "finished"
      || !session.gameId || !Number.isInteger(session.finishingPosition) || (session.finishingPosition ?? 0) <= 0
      || !session.sessionType?.trim().toLowerCase().startsWith("race")) continue;
    const position = session.finishingPosition!;
    for (const field of ["track", "car"] as const) {
      const item = field === "track" ? identity(session.gameId, session.trackId, session.trackOrdinal) : identity(session.gameId, session.carId, session.carOrdinal);
      if (!item) continue;
      for (const aggregate of favourites[field].values()) {
        if (aggregate.gameId !== session.gameId || `${typeof aggregate.nativeId === "number" ? `n:${aggregate.nativeId}` : `s:${aggregate.nativeId}`}` !== item.key.slice(item.key.indexOf(":") + 1)) continue;
        aggregate.hasEvidence = true;
        if (position <= 3) aggregate.podiums++;
      }
    }
    if (position <= 3) {
      podiumEvidence = true;
      if (position === 1) first++; else if (position === 2) second++; else third++;
      const bucket = calendar.get(dayOf(session.createdAt));
      if (bucket) bucket.podiums++;
    }
  }
  const winner = (map: Map<string, ReferenceFavourite>): ReferenceFavourite | null => [...map.values()].sort((a, b) =>
    b.seconds - a.seconds || b.laps - a.laps || a.gameId.localeCompare(b.gameId) || String(a.nativeId).localeCompare(String(b.nativeId)))[0] ?? null;
  const deviations: number[] = [];
  for (const session of periodSessions) {
    const eligible = rows.filter((lap) => lap.sessionId === session.id && lap.isValid && Number.isFinite(lap.lapTime) && lap.lapTime > 0);
    const contexts = new Set(eligible.map((lap) => `${identity(lap.gameId!, lap.trackId, lap.trackOrdinal)?.key}|${identity(lap.gameId!, lap.carId, lap.carOrdinal)?.key}`));
    if (eligible.length < 2 || contexts.size !== 1 || contexts.has("null|null")) continue;
    const mean = eligible.reduce((sum, lap) => sum + lap.lapTime, 0) / eligible.length;
    deviations.push(Math.sqrt(eligible.reduce((sum, lap) => sum + (lap.lapTime - mean) ** 2, 0) / eligible.length));
  }
  const types: Record<DashboardSessionType, number> = { practice: 0, qualifying: 0, race: 0, unknown: 0 };
  let sessionsWithDuration = 0, sessionsWithoutDuration = 0;
  for (const session of periodSessions) {
    if (typeof session.elapsedSeconds !== "number" || !Number.isFinite(session.elapsedSeconds) || session.elapsedSeconds < 0) { sessionsWithoutDuration++; continue; }
    sessionsWithDuration++;
    const type = session.sessionType?.trim().toLowerCase();
    const kind: DashboardSessionType = type === "practice" || type?.startsWith("practice") ? "practice"
      : type === "qualifying" || type?.startsWith("qualifying") ? "qualifying"
      : type === "race" || type?.startsWith("race") ? "race" : "unknown";
    types[kind] += session.elapsedSeconds;
  }
  return {
    distribution: [...distribution.values()].sort((a, b) => b.seconds - a.seconds || a.gameId.localeCompare(b.gameId)).map(({ gameId, ordinal, seconds }) => ({ gameId, ordinal, seconds })),
    favouriteTrack: winner(favourites.track), favouriteCar: winner(favourites.car),
    consistency: deviations,
    sessionTypes: { types, sessionsWithDuration, sessionsWithoutDuration },
    podiums: { first, second, third, available: podiumEvidence },
    calendar: [...calendar].sort(([a], [b]) => a.localeCompare(b)).map(([day, values]) => ({ day, ...values })),
  };
}

test("published period bests and session counts are game-scoped and dirty minima fall through", async () => {
  const accWinner = await addSession("acc" as GameId, "2026-01-01T01:00:00.000Z");
  const accOther = await addSession("acc" as GameId, "2026-01-01T02:00:00.000Z");
  const iracingWinner = await addSession("iracing" as GameId, "2026-01-01T03:00:00.000Z");
  await addLap(iracingWinner, 1, 85, true, "2026-01-01T10:02:00.000Z");
  await addLap(accWinner, 1, 90, true, "2026-01-01T10:00:00.000Z");
  await addLap(accWinner, 2, 92, true, "2026-01-01T10:01:00.000Z");
  await addLap(accOther, 1, 94, true, "2026-01-01T11:00:00.000Z");
  for (const sessionId of [accWinner, accOther, iracingWinner]) {
    const candidate = await prepareDashboardPublicationCandidate(sessionId);
    if (!candidate || !(await publishDashboardSession(candidate))) throw new Error(`Failed to publish dashboard facts for ${sessionId}`);
  }
  const period = { from: "2026-01-01T00:00:00.000Z", to: "2026-01-02T00:00:00.000Z", timeZone: "UTC" };
  const allGames = await getDashboard(period);
  expect(allGames.totals).toMatchObject({ laps: 4, bestLapSeconds: 85, sessions: 3 });
  const acc = await getDashboard({ ...period, gameId: "acc" as GameId });
  expect(acc.totals).toMatchObject({ laps: 3, bestLapSeconds: 90, sessions: 2 });
  const iracing = await getDashboard({ ...period, gameId: "iracing" as GameId });
  expect(iracing.totals).toMatchObject({ laps: 1, bestLapSeconds: 85, sessions: 1 });

  await db.update(laps).set({ lapTime: 95 }).where(and(eq(laps.sessionId, accWinner), eq(laps.lapNumber, 1))).run();
  const dirtyAcc = await getDashboard({ ...period, gameId: "acc" as GameId });
  expect(dirtyAcc.totals).toMatchObject({ laps: 3, bestLapSeconds: 92, sessions: 2 });
});

test("published favorite track session count stays within requested period", async () => {
  const inPeriod = await addSession("acc" as GameId, "2026-01-01T10:00:00.000Z");
  const outOfPeriod = await addSession("acc" as GameId, "2026-01-02T10:00:00.000Z");
  await addLap(inPeriod, 1, 90, true, "2026-01-01T10:01:00.000Z");
  await addLap(outOfPeriod, 1, 90, true, "2026-01-02T10:01:00.000Z");
  for (const sessionId of [inPeriod, outOfPeriod]) {
    const candidate = await prepareDashboardPublicationCandidate(sessionId);
    if (!candidate || !(await publishDashboardSession(candidate, {
      sourceRevision: candidate.sourceRevision,
      captureRevision: `test-${sessionId}`,
      duration: { status: "unavailable", elapsedSeconds: null },
      sectorLayout: null,
      weather: { status: "unavailable", revision: null, conditions: null },
      trackLengthMeters: null,
      sourceSectorStarts: null,
    }))) throw new Error(`Failed to publish dashboard facts for ${sessionId}`);
  }

  const response = await getDashboard({
    from: "2026-01-01T00:00:00.000Z",
    to: "2026-01-02T00:00:00.000Z",
    timeZone: "UTC",
    gameId: "acc" as GameId,
  });
  expect(response.favouriteTrack).toMatchObject({ nativeId: 8, laps: 1, sessions: 1 });
});
test("getDashboard includes over 128 clean published boundary sessions without losing exact-period facts", async () => {
  const ids: number[] = [];
  const period = {
    from: "2026-10-09T00:00:00.000Z", to: "2026-10-09T00:45:00.000Z",
    timeZone: "UTC", gameId: "acc" as GameId,
  };
  try {
    for (let index = 0; index < 150; index++) {
      const id = await addSession("acc" as GameId, "2026-10-09T00:30:00.000Z");
      ids.push(id);
      await addLap(id, 1, 90, true, "2026-10-09T00:31:00.000Z");
      await addLap(id, 2, 92, true, "2026-10-09T00:32:00.000Z");
      await addLap(id, 3, 94, true, "2026-10-09T00:46:00.000Z");
    }
    for (const [index, id] of ids.entries()) {
      const candidate = await prepareDashboardPublicationCandidate(id);
      if (!candidate || !(await publishDashboardSession(candidate, {
        sourceRevision: candidate.sourceRevision,
        captureRevision: `boundary-${id}`,
        duration: index === 0 ? { status: "available", elapsedSeconds: 3600 } : { status: "unavailable", elapsedSeconds: null },
        sectorLayout: null,
        weather: { status: "unavailable", revision: null, conditions: null },
        trackLengthMeters: null,
        sourceSectorStarts: null,
      }))) throw new Error(`Failed to publish dashboard facts for ${id}`);
    }

    const response = await getDashboard(period);
    expect(response.coverage).toMatchObject({
      status: "complete", metadataComplete: true, mineSessions: 150, readySessions: 150, pendingSessions: 0,
    });
    expect(response.totals).toMatchObject({
      laps: 300, positiveLaps: 300, validLaps: 300, drivenSeconds: 27300, validSeconds: 27300,
      bestLapSeconds: 90, averageLapSeconds: 91, tracks: 1, cars: 1, sessions: 150,
    });
    expect(response.calendar).toHaveLength(1);
    expect(response.calendar[0]).toMatchObject({ day: "2026-10-09", validLaps: 300, positiveLaps: 300, cleanRate: 1, drivenSeconds: 27300 });
    expect(response.consistency).toMatchObject({ sessions: 150, averageStandardDeviation: 1 });
    expect(response.consistency.deviations[9]).toBe(150);
    expect(response.favouriteTrack).toMatchObject({ nativeId: 8, laps: 300, sessions: 150 });
    expect(response.sessionTypes).toMatchObject({ totalSeconds: 3600, sessionsWithDuration: 1, sessionsWithoutDuration: 149 });
  } finally {
    for (const id of ids) {
      await deleteSession(id);
      const deleted = await prepareDashboardPublicationCandidate(id);
      if (deleted) await publishDashboardSession(deleted);
    }
    for (let index = ownedSessionIds.length - 1; index >= 0; index--) {
      if (ids.includes(ownedSessionIds[index]!)) ownedSessionIds.splice(index, 1);
    }
  }
});



test("dashboard HTTP keeps all-game cards while bounding exact selected-game output", async () => {
  const ids = [await addSession("iracing" as GameId, "2026-01-01T03:00:00.000Z")];
  const accIds: number[] = [];
  for (let index = 0; index < 11; index++) {
    const id = await addSession("acc" as GameId, `2026-01-01T04:${String(index).padStart(2, "0")}:00.000Z`);
    accIds.push(id);
    ids.push(id);
    await addLap(id, 1, 90 + index, true, `2026-01-01T12:${String(index).padStart(2, "0")}:00.000Z`);
  }
  await addLap(ids[0]!, 1, 85, true, "2026-01-01T12:20:00.000Z");
  await db.update(sessions).set({ sessionType: "race" }).where(eq(sessions.id, accIds[0]!)).run();
  await client.execute({ sql: "INSERT INTO session_results(session_id,session_type,outcome_status,classification,finishing_position) VALUES (?,'race','confirmed','finished',4)", args: [accIds[0]!] });
  for (const sessionId of ids) {
    const candidate = await prepareDashboardPublicationCandidate(sessionId);
    if (!candidate || !(await publishDashboardSession(candidate))) throw new Error(`Failed to publish dashboard facts for ${sessionId}`);
  }
  const podiumSource = await client.execute({
    sql: `SELECT s.ownership, s.session_type, r.session_type result_session_type, r.outcome_status,
        r.classification, r.finishing_position, p.podium_status, p.podium_position
      FROM sessions s JOIN session_results r ON r.session_id=s.id
      JOIN dashboard_session_summaries p ON p.session_id=s.id WHERE s.id=?`,
    args: [accIds[0]!],
  });
  expect(podiumSource.rows[0]).toMatchObject({
    ownership: "mine", session_type: "race", result_session_type: "race",
    outcome_status: "confirmed", classification: "finished", finishing_position: 4,
    podium_status: "confirmed", podium_position: 4,
  });
  const from = "2026-01-01T00:00:00.000Z";
  const to = "2026-01-02T00:00:00.000Z";
  const sourceOracle = await db.select({
    gameId: sessions.gameId,
    laps: sql<number>`count(${laps.id})`,
    sessions: sql<number>`count(distinct ${sessions.id})`,
    bestLapSeconds: sql<number | null>`min(case when ${laps.isValid} = 1 and ${laps.lapTime} > 0 then ${laps.lapTime} end)`,
  }).from(sessions).leftJoin(laps, and(
    eq(laps.sessionId, sessions.id),
    gte(laps.createdAt, from),
    lt(laps.createdAt, to),
  )).where(and(inArray(sessions.id, ids), eq(sessions.ownership, "mine"))).groupBy(sessions.gameId).all();
  expect(sourceOracle).toContainEqual({ gameId: "acc", laps: 11, sessions: 11, bestLapSeconds: 90 });
  expect(sourceOracle).toContainEqual({ gameId: "iracing", laps: 1, sessions: 1, bestLapSeconds: 85 });


  const query = "from=2026-01-01T00%3A00%3A00Z&to=2026-01-02T00%3A00%3A00Z&timeZone=UTC";
  const selected = await dashboardRoutes.request(`/api/dashboard?${query}`, { headers: { "X-Game-Id": "acc" } });
  expect(selected.status).toBe(200);
  const response = await selected.json() as DashboardResponse;
  expect(response.totals).toMatchObject({ laps: 11, sessions: 11 });
  expect(response.cards.acc.laps).toBe(11);
  expect(response.cards.iracing.laps).toBe(1);
  expect(response.recentSessions).toHaveLength(10);
  expect(response.recentSessions.every((session) => session.gameId === "acc")).toBe(true);
  expect(JSON.stringify(response)).not.toMatch(/rawFile|capturePath|provenance|setup/i);
  expect(new TextEncoder().encode(JSON.stringify(response)).byteLength).toBeLessThan(128 * 1024);
  expect(response.podiums).toMatchObject({ total: 0, available: true });

  const allGames = await dashboardRoutes.request(`/api/dashboard?${query}`);
  expect((await allGames.json() as DashboardResponse).totals).toMatchObject({ laps: 12, sessions: 12 });
  const unavailable = await dashboardRoutes.request("/api/dashboard?from=2026-02-01T00%3A00%3A00Z&to=2026-02-02T00%3A00%3A00Z&timeZone=UTC", { headers: { "X-Game-Id": "acc" } });
  expect((await unavailable.json() as DashboardResponse).podiums).toMatchObject({ total: 0, available: false });
});
test("dashboard preserves ordinal zero, groups UTC rollover by local day, and retains tiny deviations", async () => {
  const inserted = await db.insert(sessions).values({
    gameId: "acc", carId: null, carOrdinal: 0, trackId: null, trackOrdinal: 0,
    ownership: "mine", createdAt: "2026-01-01T03:00:00.000Z",
  }).returning({ id: sessions.id }).get();
  ownedSessionIds.push(inserted.id);
  await addLap(inserted.id, 1, 1, true, "2026-01-02T02:00:00.000Z");
  await addLap(inserted.id, 2, 1.00000002, true, "2026-01-02T02:01:00.000Z");
  const malformed = await db.insert(sessions).values({
    gameId: "acc", carId: null, carOrdinal: -1, trackId: null, trackOrdinal: -1,
    ownership: "mine", createdAt: "2026-01-01T04:00:00.000Z",
  }).returning({ id: sessions.id }).get();
  ownedSessionIds.push(malformed.id);
  await addLap(malformed.id, 1, 2, true, "2026-01-02T02:02:00.000Z");
  const actual = await getDashboard({
    from: "2026-01-01T00:00:00.000Z", to: "2026-01-03T00:00:00.000Z",
    timeZone: "America/Los_Angeles",
  });
  expect(actual.totals).toMatchObject({ tracks: 1, cars: 1 });
  expect(actual.favouriteTrack?.identity).toBe('["acc","n:0"]');
  expect(actual.favouriteCar?.identity).toBe('["acc","n:0"]');
  expect(actual.calendar.find((bucket) => bucket.day === "2026-01-01")?.validLaps).toBe(3);
  expect(actual.calendar.find((bucket) => bucket.day === "2026-01-02")?.validLaps).toBe(0);
  expect(actual.consistency.averageStandardDeviation).toBeCloseTo(1e-8, 10);
});

test("getDashboard treats clean previous-version publications as stale and uses source fallback", async () => {
  const sessionId = await addSession("acc" as GameId, "2026-06-01T10:00:00.000Z");
  await addLap(sessionId, 1, 90, true, "2026-06-01T10:01:00.000Z");
  const candidate = await prepareDashboardPublicationCandidate(sessionId);
  expect(candidate).not.toBeNull();
  expect(await publishDashboardSession(candidate!, {
    sourceRevision: candidate!.sourceRevision,
    captureRevision: "capture-v1",
    duration: { status: "available", elapsedSeconds: 3600 },
    sectorLayout: null,
    weather: { status: "unavailable", revision: null, conditions: null },
    trackLengthMeters: null,
    sourceSectorStarts: null,
  })).toBe(true);
  const source = await db.select({ sourceRevision: dashboardSummaryState.sourceRevision })
    .from(dashboardSummaryState).where(eq(dashboardSummaryState.sessionId, sessionId)).get();
  expect(source).toBeDefined();
  await db.update(dashboardSummaryState).set({
    processorVersion: DASHBOARD_PROCESSOR_VERSION - 1,
    metadataDirty: 0,
    captureDirty: 0,
    publishedRevision: source!.sourceRevision,
  }).where(eq(dashboardSummaryState.sessionId, sessionId)).run();
  await db.update(dashboardSessionSummaries).set({
    processorVersion: DASHBOARD_PROCESSOR_VERSION - 1,
  }).where(eq(dashboardSessionSummaries.sessionId, sessionId)).run();

  const response = await getDashboard(request);
  expect(response.coverage).toMatchObject({
    status: "pending",
    mineSessions: 1,
    readySessions: 0,
    pendingSessions: 1,
  });
  expect(response.coverage.metadataComplete).toBe(true);
  expect(response.totals).toMatchObject({ laps: 1, bestLapSeconds: 90, sessions: 1 });
  expect(response.sessionTypes.sessionsWithDuration).toBe(0);
});

test("getDashboard matches the independent reducer for bounded source fallback", async () => {
  const sessionIds = [
    await addSession("acc" as GameId, "2026-06-01T10:00:00.000Z"),
    await addSession("acc" as GameId, "2026-06-02T10:00:00.000Z"),
    await addSession("iracing" as GameId, "2026-06-03T10:00:00.000Z"),
    await addSession("acc" as GameId, "2026-06-04T10:00:00.000Z", "others"),
  ];
  await addLap(sessionIds[0]!, 1, 90, true, "2026-06-01T10:01:00.000Z");
  await addLap(sessionIds[0]!, 2, 92, false, "2026-06-01T10:02:00.000Z");
  await addLap(sessionIds[1]!, 1, 88, true, "2026-06-02T10:01:00.000Z");
  await addLap(sessionIds[2]!, 1, 101, true, "2026-06-03T10:01:00.000Z");
  await addLap(sessionIds[3]!, 1, 70, true, "2026-06-04T10:01:00.000Z");
  const rows = await db.select({
    id: laps.id, sessionId: laps.sessionId, lapNumber: laps.lapNumber, lapTime: laps.lapTime,
    isValid: laps.isValid, createdAt: laps.createdAt, gameId: sessions.gameId,
    ownership: sessions.ownership, carId: sessions.carId, trackId: sessions.trackId,
    carOrdinal: sessions.carOrdinal, trackOrdinal: sessions.trackOrdinal,
  }).from(laps).innerJoin(sessions, eq(laps.sessionId, sessions.id)).where(inArray(laps.sessionId, sessionIds)).all();
  const sourceLaps = rows.map((row) => asLap(row!));
  const sourceSessions = (await db.select().from(sessions).where(inArray(sessions.id, sessionIds)).all()) as unknown as SessionMeta[];
  const oracle = reduceDashboard(sourceLaps, sourceSessions, request);
  const actual = await getDashboard(request);
  expect(actual.coverage.status).toBe("pending");
  expect(actual.coverage.metadataComplete).toBe(true);
  expect(actual.totals).toMatchObject({
    laps: oracle.totals.laps, positiveLaps: oracle.totals.positiveLaps, validLaps: oracle.totals.validLaps,
    drivenSeconds: oracle.totals.drivenSeconds, validSeconds: oracle.totals.validSeconds,
    bestLapSeconds: oracle.totals.bestLapSeconds, averageLapSeconds: oracle.totals.averageLapSeconds,
    sessions: oracle.totals.sessions, tracks: oracle.totals.tracks, cars: oracle.totals.cars,
  });
  expect(actual.cards.acc).toMatchObject(oracle.cards.acc);
  expect(actual.cards.iracing).toMatchObject(oracle.cards.iracing);
});

test("source oracle includes target-game laps beyond cap; dashboard reports oversized fallback pending", async () => {
  for (let index = 0; index < 205; index++) {
    const createdAt = `2026-02-${String(index % 27 + 1).padStart(2, "0")}T12:00:00.000Z`;
    const sessionId = await addSession("acc" as GameId, createdAt);
    await addLap(sessionId, 1, 90 + (index % 10), index % 4 !== 0, createdAt);
  }
  for (let index = 0; index < 200; index++) {
    const createdAt = "2026-02-28T12:00:00.000Z";
    const sessionId = await addSession("iracing" as GameId, createdAt);
    await addLap(sessionId, 1, 100 + index, true, createdAt);
  }

  const from = "2026-02-01T00:00:00.000Z";
  const to = "2026-03-01T00:00:00.000Z";
  const where = sql`${sessions.gameId} = ${"acc"} AND ${sessions.ownership} = 'mine' AND ${laps.createdAt} >= ${from} AND ${laps.createdAt} < ${to}`;
  const oracle = await db.select({
    laps: sql<number>`count(*)`,
    positiveLaps: sql<number>`sum(CASE WHEN ${laps.lapTime} > 0 THEN 1 ELSE 0 END)`,
    validLaps: sql<number>`sum(CASE WHEN ${laps.isValid} = 1 AND ${laps.lapTime} > 0 THEN 1 ELSE 0 END)`,
    drivenSeconds: sql<number>`sum(CASE WHEN ${laps.lapTime} > 0 THEN ${laps.lapTime} ELSE 0 END)`,
    validSeconds: sql<number>`sum(CASE WHEN ${laps.isValid} = 1 AND ${laps.lapTime} > 0 THEN ${laps.lapTime} ELSE 0 END)`,
    bestLapSeconds: sql<number>`min(CASE WHEN ${laps.isValid} = 1 AND ${laps.lapTime} > 0 THEN ${laps.lapTime} END)`,
    sessions: sql<number>`count(DISTINCT ${sessions.id})`,
    tracks: sql<number>`count(DISTINCT ${sessions.trackId})`,
    cars: sql<number>`count(DISTINCT ${sessions.carId})`,
  }).from(laps).innerJoin(sessions, eq(laps.sessionId, sessions.id)).where(where).get();
  const sourceRows = await db.select({
    id: laps.id, sessionId: laps.sessionId, lapNumber: laps.lapNumber, lapTime: laps.lapTime,
    isValid: laps.isValid, createdAt: laps.createdAt, gameId: sessions.gameId,
    ownership: sessions.ownership, carId: sessions.carId, trackId: sessions.trackId,
    carOrdinal: sessions.carOrdinal, trackOrdinal: sessions.trackOrdinal,
  }).from(laps).innerJoin(sessions, eq(laps.sessionId, sessions.id)).where(where).all();
  const shared = reduceDashboardLaps(sourceRows.map((row) => asLap(row!)), { ...request, from, to, gameId: "acc" as GameId });
  expect(oracle).toMatchObject({ laps: 205, positiveLaps: 205, validLaps: 153, sessions: 205, tracks: 1, cars: 1 });
  expect(shared).toMatchObject({
    laps: oracle!.laps, positiveLaps: oracle!.positiveLaps, validLaps: oracle!.validLaps,
    drivenSeconds: oracle!.drivenSeconds, validSeconds: oracle!.validSeconds,
    bestLapSeconds: oracle!.bestLapSeconds, averageLapSeconds: oracle!.validSeconds / oracle!.validLaps,
    sessions: oracle!.sessions, tracks: oracle!.tracks, cars: oracle!.cars,
  });
  const actual = await getDashboard({ ...request, from, to, gameId: "acc" as GameId });
  expect(actual.coverage.status).toBe("pending");
  expect(actual.coverage.metadataComplete).toBe(false);
  expect(actual.coverage.pendingSessions).toBe(205);
  expect(actual.totals.laps).toBe(0);
});
test("SQL ownership transitions change eligible source rows exactly", async () => {
  const sessionId = await addSession("acc" as GameId, request.from, "others");
  await addLap(sessionId, 1, 90);
  const countMineRows = async () => db.select({ count: sql<number>`count(*)` })
    .from(laps).innerJoin(sessions, eq(laps.sessionId, sessions.id))
    .where(sql`${sessions.id} = ${sessionId} AND ${sessions.ownership} = 'mine'`).get();
  expect((await countMineRows())?.count).toBe(0);
  await db.update(sessions).set({ ownership: "mine" }).where(eq(sessions.id, sessionId));
  expect((await countMineRows())?.count).toBe(1);
  await db.update(sessions).set({ ownership: "others" }).where(eq(sessions.id, sessionId));
  expect((await countMineRows())?.count).toBe(0);
});

test("ownership and source identity preserve exact mine, native IDs, ordinal zero and sentinels", () => {
  expect(["mine", "others", null, undefined, "unknown"].map(isDashboardOwned)).toEqual([true, false, false, false, false]);
  expect(dashboardTrackIdentity("lmu" as GameId, "track-α", 0)).toBe('["lmu","s:track-α"]');
  expect(dashboardTrackIdentity("acc" as GameId, "8", 99)).toBe(dashboardTrackIdentity("acc" as GameId, 8, 2));
  expect(dashboardCarIdentity("acc" as GameId, null, 0)).toBe('["acc","n:0"]');
  expect(dashboardCarIdentity("acc" as GameId, "-1", 0)).toBe(dashboardCarIdentity("acc" as GameId, null, 0));
  expect(dashboardCarIdentity("acc" as GameId, "", 0)).toBe(dashboardCarIdentity("acc" as GameId, null, 0));
  expect(dashboardCarIdentity("acc" as GameId, "-1.0", 0)).toBe(dashboardCarIdentity("acc" as GameId, null, 0));
  expect(dashboardTrackIdentity("iracing" as GameId, 0, 9)).not.toBe(dashboardTrackIdentity("acc" as GameId, 0, 9));
});

test("reducer counts recorded zero-time laps, excludes non-mine, and separates positive from valid", () => {
  const facts = reduceDashboardLaps([
    baseLap({ lapTime: 0, isValid: false }),
    baseLap({ id: 2, sessionId: 2, lapTime: 91, isValid: true, ownership: "others" }),
    baseLap({ id: 3, sessionId: 3, ownership: "unknown" as "mine" }),
    baseLap({ id: 4, sessionId: 4, ownership: undefined }),
    baseLap({ id: 5, sessionId: 5, ownership: null as unknown as "mine" }),
  ], request);
  expect(facts).toMatchObject({
    laps: 1, positiveLaps: 0, validLaps: 0, drivenSeconds: 0, validSeconds: 0,
    bestLapSeconds: null, averageLapSeconds: null, tracks: 1, cars: 1, sessions: 1,
  });
});

test("favorite aggregation canonicalizes numeric native IDs and excludes incomplete laps", () => {
  const result = reduceDashboard([
    baseLap({ lapTime: 90, invalidReason: "incomplete" }),
    baseLap({ id: 2, lapNumber: 2, trackId: "8", trackOrdinal: 8, lapTime: 100 }),
  ], [baseSession(), baseSession({ id: 2 })], request, { trackLengthsMeters: { "acc:8": 5 } });
  expect(result.trackDistribution).toMatchObject({
    totalSeconds: 190, topFive: [{ gameId: "acc", ordinal: 8, seconds: 190 }],
  });
  expect(result.favouriteTrack).toMatchObject({
    nativeId: 8, seconds: 100, laps: 1, sessions: 2, distanceMeters: 5, distanceLaps: 1,
  });
  expect(result.favouriteCar).toMatchObject({ gameId: "acc", nativeId: 7, distanceMeters: 5, distanceLaps: 1 });
});

test("favourite tie ranking preserves lap-count precedence", () => {
  const result = reduceDashboard([
    baseLap({ lapTime: 50 }),
    baseLap({ id: 2, sessionId: 2, lapNumber: 2, lapTime: 50 }),
    baseLap({ id: 3, sessionId: 3, trackId: 9, trackOrdinal: 9, lapTime: 100 }),
  ], [baseSession(), baseSession({ id: 2 }), baseSession({ id: 3, trackId: 9 })], request);
  expect(result.favouriteTrack).toMatchObject({ nativeId: 8, seconds: 100, laps: 2 });
});

test("consistency uses valid same-context laps and podium evidence distinguishes zero from absent", () => {
  const consistent = reduceDashboard([
    baseLap({ lapTime: 90 }), baseLap({ id: 2, lapNumber: 2, lapTime: 92 }),
    baseLap({ id: 3, sessionId: 2, lapTime: 10 }), baseLap({ id: 4, sessionId: 2, lapNumber: 2, lapTime: 14 }),
    baseLap({ id: 5, sessionId: 2, lapNumber: 3, lapTime: 14 }), baseLap({ id: 6, sessionId: 2, lapNumber: 4, lapTime: 14 }),
    baseLap({ id: 7, sessionId: 2, lapNumber: 5, lapTime: 14 }),
  ], [baseSession(), baseSession({ id: 2 })], request);
  expect(consistent.consistency).toMatchObject({ sessions: 2, averageStandardDeviation: 1.3 });
  const noEvidence = reduceDashboard([baseLap()], [baseSession()], request);
  expect(noEvidence.favouriteTrack?.podiums).toBeNull();
  const confirmedOutsidePodium = reduceDashboard([baseLap()], [baseSession({
    resultOutcomeStatus: "confirmed", resultClassification: "finished", finishingPosition: 4,
  })], request);
  expect(confirmedOutsidePodium.podiums).toMatchObject({ total: 0, available: true });
  expect(confirmedOutsidePodium.favouriteTrack?.podiums).toBe(0);
});
test("full reducer matches independent reference facts across dashboard aggregates", () => {
  const laps = [
    baseLap(),
    baseLap({ id: 2, sessionId: 2, gameId: "iracing" as GameId, lapTime: 100 }),
    baseLap({ id: 3, sessionId: 3, ownership: "others" }),
    baseLap({ id: 4, sessionId: 4, ownership: "unknown" as "mine" }),
  ];
  const sessions = [
    baseSession({ elapsedSeconds: 120, sessionType: "race", resultOutcomeStatus: "confirmed", resultClassification: "finished", finishingPosition: 1 }),
    baseSession({ id: 2, gameId: "iracing" as GameId, elapsedSeconds: 80, sessionType: "practice" }),
  ];
  const response = reduceDashboard(laps, sessions, request);
  const expected = referenceDashboardFacts(laps, sessions, request);
  expect(response.totals).toMatchObject({ laps: 2, drivenSeconds: 190, sessions: 2 });
  expect(response.cards.acc).toEqual({ laps: 1, drivenSeconds: 90 });
  expect(response.cards.iracing).toEqual({ laps: 1, drivenSeconds: 100 });
  expect(response.trackDistribution.topFive.map(({ gameId, ordinal, seconds }) => ({ gameId, ordinal, seconds }))).toEqual(expected.distribution);
  const favouriteProjection = (value: typeof response.favouriteTrack) => value && ({
    gameId: value.gameId, nativeId: value.nativeId, ordinal: value.ordinal, seconds: value.seconds,
    laps: value.laps, sessions: value.sessions, distanceMeters: value.distanceMeters, podiums: value.podiums,
  });
  const favouriteExpected = (value: typeof expected.favouriteTrack) => value && ({
    gameId: value.gameId, nativeId: value.nativeId, ordinal: value.ordinal, seconds: value.seconds,
    laps: value.laps, sessions: value.sessions.size, distanceMeters: value.distanceLaps ? value.distanceMeters : null,
    podiums: value.hasEvidence ? value.podiums : null,
  });
  expect(favouriteProjection(response.favouriteTrack)).toEqual(favouriteExpected(expected.favouriteTrack));
  expect(favouriteProjection(response.favouriteCar)).toEqual(favouriteExpected(expected.favouriteCar));
  expect(response.consistency).toMatchObject({ sessions: expected.consistency.length, averageStandardDeviation: null });
  expect(response.sessionTypes.shares.map(({ kind, seconds }) => ({ kind, seconds }))).toEqual(
    (Object.entries(expected.sessionTypes.types) as [DashboardSessionType, number][]).map(([kind, seconds]) => ({ kind, seconds })),
  );
  expect(response.sessionTypes).toMatchObject({
    totalSeconds: Object.values(expected.sessionTypes.types).reduce((sum, value) => sum + value, 0),
    sessionsWithDuration: expected.sessionTypes.sessionsWithDuration,
    sessionsWithoutDuration: expected.sessionTypes.sessionsWithoutDuration,
  });
  expect(response.podiums).toMatchObject({
    first: expected.podiums.first, second: expected.podiums.second, third: expected.podiums.third,
    available: expected.podiums.available,
  });
  expect(response.calendar.map(({ day, validLaps, positiveLaps, drivenSeconds, podiums }) =>
    ({ day, validLaps, positiveLaps, drivenSeconds, podiums }))).toEqual(expected.calendar);
});

test("half-open UTC boundaries preserve UTC instants and local DST calendar day length", () => {

  const from = "2026-03-08T08:00:00.000Z";
  const to = "2026-03-09T07:00:00.000Z";
  expect(isInDashboardInterval("2026-03-08T07:59:59.999Z", from, to)).toBe(false);
  expect(isInDashboardInterval(from, from, to)).toBe(true);
  expect(isInDashboardInterval("2026-03-08 08:00:00", from, to)).toBe(true);
  expect(isInDashboardInterval("2026-03-08T08:00:00-00:00", from, to)).toBe(true);
  expect(isInDashboardInterval(to, from, to)).toBe(false);
  const response = reduceDashboard([
    baseLap({ createdAt: from }), baseLap({ id: 2, createdAt: to }),
  ], [], { from, to, timeZone: "America/Los_Angeles" });
  expect(response.calendar).toHaveLength(1);
  expect(response.calendar[0]).toMatchObject({ day: "2026-03-08", from, to, validLaps: 1 });
  expect(Date.parse(to) - Date.parse(from)).toBe(23 * 60 * 60 * 1000);
  expect(validateDashboardRequest({ from, to, timeZone: "invalid/timezone" })).toBe(false);
});
test("actual dashboard reducer leaves others-only source facts empty", () => {
  const noRowsRequest = {
    ...request, from: "2026-06-01T00:00:00.000Z", to: "2026-06-02T00:00:00.000Z",
    timeZone: "UTC", gameId: "acc" as GameId,
  };
  const response = reduceDashboard(
    [baseLap({ ownership: "others" })],
    [baseSession({ ownership: "others" })],
    noRowsRequest,
  );
  expect(response.totals).toMatchObject({ laps: 0, positiveLaps: 0, validLaps: 0, drivenSeconds: 0, sessions: 0 });
  expect(response.cards.acc).toEqual({ laps: 0, drivenSeconds: 0 });
  expect(response.trackDistribution).toMatchObject({ totalSeconds: 0, topFive: [], othersSeconds: 0, othersCount: 0 });
  expect(response.favouriteTrack).toBeNull();
  expect(response.favouriteCar).toBeNull();
  expect(response.podiums).toMatchObject({ total: 0, available: false });
  expect(response.recentSessions).toEqual([]);
  expect(response.latestRecapSessionId).toBeNull();
  expect(response.calendar.map(({ day, validLaps, positiveLaps, drivenSeconds, podiums }) =>
    ({ day, validLaps, positiveLaps, drivenSeconds, podiums }))).toEqual([
    { day: "2026-06-01", validLaps: 0, positiveLaps: 0, drivenSeconds: 0, podiums: 0 },
  ]);
});

test("recent ordering and recap lookup exclude unknown ownership before limiting", () => {
  const rows = Array.from({ length: 12 }, (_, index) => baseSession({
    id: index + 1,
    createdAt: new Date(Date.parse(request.to) - (index + 1) * 60_000).toISOString(),
    ownership: index < 2 ? "unknown" as "mine" : "mine",
  }));
  const recent = selectDashboardRecentSessions(rows, { ...request, gameId: "acc" as GameId });
  expect(recent).toHaveLength(10);
  expect(recent.map(({ id }) => id)).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  expect(recent[0]).not.toHaveProperty("ownership");
  expect(isDashboardRecapEligible({ ownership: "mine", gameId: "acc" as GameId }, "acc" as GameId)).toBe(true);
  expect(isDashboardRecapEligible({ ownership: "others", gameId: "acc" as GameId }, "acc" as GameId)).toBe(false);
});

test("recap history requires compatible exact-mine sessions and matching sector evidence", () => {
  const current = { sessionId: 1, gameId: "acc" as GameId, carId: 7, carOrdinal: 7, trackId: 8, trackOrdinal: 8, sectorLayoutKey: "layout-v1", sectorCount: 3 };
  const currentLap = baseLap({ lapTime: 70, sectorTimes: [20, 20, 30] });
  const differentLayoutLap = baseLap({ id: 4, sessionId: 5, lapTime: 60, sectorTimes: [20, 20, 20] });
  const sessions = [
    baseSession({ id: 1 }), baseSession({ id: 2 }), baseSession({ id: 3, ownership: "others" }),
    baseSession({ id: 4, trackId: 9 }), baseSession({ id: 5 }),
  ];
  const laps = [
    currentLap,
    baseLap({ id: 2, sessionId: 2, lapTime: 91, sectorTimes: [30, 31, 30] }),
    baseLap({ id: 3, sessionId: 3, lapTime: 80, sectorTimes: [20, 20, 20] }),
    baseLap({ id: 4, sessionId: 4, lapTime: 82, sectorTimes: [20, 20, 20] }),
    differentLayoutLap,
  ];
  const layouts: Readonly<Record<number, string | null>> = {
    2: "layout-v1", 3: "layout-v1", 4: "layout-v1", 5: "layout-v2",
  };
  const recapSessionIds = new Set(sessions.filter((session) =>
    session.id !== current.sessionId && session.ownership === "mine" && session.gameId === current.gameId
      && session.carId === current.carId && session.trackId === current.trackId,
  ).map(({ id }) => id));
  const recapLaps = laps.filter((lap) => recapSessionIds.has(lap.sessionId) && lap.gameId === current.gameId
    && lap.ownership === "mine" && lap.isValid && Number.isFinite(lap.lapTime) && lap.lapTime > 0);
  const referenceBestLap = recapLaps.length ? Math.min(...recapLaps.map(({ lapTime }) => lapTime)) : null;
  const sectorLaps = recapLaps.filter((lap) => layouts[lap.sessionId] === current.sectorLayoutKey
    && lap.sectorTimes?.length === current.sectorCount && lap.sectorTimes.every((time) => Number.isFinite(time) && time > 0));
  const referenceBestSectors = current.sectorLayoutKey && sectorLaps.length
    ? Array.from({ length: current.sectorCount }, (_, index) => Math.min(...sectorLaps.map((lap) => lap.sectorTimes![index]!)))
    : null;
  const history = reduceDashboardRecapHistory(current, sessions, laps, layouts);
  expect(history).toEqual({ bestLapSeconds: referenceBestLap, bestSectorSeconds: referenceBestSectors });
  expect(history).toEqual({ bestLapSeconds: 60, bestSectorSeconds: [30, 31, 30] });
  expect(reduceDashboardRecapHistory({ ...current, sectorLayoutKey: null }, [baseSession({ id: 2 })], [baseLap({ sessionId: 2, sectorTimes: [30, 31, 30] })], { 2: "layout-v1" }))
    .toEqual({ bestLapSeconds: 90, bestSectorSeconds: null });

});

test("dashboard distinguishes unknown from confirmed zero session duration", () => {
  const response = reduceDashboard([], [
    baseSession({ id: 1, elapsedSeconds: null }),
    baseSession({ id: 2, elapsedSeconds: 0 }),
  ], request);
  expect(response.sessionTypes.sessionsWithDuration).toBe(1);
  expect(response.sessionTypes.sessionsWithoutDuration).toBe(1);
  expect(response.sessionTypes.totalSeconds).toBe(0);
});
