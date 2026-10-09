import { describe, expect, test } from "bun:test";
import { migrations } from "@raceiq/backend-core/db/migrations";
import {
  bootstrap,
  newClient,
  runMigrations,
} from "@raceiq/backend-core/test-support/db/migrations";
import type { Client } from "@libsql/client/sqlite3";

const requiredTables = [
  "dashboard_summary_state",
  "dashboard_session_summaries",
  "dashboard_session_days",
  "dashboard_day_entities",
  "dashboard_session_sectors",
  "dashboard_session_time_buckets",
  "dashboard_time_buckets",
  "dashboard_backfill_cursor",
  "dashboard_lap_index",
] as const;

const requiredTriggers = [
  "dashboard_sessions_insert",
  "dashboard_sessions_update",
  "dashboard_sessions_delete",
  "dashboard_laps_insert",
  "dashboard_laps_update",
  "dashboard_laps_delete",
  "dashboard_results_insert",
  "dashboard_results_update",
  "dashboard_results_delete",
  "dashboard_pit_insert",
  "dashboard_pit_update",
  "dashboard_pit_delete",
] as const;

type SqlExecutor = Pick<Client, "execute">;
type Row = Record<string, unknown>;

async function withClient<T>(run: (client: Client) => Promise<T>): Promise<T> {
  const client = newClient();
  try {
    await bootstrap(client);
    return await run(client);
  } finally {
    client.close();
  }
}

async function insertSession(client: SqlExecutor, id: number, ownership = "mine"): Promise<void> {
  await client.execute({
    sql: `INSERT INTO sessions (id, game_id, ownership, created_at, raw_file, car_id, track_id, car_ordinal, track_ordinal)
          VALUES (?, 'iracing', ?, '2026-08-01T12:34:56.789Z', ?, 'car-x', 'track-y', 0, 0)`,
    args: [id, ownership, `capture-${id}.bin.gz`],
  });
}

async function readState(client: SqlExecutor, id: number): Promise<Row | undefined> {
  const result = await client.execute({
    sql: `SELECT session_id, source_revision, published_revision, metadata_dirty, capture_dirty, deleted
          FROM dashboard_summary_state WHERE session_id = ?`,
    args: [id],
  });
  return result.rows[0] as Row | undefined;
}

async function revision(client: SqlExecutor, id: number): Promise<number> {
  const state = await readState(client, id);
  if (!state) throw new Error(`Missing dashboard state for session ${id}`);
  return Number(state.source_revision);
}

async function expectRevisionChange(client: SqlExecutor, id: number, prior: number, delta = 1): Promise<number> {
  const next = await revision(client, id);
  expect(next).toBe(prior + delta);
  expect(await readState(client, id)).toMatchObject({ metadata_dirty: 1 });
  return next;
}

async function assertSchemaAndTriggers(client: SqlExecutor): Promise<void> {
  const objects = await client.execute(
    "SELECT type, name FROM sqlite_master WHERE name LIKE 'dashboard_%' ORDER BY type, name",
  );
  const tables = new Set(objects.rows.filter((row) => row.type === "table").map((row) => String(row.name)));
  const triggers = new Set(objects.rows.filter((row) => row.type === "trigger").map((row) => String(row.name)));
  for (const name of requiredTables) expect(tables.has(name)).toBe(true);
  for (const name of requiredTriggers) expect(triggers.has(name)).toBe(true);

  const buckets = await client.execute("PRAGMA table_info(dashboard_session_time_buckets)");
  const summaries = await client.execute("PRAGMA table_info(dashboard_session_summaries)");
  expect(buckets.rows.map((row) => String(row.name))).toContain("valid_seconds");
  expect(summaries.rows.map((row) => String(row.name))).toContain("podium_position");
}

