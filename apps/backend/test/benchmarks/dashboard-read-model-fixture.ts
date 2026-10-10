import { client, db, initDb } from "@raceiq/backend-core/db/index";
import { laps, sessionResults, sessions } from "@raceiq/backend-core/db/schema";
import { prepareDashboardPublicationCandidate, publishDashboardSession, type DashboardCaptureFacts } from "@raceiq/backend-core/db/dashboard-summary-queries";
import type { GameId } from "@raceiq/shared/games/ids";
import type { DashboardRequest } from "@raceiq/shared/racing/sessions/dashboard";

export interface DashboardFixtureOptions { lapCount: number; sessionCount: number; seed: number; distribution: "standard" | "boundary-heavy"; publish: boolean; profile?: "active-user" | "archive-stress" }
export interface DashboardFixtureMetadata {
  options: DashboardFixtureOptions;
  expected: { laps: number; mineLaps: number; sessions: number; ownershipExcludedLaps: number };
  requestScopes: readonly DashboardRequest[];
  latestRecapSessionId: number;
  latestRecapGameId: GameId;
  gameCounts: Readonly<Record<GameId, number>>;
  identityCounts: readonly { gameId: GameId; sessions: number; tracks: number; cars: number }[];
}
const GAMES: readonly GameId[] = ["fm-2023", "f1-2025", "acc", "ac-evo", "iracing", "lmu"];
const GAME_CUMULATIVE_SHARES = [40, 65, 80, 90, 96, 100] as const;
function fixtureGameIndex(sessionIndex: number, sessionCount: number, activeUser = false): number {
  const percent = activeUser ? (sessionIndex * 37) % 100 + 0.5 : (sessionIndex + 0.5) * 100 / sessionCount;
  const index = GAME_CUMULATIVE_SHARES.findIndex((limit) => percent < limit);
  return index < 0 ? GAMES.length - 1 : index;
}
const FIXTURE_HISTORY_START = "2024-01-01T00:00:00.000Z";
const FIXTURE_HISTORY_END = "2026-01-01T00:00:00.000Z";
const REQUEST_SCOPES: readonly DashboardRequest[] = [
  { from: "2024-01-01T00:00:00.000Z", to: "2024-07-01T00:00:00.000Z" },
  { from: "2024-07-01T00:00:00.000Z", to: "2025-01-01T00:00:00.000Z" },
  { from: "2025-01-01T00:00:00.000Z", to: "2025-07-01T00:00:00.000Z" },
  { from: "2025-07-01T00:00:00.000Z", to: "2026-01-01T00:00:00.000Z" },
];
const DAY = 86_400_000, startMs = Date.parse(FIXTURE_HISTORY_START);
export const DASHBOARD_FIXTURE_HISTORY_END = FIXTURE_HISTORY_END;
export const REALISTIC_DASHBOARD_SHAPE = { lapCount: 12_480, sessionCount: 1_248 } as const;
export const ARCHIVE_STRESS_SHAPES = {
  "archive-100k": { lapCount: 100_000, sessionCount: 10_000 },
  "archive-1m": { lapCount: 1_000_000, sessionCount: 100_000 },
} as const;
let randomState = 1;
function random(): number { randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0; return randomState / 0x1_0000_0000; }
// Source authority belongs to this synthetic fixture contract, not native game recordings.
// Track ordinal 0 uses a declared three-sector layout; its laps are generated with ordered sector times.
const FIXTURE_SECTOR_STARTS = [0, 1 / 3, 2 / 3] as const;
function sourceTime(sessionIndex: number, sessionCount: number, lapIndex: number, distribution: DashboardFixtureOptions["distribution"], forSession = false, activeUser = false): string {
  if (distribution === "boundary-heavy") {
    if (forSession) return new Date(startMs + DAY + 12 * 60 * 60 * 1000).toISOString();
    const offset = lapIndex % 3 === 0 ? -1 : lapIndex % 3 === 1 ? 0 : DAY;
    return new Date(startMs + DAY + offset).toISOString();
  }
  const historyMs = Date.parse(FIXTURE_HISTORY_END) - startMs, longestSessionMs = (activeUser ? 10 : 500) * 90_000;
  const start = startMs + Math.floor(sessionIndex / Math.max(1, sessionCount - 1) * (historyMs - longestSessionMs));
  return new Date(start + lapIndex * 90_000).toISOString();
}

