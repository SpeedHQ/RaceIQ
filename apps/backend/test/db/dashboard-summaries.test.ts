import { afterEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { prepareDashboardPublicationCandidate, publishDashboardSession } from "@raceiq/backend-core/db/dashboard-summary-queries";
import { client, db } from "@raceiq/backend-core/db/index";
import { laps, sessions } from "@raceiq/backend-core/db/schema";
import { deleteSession } from "@raceiq/backend-core/db/session-queries";

const ids: number[] = [];

afterEach(async () => {
  for (const id of ids.splice(0)) {
    await deleteSession(id);
    const tombstone = await prepareDashboardPublicationCandidate(id);
    if (tombstone) await publishDashboardSession(tombstone);
  }
});

async function seedSession(createdAt = "2026-06-01T12:00:00.000Z") {
  const row = await db.insert(sessions).values({
    gameId: "acc", carId: "7", trackId: "8", carOrdinal: 7, trackOrdinal: 8,
    ownership: "mine", createdAt, sessionType: "race",
  }).returning({ id: sessions.id }).get();
  ids.push(row.id);
  return row.id;
}

async function read(sql: string, args: unknown[] = []) {
  const result = await client.execute({ sql, args: args as never[] });
  return result.rows;
}

async function publish(sessionId: number, facts?: {
  captureRevision: string;
  elapsedSeconds: number | null;
  sectorLayout: { key: string; sectorCount: number; starts: readonly number[] } | null;
  weatherRevision: string | null;
}) {
  const candidate = await prepareDashboardPublicationCandidate(sessionId);
  if (!candidate) return false;
  const evidence = facts ? {
    sourceRevision: candidate.sourceRevision,
    captureRevision: facts.captureRevision,
    duration: { status: facts.elapsedSeconds === null ? "unavailable" as const : "available" as const, elapsedSeconds: facts.elapsedSeconds },
    sectorLayout: facts.sectorLayout ? { status: "available" as const, ...facts.sectorLayout } : null,
    weather: {
      status: facts.weatherRevision === null ? "unavailable" as const : "available" as const,
      revision: facts.weatherRevision,
      conditions: facts.weatherRevision === null ? null : {
        frames: 1, airTempC: null, roadTempC: null, rainIntensity: 0, wet: false,
        trackGripStatus: "unknown", windSpeedKmh: 0, windDirectionDeg: 0, startingGrip: null, staticWeather: null,
      },
    },
    trackLengthMeters: null,
    sourceSectorStarts: facts.sectorLayout?.starts ?? null,
  } : undefined;
  return publishDashboardSession(candidate, evidence);
}

test("dashboard publication reduces sectors only with explicit layout evidence", async () => {
  const sessionId = await seedSession();
  await db.insert(laps).values([
    { sessionId, lapNumber: 1, lapTime: 91, isValid: true, sectorTimes: [30, 30, 31], createdAt: "2026-06-01T12:00:00.000Z" },
    { sessionId, lapNumber: 2, lapTime: 90, isValid: true, sectorTimes: [29, 29, 31], createdAt: "2026-06-01T12:15:00.000Z" },
    { sessionId, lapNumber: 3, lapTime: 92, isValid: false, createdAt: "2026-06-02T12:00:00.000Z" },
  ]).run();
  const evidence = {
    captureRevision: "capture-v1",
    elapsedSeconds: 3600,
    sectorLayout: { key: "track-8/layout-v1", sectorCount: 3, starts: [0, 1 / 3, 2 / 3] },
    weatherRevision: "weather-v1",
  } as const;

  expect(await publish(sessionId)).toBe(true);
  expect((await read("SELECT sector_layout_key, sector_count, elapsed_seconds FROM dashboard_session_summaries WHERE session_id = ?", [sessionId]))[0])
    .toMatchObject({ sector_layout_key: null, sector_count: null, elapsed_seconds: null });
  expect(Number((await read("SELECT COUNT(*) AS count FROM dashboard_session_sectors WHERE session_id = ?", [sessionId]))[0]?.count)).toBe(0);

  expect(await publish(sessionId, evidence)).toBe(true);
  let sectors = await read("SELECT layout_key, sector_index, best_seconds FROM dashboard_session_sectors WHERE session_id = ? ORDER BY sector_index", [sessionId]);
  expect(sectors.map((row) => [row.layout_key, Number(row.sector_index), Number(row.best_seconds)])).toEqual([
    ["track-8/layout-v1", 0, 29], ["track-8/layout-v1", 1, 29], ["track-8/layout-v1", 2, 31],
  ]);

  await db.update(sessions).set({ sessionType: "qualifying" }).where(eq(sessions.id, sessionId)).run();
  expect(await publish(sessionId, evidence)).toBe(true);
  let summary = await read("SELECT lap_count, positive_laps, valid_laps, driven_seconds, valid_seconds, best_lap_seconds, elapsed_seconds, sector_layout_key, capture_revision, weather_revision FROM dashboard_session_summaries WHERE session_id = ?", [sessionId]);
  expect(summary[0]).toMatchObject({
    lap_count: 3, positive_laps: 3, valid_laps: 2, driven_seconds: 273, valid_seconds: 181,
    best_lap_seconds: 90, elapsed_seconds: 3600, sector_layout_key: "track-8/layout-v1",
    capture_revision: "capture-v1", weather_revision: "weather-v1",
  });
  sectors = await read("SELECT sector_index, best_seconds FROM dashboard_session_sectors WHERE session_id = ? ORDER BY sector_index", [sessionId]);
  expect(sectors.map((row) => Number(row.best_seconds))).toEqual([29, 29, 31]);

  await client.execute({ sql: "UPDATE laps SET is_valid = 0 WHERE session_id = ? AND lap_number = 2", args: [sessionId] });
  expect(await publish(sessionId, evidence)).toBe(true);
  sectors = await read("SELECT sector_index, best_seconds FROM dashboard_session_sectors WHERE session_id = ? ORDER BY sector_index", [sessionId]);
  expect(sectors.map((row) => [Number(row.sector_index), Number(row.best_seconds)])).toEqual([[0, 30], [1, 30], [2, 31]]);
  summary = await read("SELECT valid_laps, elapsed_seconds FROM dashboard_session_summaries WHERE session_id = ?", [sessionId]);
  expect(summary[0]).toMatchObject({ valid_laps: 1, elapsed_seconds: 3600 });
});

test("equal sector counts with different authoritative layout keys do not match", async () => {
  const first = await seedSession();
  const second = await seedSession();
  await db.insert(laps).values([
    { sessionId: first, lapNumber: 1, lapTime: 90, isValid: true, sectorTimes: [30, 30, 30] },
    { sessionId: second, lapNumber: 1, lapTime: 91, isValid: true, sectorTimes: [29, 31, 31] },
  ]).run();
  const facts = (key: string) => ({
    captureRevision: "capture-v1", elapsedSeconds: null,
    sectorLayout: { key, sectorCount: 3, starts: [0, 1 / 3, 2 / 3] }, weatherRevision: null,
  });
  expect(await publish(first, facts("track-8/layout-a"))).toBe(true);
  expect(await publish(second, facts("track-8/layout-b"))).toBe(true);
  const matches = await read(
    `SELECT COUNT(*) AS count FROM dashboard_session_sectors a JOIN dashboard_session_sectors b
       ON a.layout_key = b.layout_key AND a.sector_index = b.sector_index
       WHERE a.session_id = ? AND b.session_id = ?`,
    [first, second],
  );
  expect(Number(matches[0]?.count)).toBe(0);
});

test("podium contribution requires confirmed finished race result with positive position", async () => {
  const sessionId = await seedSession();
  await db.insert(laps).values({
    sessionId, lapNumber: 1, lapTime: 90, isValid: true, createdAt: "2026-06-01T12:00:00.000Z",
  }).run();
  await client.execute({
    sql: `INSERT INTO session_results(session_id, outcome_status, classification, finishing_position)
          VALUES (?, 'confirmed', 'finished', 2)`,
    args: [sessionId],
  });
  expect(await publish(sessionId)).toBe(true);
  let podium = await read("SELECT podium_position FROM dashboard_session_summaries WHERE session_id = ?", [sessionId]);
  expect(Number(podium[0]?.podium_position)).toBe(2);
  expect(Number((await read("SELECT SUM(podium_second) AS count FROM dashboard_session_days WHERE session_id = ?", [sessionId]))[0]?.count)).toBe(1);
  expect(Number((await read("SELECT SUM(podium_second) AS count FROM dashboard_session_time_buckets WHERE session_id = ?", [sessionId]))[0]?.count)).toBe(1);

  await db.update(sessions).set({ sessionType: "practice" }).where(eq(sessions.id, sessionId)).run();
  expect(await publish(sessionId)).toBe(true);
  podium = await read("SELECT podium_position FROM dashboard_session_summaries WHERE session_id = ?", [sessionId]);
  expect(Number(podium[0]?.podium_position)).toBe(0);

  await db.update(sessions).set({ sessionType: "race" }).where(eq(sessions.id, sessionId)).run();
  await client.execute({ sql: "UPDATE session_results SET classification = 'dnf' WHERE session_id = ?", args: [sessionId] });
  expect(await publish(sessionId)).toBe(true);
  podium = await read("SELECT podium_position FROM dashboard_session_summaries WHERE session_id = ?", [sessionId]);
  expect(Number(podium[0]?.podium_position)).toBe(0);
});

test("republication replaces prior contributions and repeated publication is stable", async () => {
  const sessionId = await seedSession();
  await db.insert(laps).values([
    { sessionId, lapNumber: 1, lapTime: 90, isValid: true, createdAt: "2099-01-02T12:00:00.000Z" },
    { sessionId, lapNumber: 2, lapTime: 91, isValid: true, createdAt: "2099-01-02T12:15:00.000Z" },
  ]).run();
  const facts = {
    captureRevision: "capture-v1",
    elapsedSeconds: 1800,
    sectorLayout: null,
    weatherRevision: "weather-v1",
  } as const;

  expect(await publish(sessionId, facts)).toBe(true);
  const first = await read(
    "SELECT source_revision, lap_count, valid_laps, valid_seconds, elapsed_seconds FROM dashboard_session_summaries WHERE session_id = ?",
    [sessionId],
  );
  expect(first[0]).toMatchObject({ lap_count: 2, valid_laps: 2, valid_seconds: 181, elapsed_seconds: 1800 });

  expect(await publish(sessionId, facts)).toBe(true);
  const repeated = await read(
    "SELECT source_revision, lap_count, valid_laps, valid_seconds, elapsed_seconds FROM dashboard_session_summaries WHERE session_id = ?",
    [sessionId],
  );
  expect(repeated[0]).toEqual(first[0]);

  await client.execute({ sql: "UPDATE laps SET lap_time = 80 WHERE session_id = ? AND lap_number = 2", args: [sessionId] });
  expect(await publish(sessionId, { ...facts, captureRevision: "capture-v2" })).toBe(true);
  const replaced = await read(
    "SELECT lap_count, valid_laps, valid_seconds, elapsed_seconds, capture_revision FROM dashboard_session_summaries WHERE session_id = ?",
    [sessionId],
  );
  expect(replaced[0]).toMatchObject({ lap_count: 2, valid_laps: 2, valid_seconds: 170, elapsed_seconds: 1800, capture_revision: "capture-v2" });
  const total = await read(
    "SELECT SUM(valid_laps) AS valid_laps, SUM(valid_seconds) AS valid_seconds FROM dashboard_session_days WHERE session_id = ?",
    [sessionId],
  );
  expect(total[0]).toMatchObject({ valid_laps: 2, valid_seconds: 170 });
  const globalEntities = await read(
    "SELECT SUM(lap_count) AS lap_count, SUM(valid_laps) AS valid_laps, SUM(valid_seconds) AS valid_seconds FROM dashboard_day_entities WHERE utc_day = '2099-01-02' AND game_id = 'acc'",
  );
  expect(globalEntities[0]).toMatchObject({ lap_count: 2, valid_laps: 2, valid_seconds: 170 });
  const dayStart = Date.parse("2099-01-02T00:00:00.000Z");
  const globalBuckets = await read(
    "SELECT SUM(valid_laps) AS valid_laps, SUM(valid_seconds) AS valid_seconds FROM dashboard_time_buckets WHERE bucket_start_ms >= ? AND bucket_start_ms < ? AND game_id = 'acc'",
    [dayStart, dayStart + 24 * 60 * 60 * 1000],
  );
  expect(globalBuckets[0]).toMatchObject({ valid_laps: 2, valid_seconds: 170 });
});

test("session deletion retains contributions until tombstone publication subtracts them", async () => {
  const sessionId = await seedSession();
  await db.insert(laps).values([
    { sessionId, lapNumber: 1, lapTime: 90, isValid: true, createdAt: "2099-01-03T12:00:00.000Z" },
  ]).run();
  expect(await publish(sessionId)).toBe(true);
  await deleteSession(sessionId);
  ids.splice(ids.indexOf(sessionId), 1);

  const retained = await read(
    `SELECT
       (SELECT COUNT(*) FROM dashboard_session_summaries WHERE session_id = ?) AS summaries,
       (SELECT COUNT(*) FROM dashboard_session_days WHERE session_id = ?) AS days,
       (SELECT COUNT(*) FROM dashboard_session_time_buckets WHERE session_id = ?) AS buckets,
       (SELECT SUM(valid_laps) FROM dashboard_day_entities WHERE utc_day = '2099-01-03' AND game_id = 'acc') AS global_laps,
       (SELECT SUM(valid_laps) FROM dashboard_time_buckets WHERE bucket_start_ms >= ? AND bucket_start_ms < ? AND game_id = 'acc') AS global_bucket_laps`,
    [sessionId, sessionId, sessionId, Date.parse("2099-01-03T12:00:00.000Z"), Date.parse("2099-01-03T12:15:00.000Z")],
  );
  expect(retained[0]).toMatchObject({ summaries: 1, days: 1, buckets: 1, global_laps: 1, global_bucket_laps: 1 });
  expect((await read("SELECT SUM(lap_count) AS laps FROM dashboard_month_entities WHERE utc_month='2099-01' AND game_id='acc'"))[0]?.laps).toBe(1);

  const tombstone = await prepareDashboardPublicationCandidate(sessionId);
  expect(tombstone).toMatchObject({ deleted: true, session: null });
  expect(await publishDashboardSession(tombstone!)).toBe(true);
  const removed = await read(
    `SELECT
       (SELECT COUNT(*) FROM dashboard_session_summaries WHERE session_id = ?) AS summaries,
       (SELECT COUNT(*) FROM dashboard_session_days WHERE session_id = ?) AS days,
       (SELECT COUNT(*) FROM dashboard_session_time_buckets WHERE session_id = ?) AS buckets,
       COALESCE((SELECT SUM(valid_laps) FROM dashboard_day_entities WHERE utc_day = '2099-01-03' AND game_id = 'acc'), 0) AS global_laps,
       COALESCE((SELECT SUM(valid_laps) FROM dashboard_time_buckets WHERE bucket_start_ms >= ? AND bucket_start_ms < ? AND game_id = 'acc'), 0) AS global_bucket_laps`,
    [sessionId, sessionId, sessionId, Date.parse("2099-01-03T12:00:00.000Z"), Date.parse("2099-01-03T12:15:00.000Z")],
  );
  expect(removed[0]).toMatchObject({ summaries: 0, days: 0, buckets: 0, global_laps: 0, global_bucket_laps: 0 });
  expect((await read("SELECT COUNT(*) AS count FROM dashboard_month_entities WHERE utc_month='2099-01' AND game_id='acc'")).map((row) => Number(row.count))).toEqual([0]);
});

test("monthly entity publication subtracts dirty revisions and removes ownership transitions", async () => {
  const sessionId = await seedSession("2098-02-01T12:00:00.000Z");
  await db.insert(laps).values([
    { sessionId, lapNumber: 1, lapTime: 90, isValid: true, createdAt: "2098-02-01T12:01:00.000Z" },
    { sessionId, lapNumber: 2, lapTime: 91, isValid: true, createdAt: "2098-02-02T12:01:00.000Z" },
    { sessionId, lapNumber: 3, lapTime: 92, isValid: true, createdAt: "2098-02-28T12:01:00.000Z" },
  ]).run();
  const monthly = async () => read(`SELECT COALESCE(SUM(lap_count),0) AS laps,
    COALESCE(SUM(valid_laps),0) AS valid_laps,COALESCE(SUM(valid_seconds),0) AS seconds,
    COALESCE(SUM(podium_first+podium_second+podium_third),0) AS podiums
    FROM dashboard_month_entities WHERE utc_month='2098-02' AND game_id='acc'`);

  expect(await publish(sessionId)).toBe(true);
  const moments = async () => read("SELECT valid_mean_seconds,valid_m2_seconds FROM dashboard_month_entities WHERE utc_month='2098-02' AND game_id='acc'");
  expect((await monthly())[0]).toMatchObject({ laps: 3, valid_laps: 3, seconds: 273, podiums: 0 });
  expect((await moments())[0]).toMatchObject({ valid_mean_seconds: 91, valid_m2_seconds: 2 });

  await client.execute({ sql: "UPDATE laps SET lap_time=80 WHERE session_id=? AND lap_number=2", args: [sessionId] });
  expect((await read("SELECT metadata_dirty FROM dashboard_summary_state WHERE session_id=?", [sessionId]))[0]?.metadata_dirty).toBe(1);
  expect((await monthly())[0]).toMatchObject({ laps: 3, valid_laps: 3, seconds: 273 });
  expect(await publish(sessionId)).toBe(true);
  const corrected = (await monthly())[0];
  expect(corrected).toMatchObject({ laps: 3, valid_laps: 3, seconds: 262 });
  expect(Math.abs(Number((await moments())[0]?.valid_mean_seconds) - (262 / 3))).toBeLessThan(1e-6);
  expect(Math.abs(Number((await moments())[0]?.valid_m2_seconds) - (80 + 24 / 9))).toBeLessThan(1e-6);
  expect(await publish(sessionId)).toBe(true);
  expect((await monthly())[0]).toEqual(corrected);

  await db.update(sessions).set({ ownership: "others" }).where(eq(sessions.id, sessionId)).run();
  expect(await publish(sessionId)).toBe(true);
  expect((await monthly())[0]).toMatchObject({ laps: 0, valid_laps: 0, seconds: 0, podiums: 0 });
  expect((await read("SELECT COUNT(*) AS count FROM dashboard_month_entities WHERE utc_month='2098-02' AND game_id='acc'")).map((row) => Number(row.count))).toEqual([0]);
  expect(await moments()).toHaveLength(0);
});

test("monthly publication moves time and identity contributions without stale entity leakage", async () => {
  const sessionId = await seedSession("2097-01-15T12:00:00.000Z");
  await db.insert(laps).values({ sessionId, lapNumber: 1, lapTime: 90, isValid: true, createdAt: "2097-01-15T12:01:00.000Z" }).run();
  expect(await publish(sessionId)).toBe(true);
  const prior = await read("SELECT car_key,track_key,lap_count FROM dashboard_month_entities WHERE utc_month='2097-01' AND game_id='acc'");
  expect(prior).toHaveLength(1);
  expect(prior[0]?.lap_count).toBe(1);

  await client.execute({ sql: "UPDATE laps SET created_at='2097-02-02T12:01:00.000Z' WHERE session_id=?", args: [sessionId] });
  await db.update(sessions).set({ carId: "9", trackId: "10", carOrdinal: 9, trackOrdinal: 10 }).where(eq(sessions.id, sessionId)).run();
  expect(await publish(sessionId)).toBe(true);
  expect((await read("SELECT lap_count FROM dashboard_month_entities WHERE utc_month='2097-01' AND game_id='acc'")).map((row) => Number(row.lap_count))).toEqual([]);
  const moved = await read("SELECT car_key,track_key,lap_count,valid_seconds FROM dashboard_month_entities WHERE utc_month='2097-02' AND game_id='acc'");
  expect(moved).toHaveLength(1);
  expect(moved[0]).toMatchObject({ lap_count: 1, valid_seconds: 90 });
  expect(moved[0]?.car_key).not.toBe(prior[0]?.car_key);
  expect(moved[0]?.track_key).not.toBe(prior[0]?.track_key);
});

test("dashboard trigger revisions and lap projections roll back with source writes", async () => {
  const sessionId = await seedSession();
  await db.insert(laps).values({ sessionId, lapNumber: 1, lapTime: 90, isValid: true }).run();
  const before = await read("SELECT source_revision FROM dashboard_summary_state WHERE session_id = ?", [sessionId]);
  const beforeRevision = Number(before[0]?.source_revision);
  const tx = await client.transaction("write");
  try {
    await tx.execute({ sql: "UPDATE laps SET lap_time = 80 WHERE session_id = ?", args: [sessionId] });
    await tx.rollback();
  } catch (error) {
    await tx.rollback();
    throw error;
  }
  const after = await read("SELECT source_revision FROM dashboard_summary_state WHERE session_id = ?", [sessionId]);
  expect(Number(after[0]?.source_revision)).toBe(beforeRevision);
  const projected = await read("SELECT lap_time FROM dashboard_lap_index WHERE session_id = ?", [sessionId]);
  expect(projected.map((row) => Number(row.lap_time))).toEqual([90]);

  await publish(sessionId);
  await db.update(sessions).set({ ownership: "others" }).where(eq(sessions.id, sessionId)).run();
  expect(await publish(sessionId)).toBe(true);
  expect((await read("SELECT COUNT(*) AS count FROM dashboard_session_summaries WHERE session_id = ?", [sessionId])).map((row) => Number(row.count))).toEqual([0]);
  expect((await read("SELECT metadata_dirty FROM dashboard_summary_state WHERE session_id = ?", [sessionId])).map((row) => Number(row.metadata_dirty))).toEqual([0]);
});