describe("dashboard embedded migrations", () => {
  test("fresh install creates the required read-model schema and reruns idempotently", async () => {
    await withClient(async (client) => {
      const applied = await runMigrations(client);
      expect(applied).toBe(migrations.length);
      await assertSchemaAndTriggers(client);

      expect(await runMigrations(client)).toBe(0);
      expect(await runMigrations(client)).toBe(0);
      await assertSchemaAndTriggers(client);
      const cursor = await client.execute("SELECT id, last_session_id FROM dashboard_backfill_cursor");
      expect(cursor.rows.map((row) => [Number(row.id), Number(row.last_session_id)])).toEqual([[1, 0]]);
    });
  });

  test("repairs a missing dashboard backfill cursor on an already-migrated database", async () => {
    await withClient(async (client) => {
      const historicalMigrations = migrations.map((migration) => migration.version === 63
        ? {
          ...migration,
          sql: migration.sql.filter((statement) => !statement.includes("dashboard_backfill_cursor")),
        }
        : migration);
      await runMigrations(client, 64, historicalMigrations);

      const missing = await client.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'dashboard_backfill_cursor'",
      );
      expect(missing.rows).toHaveLength(0);

      await runMigrations(client);

      const cursor = await client.execute("SELECT id, last_session_id FROM dashboard_backfill_cursor");
      expect(cursor.rows.map((row) => [Number(row.id), Number(row.last_session_id)])).toEqual([[1, 0]]);
    });
  });

  test("v62 upgrade preserves source rows and timestamps, queues only owned sessions", async () => {
    await withClient(async (client) => {
      await runMigrations(client, 62);
      await insertSession(client, 701, "mine");
      await insertSession(client, 702, "others");
      await client.execute(
        `INSERT INTO laps (id, session_id, lap_number, lap_time, is_valid, created_at, sector_times, notes)
         VALUES (1701, 701, 1, 91.25, 1, '2026-08-01T12:35:00.123Z', '[30.1,31.2,29.95]', 'source lap'),
                (1702, 702, 1, 92.5, 1, '2026-08-02T12:35:00.456Z', '[30.2,31.3,31.0]', 'other lap')`,
      );
      const before = await client.execute(
        `SELECT s.id, s.ownership, s.raw_file, s.created_at AS session_created_at,
                l.id AS lap_id, l.created_at AS lap_created_at, l.lap_time, l.sector_times, l.notes
         FROM sessions s JOIN laps l ON l.session_id = s.id ORDER BY s.id`,
      );

      await runMigrations(client, 63);
      await runMigrations(client);
      const after = await client.execute(
        `SELECT s.id, s.ownership, s.raw_file, s.created_at AS session_created_at,
                l.id AS lap_id, l.created_at AS lap_created_at, l.lap_time, l.sector_times, l.notes
         FROM sessions s JOIN laps l ON l.session_id = s.id ORDER BY s.id`,
      );
      expect(after.rows).toEqual(before.rows);
      await assertSchemaAndTriggers(client);

      expect(await readState(client, 702)).toBeUndefined();
      expect((await client.execute("SELECT session_id FROM dashboard_session_summaries WHERE session_id = 702")).rows).toEqual([]);
      await insertSession(client, 703, "others");
      expect(await readState(client, 703)).toBeUndefined();
      const lapIndex = await client.execute("SELECT session_id, created_at_ms, lap_time FROM dashboard_lap_index ORDER BY lap_id");
      expect(lapIndex.rows.map((row) => ({
        sessionId: Number(row.session_id),
        createdAtMs: Number(row.created_at_ms),
        lapTime: Number(row.lap_time),
      }))).toEqual([
        { sessionId: 701, createdAtMs: Date.parse("2026-08-01T12:35:00.123Z"), lapTime: 91.25 },
        { sessionId: 702, createdAtMs: Date.parse("2026-08-02T12:35:00.456Z"), lapTime: 92.5 },
      ]);
    });
  });

  test("session time projection preserves exact UTC milliseconds across backfill, insert, and update", async () => {
    await withClient(async (client) => {
      await runMigrations(client, 62);
      const utc = "1970-01-01T00:00:00.004Z";
      const offset = "1970-01-01T01:00:00.004+01:00";
      const naive = "1970-01-01T00:00:00.004";
      for (const [id, createdAt] of [[801, utc], [802, offset]] as const) {
        await client.execute({
          sql: `INSERT INTO sessions (id, game_id, ownership, created_at, car_id, track_id, car_ordinal, track_ordinal)
                VALUES (?, 'iracing', 'mine', ?, 'car-x', 'track-y', 0, 0)`,
          args: [id, createdAt],
        });
      }

      await runMigrations(client);
      const backfilled = await client.execute(
        `SELECT s.id, s.created_at, i.created_at_ms FROM sessions s
         JOIN dashboard_session_index i ON i.session_id=s.id WHERE s.id IN (801,802) ORDER BY s.id`,
      );
      expect(backfilled.rows.map((row) => [Number(row.id), String(row.created_at), Number(row.created_at_ms)]))
        .toEqual([[801, utc, 4], [802, offset, 4]]);

      await client.execute({
        sql: `INSERT INTO sessions (id, game_id, ownership, created_at, car_id, track_id, car_ordinal, track_ordinal)
              VALUES (803, 'iracing', 'mine', ?, 'car-x', 'track-y', 0, 0)`,
        args: [naive],
      });
      const inserted = await client.execute(
        "SELECT s.created_at, i.created_at_ms FROM sessions s JOIN dashboard_session_index i ON i.session_id=s.id WHERE s.id=803",
      );
      expect(inserted.rows.map((row) => [String(row.created_at), Number(row.created_at_ms)])).toEqual([[naive, 4]]);

      await client.execute({ sql: "UPDATE sessions SET created_at=? WHERE id=802", args: [naive] });
      const updated = await client.execute(
        "SELECT s.created_at, i.created_at_ms FROM sessions s JOIN dashboard_session_index i ON i.session_id=s.id WHERE s.id=802",
      );
      expect(updated.rows.map((row) => [String(row.created_at), Number(row.created_at_ms)])).toEqual([[naive, 4]]);
    });
  });


  test("direct source SQL invalidates relevant changes and ignores irrelevant edits", async () => {
    await withClient(async (client) => {
      await runMigrations(client);
      await insertSession(client, 711);
      await insertSession(client, 712);
      const sessionA = await revision(client, 711);
      const sessionB = await revision(client, 712);

      await client.execute("UPDATE sessions SET notes = 'unrelated' WHERE id = 711");
      expect(await revision(client, 711)).toBe(sessionA);
      await client.execute("UPDATE sessions SET ownership = 'others' WHERE id = 711");
      let nextA = await expectRevisionChange(client, 711, sessionA);
      await client.execute("UPDATE sessions SET ownership = 'mine' WHERE id = 711");
      nextA = await expectRevisionChange(client, 711, nextA);

      await client.execute(
        `INSERT INTO laps (id, session_id, lap_number, lap_time, is_valid, created_at, sector_times)
         VALUES (1711, 711, 1, 91.25, 1, '2026-08-01T12:35:00.123Z', '[30,31,30]')`,
      );
      nextA = await expectRevisionChange(client, 711, nextA);
      let index = await client.execute("SELECT session_id, lap_time FROM dashboard_lap_index WHERE lap_id = 1711");
      expect(index.rows[0]).toMatchObject({ session_id: 711, lap_time: 91.25 });
      await client.execute("UPDATE laps SET notes = 'unrelated', is_favorite = 1 WHERE id = 1711");
      expect(await revision(client, 711)).toBe(nextA);
      await client.execute("UPDATE laps SET lap_time = 90.5 WHERE id = 1711");
      nextA = await expectRevisionChange(client, 711, nextA);
      await client.execute("UPDATE laps SET session_id = 712 WHERE id = 1711");
      nextA = await expectRevisionChange(client, 711, nextA);
      let nextB = await expectRevisionChange(client, 712, sessionB);
      index = await client.execute("SELECT session_id, lap_time FROM dashboard_lap_index WHERE lap_id = 1711");
      expect(index.rows[0]).toMatchObject({ session_id: 712, lap_time: 90.5 });
      await client.execute("DELETE FROM laps WHERE id = 1711");
      nextB = await expectRevisionChange(client, 712, nextB);
      expect((await client.execute("SELECT lap_id FROM dashboard_lap_index WHERE lap_id = 1711")).rows).toEqual([]);

      await client.execute(
        `INSERT INTO session_results (id, session_id, outcome_status, classification, finishing_position)
         VALUES (1711, 711, 'confirmed', 'finished', 1)`,
      );
      const afterResultInsertA = await expectRevisionChange(client, 711, nextA);
      await client.execute("UPDATE session_results SET qualifying_position = 1 WHERE id = 1711");
      expect(await revision(client, 711)).toBe(afterResultInsertA);
      await client.execute("UPDATE session_results SET finishing_position = 3 WHERE id = 1711");
      const afterFinishUpdateA = await expectRevisionChange(client, 711, afterResultInsertA);
      await client.execute("UPDATE session_results SET session_id = 712 WHERE id = 1711");
      const movedResultA = await expectRevisionChange(client, 711, afterFinishUpdateA);
      nextB = await expectRevisionChange(client, 712, nextB);

      await client.execute(
        "INSERT INTO session_results (id, session_id, outcome_status, classification, finishing_position) VALUES (1712, 711, 'confirmed', 'finished', 2)",
      );
      const afterSecondResultA = await expectRevisionChange(client, 711, movedResultA);
      await client.execute("INSERT INTO pit_events (id, result_id, sequence, duration_seconds) VALUES (1711, 1711, 1, 20)");
      nextB = await expectRevisionChange(client, 712, nextB);
      await client.execute("UPDATE pit_events SET result_id = 1712 WHERE id = 1711");
      nextB = await expectRevisionChange(client, 712, nextB);
      nextA = await expectRevisionChange(client, 711, afterSecondResultA);
      await client.execute("UPDATE pit_events SET duration_seconds = 22 WHERE id = 1711");
      nextA = await expectRevisionChange(client, 711, nextA);
      await client.execute("DELETE FROM pit_events WHERE id = 1711");
      nextA = await expectRevisionChange(client, 711, nextA);

      await client.execute("DELETE FROM session_results WHERE id = 1711");
      nextB = await expectRevisionChange(client, 712, nextB);
      await client.execute("DELETE FROM session_results WHERE id = 1712");
      await expectRevisionChange(client, 711, nextA);
    });
  });

  test("source, projection and dirty-state trigger writes roll back together", async () => {
    await withClient(async (client) => {
      await runMigrations(client);
      await insertSession(client, 721);
      await insertSession(client, 722);
      await client.execute(
        `INSERT INTO laps (id, session_id, lap_number, lap_time, is_valid, created_at, sector_times)
         VALUES (1721, 721, 1, 90, 1, '2026-08-01T12:35:00.123Z', '[30,30,30]')`,
      );
      await client.execute("INSERT INTO session_results (id, session_id, outcome_status, classification, finishing_position) VALUES (1721, 721, 'confirmed', 'finished', 1)");
      await client.execute("INSERT INTO pit_events (id, result_id, sequence, duration_seconds) VALUES (1721, 1721, 1, 20)");

      const beforeStateA = await readState(client, 721);
      const beforeStateB = await readState(client, 722);
      const beforeSources = await client.execute(
        `SELECT s.id, s.ownership, l.id AS lap_id, l.session_id AS lap_session_id,
                l.lap_time, r.id AS result_id, r.session_id AS result_session_id,
                p.id AS pit_id, p.duration_seconds
         FROM sessions s LEFT JOIN laps l ON l.session_id = s.id
         LEFT JOIN session_results r ON r.session_id = s.id
         LEFT JOIN pit_events p ON p.result_id = r.id WHERE s.id IN (721, 722) ORDER BY s.id`,
      );
      const beforeIndex = await client.execute("SELECT lap_id, session_id, lap_time FROM dashboard_lap_index WHERE lap_id = 1721");

      const tx = await client.transaction("write");
      await tx.execute("UPDATE sessions SET ownership = 'others' WHERE id = 721");
      await tx.execute("UPDATE laps SET session_id = 722, lap_time = 88 WHERE id = 1721");
      await tx.execute("UPDATE session_results SET session_id = 722, finishing_position = 2 WHERE id = 1721");
      await tx.execute("UPDATE pit_events SET duration_seconds = 25 WHERE id = 1721");
      expect(await tx.execute("SELECT session_id, lap_time FROM dashboard_lap_index WHERE lap_id = 1721")).toMatchObject({
        rows: [expect.objectContaining({ session_id: 722, lap_time: 88 })],
      });
      expect(Number((await tx.execute("SELECT source_revision FROM dashboard_summary_state WHERE session_id = 721")).rows[0]?.source_revision))
        .toBeGreaterThan(Number(beforeStateA?.source_revision));
      await tx.rollback();

      expect(await readState(client, 721)).toEqual(beforeStateA);
      expect(await readState(client, 722)).toEqual(beforeStateB);
      expect((await client.execute(
        `SELECT s.id, s.ownership, l.id AS lap_id, l.session_id AS lap_session_id,
                l.lap_time, r.id AS result_id, r.session_id AS result_session_id,
                p.id AS pit_id, p.duration_seconds
         FROM sessions s LEFT JOIN laps l ON l.session_id = s.id
         LEFT JOIN session_results r ON r.session_id = s.id
         LEFT JOIN pit_events p ON p.result_id = r.id WHERE s.id IN (721, 722) ORDER BY s.id`,
      )).rows).toEqual(beforeSources.rows);
      expect((await client.execute("SELECT lap_id, session_id, lap_time FROM dashboard_lap_index WHERE lap_id = 1721")).rows)
        .toEqual(beforeIndex.rows);
    });
  });

  test("session cascades leave a tombstone and prior per-session contributions for reconciliation", async () => {
    await withClient(async (client) => {
      await runMigrations(client);
      await insertSession(client, 731);
      await client.execute(
        `INSERT INTO laps (id, session_id, lap_number, lap_time, is_valid, created_at, sector_times)
         VALUES (1731, 731, 1, 89, 1, '2026-08-01T12:35:00.123Z', '[29,30,30]')`,
      );
      await client.execute("INSERT INTO session_results (id, session_id, outcome_status, classification, finishing_position) VALUES (1731, 731, 'confirmed', 'finished', 1)");
      await client.execute("INSERT INTO pit_events (id, result_id, sequence, duration_seconds) VALUES (1731, 1731, 1, 18)");
      const state = await readState(client, 731);
      const sourceRevision = Number(state?.source_revision);
      await client.execute(
        `INSERT INTO dashboard_session_summaries
           (session_id, source_revision, processor_version, game_id, created_at_ms,
            lap_count, positive_laps, valid_laps, driven_seconds, valid_seconds, best_lap_seconds)
         VALUES (731, ?, 1, 'iracing', 1785587696789, 1, 1, 1, 89, 89, 89)`,
        [sourceRevision],
      );
      await client.execute(
        "UPDATE dashboard_summary_state SET published_revision = source_revision, metadata_dirty = 0 WHERE session_id = 731",
      );
      await client.execute(
        `INSERT INTO dashboard_session_days
           (session_id, utc_day, game_id, lap_count, positive_laps, valid_laps, driven_seconds, valid_seconds)
         VALUES (731, '2026-08-01', 'iracing', 1, 1, 1, 89, 89)`,
      );
      await client.execute(
        `INSERT INTO dashboard_session_sectors (session_id, layout_key, sector_index, best_seconds)
         VALUES (731, 'layout-v1', 0, 29)`,
      );
      await client.execute(
        `INSERT INTO dashboard_session_time_buckets
           (session_id, bucket_start_ms, game_id, valid_laps, positive_laps, driven_seconds)
         VALUES (731, 1785587400000, 'iracing', 1, 1, 89)`,
      );
      await client.execute(
        `INSERT INTO dashboard_day_entities
           (utc_day, game_id, car_key, track_key, lap_count, positive_laps, valid_laps,
            driven_seconds, valid_seconds, favourite_laps, favourite_seconds, distance_laps,
            distance_meters, podium_first, podium_second, podium_third)
         VALUES ('2026-08-01', 'iracing', 'car:1', 'track:1', 1, 1, 1, 89, 89, 0, 0, 0, 0, 0, 0, 0)`,
      );
      await client.execute(
        `INSERT INTO dashboard_time_buckets
           (bucket_start_ms, game_id, valid_laps, positive_laps, driven_seconds, valid_seconds,
            podium_first, podium_second, podium_third)
         VALUES (1785587400000, 'iracing', 1, 1, 89, 89, 0, 0, 0)`,
      );

      const publishedRows = [
        ["dashboard_session_days", "session_id = 731"],
        ["dashboard_session_sectors", "session_id = 731"],
        ["dashboard_session_time_buckets", "session_id = 731"],
        ["dashboard_day_entities", "utc_day = '2026-08-01' AND game_id = 'iracing'"],
        ["dashboard_time_buckets", "bucket_start_ms = 1785587400000 AND game_id = 'iracing'"],
      ] as const;

      await client.execute("DELETE FROM sessions WHERE id = 731");
      expect(await readState(client, 731)).toMatchObject({ deleted: 1, metadata_dirty: 1 });
      expect(Number((await readState(client, 731))?.source_revision)).toBeGreaterThan(sourceRevision);
      for (const query of [
        "SELECT id FROM laps WHERE session_id = 731",
        "SELECT id FROM session_results WHERE session_id = 731",
        "SELECT id FROM pit_events WHERE id = 1731",
        "SELECT lap_id FROM dashboard_lap_index WHERE lap_id = 1731",
      ]) {
        expect((await client.execute(query)).rows).toEqual([]);
      }
      expect((await client.execute("SELECT session_id FROM dashboard_session_summaries WHERE session_id = 731")).rows
        .map((row) => Number(row.session_id))).toEqual([731]);
      for (const [table, condition] of publishedRows) {
        expect(Number((await client.execute(`SELECT COUNT(*) AS count FROM ${table} WHERE ${condition}`)).rows[0]?.count))
          .toBe(1);
      }

    });
  });
});