export async function createDashboardFixture(options: DashboardFixtureOptions): Promise<DashboardFixtureMetadata> {
  if (!Number.isSafeInteger(options.lapCount) || options.lapCount < 1 || !Number.isSafeInteger(options.sessionCount) || options.sessionCount < 1 || options.lapCount < options.sessionCount) throw new RangeError("Invalid dashboard fixture shape");
  await initDb(); randomState = options.seed >>> 0;
  const existing = await client.execute("SELECT COUNT(*) AS count,COALESCE(MAX(id),0) AS last_id FROM sessions");
  if (Number(existing.rows[0]?.count) !== 0) throw new Error("Dashboard fixture requires an empty isolated database");
  const firstId = Number(existing.rows[0]?.last_id ?? 0) + 1;
  const activeUser = options.profile === "active-user";
  const recapLaps = Math.min(activeUser ? 10 : 500, options.lapCount - options.sessionCount + 1);
  const otherCount = options.sessionCount - 1;
  const perSession = otherCount ? Math.floor((options.lapCount - recapLaps) / otherCount) : recapLaps;
  const remainder = otherCount ? (options.lapCount - recapLaps) % otherCount : 0;
  const countForSession = (index: number) => index === options.sessionCount - 1 ? recapLaps : perSession + (index < remainder ? 1 : 0);
  let mineLaps = 0;
  const gameCounts = Array(GAMES.length).fill(0) as number[];
  const gameOrdinals = Array(GAMES.length).fill(0) as number[];
  for (let base = 0; base < options.sessionCount; base += 100) {
    const values: Array<typeof sessions.$inferInsert> = [];
    const resultValues: Array<typeof sessionResults.$inferInsert> = [];
    for (let offset = base; offset < Math.min(options.sessionCount, base + 100); offset++) {
      // "unknown" models unrecognized persisted ownership and must remain excluded from dashboard facts.
      const ownership: "mine" | "others" | "unknown" = offset === options.sessionCount - 1 ? "mine"
        : offset % 11 === 0 ? "others" : offset % 29 === 0 ? "unknown" : "mine";
      const hotIdentity = offset === options.sessionCount - 1;
      const gameIndex = fixtureGameIndex(offset, options.sessionCount, activeUser);
      const gameOrdinal = gameOrdinals[gameIndex]!;
      gameCounts[gameIndex]!++;
      gameOrdinals[gameIndex]!++;
      const trackOrdinal = hotIdentity || offset % 113 === 1 ? 0 : offset % 89 === 0 ? -1 : gameOrdinal % (activeUser ? 6 : 60);
      const carOrdinal = hotIdentity || offset % 109 === 1 ? 0 : offset % 97 === 0 ? -1 : gameOrdinal % (activeUser ? 4 : 220);
      const carId = offset % 19 === 0 || carOrdinal === -1 ? null : offset % 109 === 1 ? "0" : `fixture-car-${carOrdinal}`;
      const trackId = offset % 17 === 0 || trackOrdinal === -1 ? null : offset % 113 === 1 ? "0" : `fixture-track-${trackOrdinal}`;
      const sessionType = ["practice", "qualifying", "race", null][offset % 4];
      values.push({ id: firstId + offset, gameId: GAMES[gameIndex]!, carOrdinal, trackOrdinal, ownership: ownership as "mine" | "others",
        carId, trackId, sessionType, createdAt: sourceTime(offset, options.sessionCount, 0, options.distribution, true, activeUser) });
      const classification = offset % 6 === 3 ? "dnf" : offset % 6 === 5 ? "unknown" : "finished";
      const outcomeStatus = offset % 6 === 4 ? "provisional" : offset % 6 === 5 ? "unavailable" : "confirmed";
      const finishingPosition = classification === "finished" ? offset % 5 + 1 : null;
      resultValues.push({ sessionId: firstId + offset, sessionType: sessionType ?? "unknown", classification, outcomeStatus,
        finishingPosition, qualifyingPosition: offset % 4 === 1 ? offset % 20 + 1 : null,
        isPodium: outcomeStatus === "confirmed" && finishingPosition !== null && finishingPosition <= 3,
        isFastestLap: offset % 7 === 0, pitCount: offset % 5 });
      if (ownership === "mine") mineLaps += countForSession(offset);
    }
    await db.insert(sessions).values(values).run();
    await db.insert(sessionResults).values(resultValues).run();
  }
  for (let sessionIndex = 0; sessionIndex < options.sessionCount; sessionIndex++) {
    const count = countForSession(sessionIndex);
    for (let base = 0; base < count; base += 400) {
      const values: Array<typeof laps.$inferInsert> = [];
      for (let index = base; index < Math.min(count, base + 400); index++) {
        values.push({ sessionId: firstId + sessionIndex, lapNumber: index + 1, lapTime: index % 53 === 0 ? 0 : 80 + random() * 25,
          isValid: index % 13 !== 0, invalidReason: index % 53 === 0 ? "incomplete" : null,
          sectorTimes: index % 17 === 1 ? null : index % 17 === 2 ? [29 + random()] : [29 + random(), 30 + random(), 30 + random()],
          createdAt: sourceTime(sessionIndex, options.sessionCount, index, options.distribution, false, activeUser) });
      }
      await db.insert(laps).values(values).run();
    }
  }
  const identityRows = await client.execute({ sql: `SELECT game_id,COUNT(*) sessions,COUNT(DISTINCT track_id) tracks,COUNT(DISTINCT car_id) cars
    FROM sessions WHERE id>=? GROUP BY game_id`, args: [firstId] });
  const identityCounts = identityRows.rows.map((row) => ({ gameId: String(row.game_id) as GameId, sessions: Number(row.sessions),
    tracks: Number(row.tracks), cars: Number(row.cars) }));
  for (let index = 0; index < GAMES.length; index++) {
    if (gameCounts[index] === 0) continue;
    const actual = identityCounts.find((item) => item.gameId === GAMES[index]);
    const attainable = Math.max(1, Math.floor(gameCounts[index]! / 2));
    if (!actual || actual.sessions !== gameCounts[index] || actual.tracks < Math.min(activeUser ? 6 : 50, attainable) || actual.cars < Math.min(activeUser ? 4 : 200, attainable)) {
      throw new Error(`Dashboard fixture identity cardinality failed for ${GAMES[index]}: ${JSON.stringify(actual)}`);
    }
  }
  if (gameCounts[0]! <= gameCounts[5]!) throw new Error("Dashboard fixture game distribution is not skewed");
  if (options.publish) await drainDashboardFixture();
  const latestRecapSessionId = firstId + options.sessionCount - 1;
  const latestRecapGameId = GAMES[fixtureGameIndex(options.sessionCount - 1, options.sessionCount, activeUser)]!;
  const requestScopes = REQUEST_SCOPES;
  const gameCountsById: Record<GameId, number> = {
    "fm-2023": gameCounts[0]!, "f1-2025": gameCounts[1]!, acc: gameCounts[2]!,
    "ac-evo": gameCounts[3]!, iracing: gameCounts[4]!, lmu: gameCounts[5]!,
  };
  return { options, expected: { laps: options.lapCount, mineLaps, sessions: options.sessionCount, ownershipExcludedLaps: options.lapCount - mineLaps },
    gameCounts: gameCountsById, identityCounts,
    requestScopes, latestRecapSessionId, latestRecapGameId };
}

export async function createDashboardFinalizationFixture(): Promise<DashboardFixtureMetadata> {
  await initDb();
  const existing = await client.execute("SELECT COUNT(*) AS count,COALESCE(MAX(id),0) AS last_id FROM sessions");
  if (Number(existing.rows[0]?.count) !== 0) throw new Error("Dashboard finalization fixture requires an empty isolated database");
  const sessionId = Number(existing.rows[0]?.last_id ?? 0) + 1;
  const gameId: GameId = "fm-2023";
  await db.insert(sessions).values({
    id: sessionId, gameId, carOrdinal: 1, trackOrdinal: 1, ownership: "mine",
    carId: "fixture-finalization-car", trackId: "fixture-finalization-track", sessionType: "race",
    createdAt: "2025-12-31T23:30:00.000Z",
  }).run();
  await db.insert(sessionResults).values({
    sessionId, sessionType: "race", classification: "finished", outcomeStatus: "confirmed",
    finishingPosition: 1, qualifyingPosition: null, isPodium: true, isFastestLap: false, pitCount: 0,
  }).run();
  await db.insert(laps).values([
    { sessionId, lapNumber: 1, lapTime: 90, isValid: true, sectorTimes: [30, 30, 30], createdAt: "2025-12-31T23:31:30.000Z" },
    { sessionId, lapNumber: 2, lapTime: 91, isValid: true, sectorTimes: [30, 30, 31], createdAt: "2025-12-31T23:33:00.000Z" },
  ]).run();
  const candidate = await prepareDashboardPublicationCandidate(sessionId);
  if (!candidate || !await publishDashboardSession(candidate, {
    sourceRevision: candidate.sourceRevision, captureRevision: "fixture-finalization-v1",
    duration: { status: "unavailable", elapsedSeconds: null }, sectorLayout: null,
    weather: { status: "unavailable", revision: null, conditions: null }, trackLengthMeters: null, sourceSectorStarts: null,
  })) throw new Error("Failed to publish dashboard finalization fixture");
  const options: DashboardFixtureOptions = { lapCount: 2, sessionCount: 1, seed: 0, distribution: "standard", publish: true };
  const gameCounts: Record<GameId, number> = {
    "fm-2023": 1, "f1-2025": 0, acc: 0, "ac-evo": 0, iracing: 0, lmu: 0,
  };
  return {
    options, expected: { laps: 2, mineLaps: 2, sessions: 1, ownershipExcludedLaps: 0 },
    requestScopes: REQUEST_SCOPES, latestRecapSessionId: sessionId, latestRecapGameId: gameId,
    gameCounts, identityCounts: [{ gameId, sessions: 1, tracks: 1, cars: 1 }],
  };
}

export async function drainDashboardFixture(): Promise<number> {
  let published = 0, lastSessionId = 0;
  for (;;) {
    const result = await client.execute({ sql: "SELECT st.session_id FROM dashboard_summary_state st WHERE st.session_id>? AND (st.metadata_dirty=1 OR st.capture_dirty=1 OR st.published_revision!=st.source_revision) ORDER BY st.session_id LIMIT 100", args: [lastSessionId] });
    if (!result.rows.length) break;
    for (const row of result.rows) {
      lastSessionId = Number(row.session_id);
      const candidate = await prepareDashboardPublicationCandidate(lastSessionId);
      if (!candidate) continue;
      const fixtureTrack = Number(candidate.session?.track_ordinal) === 0;
      const gameId = String(candidate.session?.game_id ?? "unknown");
      const evidence: DashboardCaptureFacts = { sourceRevision: candidate.sourceRevision, captureRevision: `fixture-source-v1-${candidate.sourceRevision}`,
        duration: { status: "unavailable", elapsedSeconds: null },
        sectorLayout: fixtureTrack ? { status: "available", key: `fixture-source-v1:${gameId}:track-0:three-sector`, sectorCount: 3, starts: FIXTURE_SECTOR_STARTS } : null,
        weather: { status: "unavailable", revision: null, conditions: null }, trackLengthMeters: null,
        sourceSectorStarts: fixtureTrack ? FIXTURE_SECTOR_STARTS : null };
      if (await publishDashboardSession(candidate, evidence)) published++;
    }
  }
  return published;
}

