import { describe, test, expect } from "bun:test";
import {
  bootstrap,
  newClient,
  runMigrations,
} from "@raceiq/backend-core/test-support/db/migrations";

describe("migration regressions", () => {


  test("v45 keeps native car ordinals unique without treating names as identity", async () => {
    const client = newClient();
    await bootstrap(client);
    await runMigrations(client, 42);
    await client.execute(
      `INSERT INTO discovered_cars (game_id, ordinal, name)
       VALUES ('iracing', 101, 'Shared Display Name')`,
    );

    await runMigrations(client, 45);
    await client.execute(
      `INSERT INTO discovered_cars (game_id, ordinal, name)
       VALUES ('iracing', 202, 'Shared Display Name')`,
    );

    const rows = await client.execute(
      `SELECT ordinal, name
       FROM discovered_cars
       WHERE game_id = 'iracing'
       ORDER BY ordinal`,
    );
    expect(
      rows.rows.map((row) => ({
        ordinal: Number(row.ordinal),
        name: String(row.name),
      })),
    ).toEqual([
      { ordinal: 101, name: "Shared Display Name" },
      { ordinal: 202, name: "Shared Display Name" },
    ]);
    await expect(
      client.execute(
        `INSERT INTO discovered_cars (game_id, ordinal, name)
         VALUES ('iracing', 202, 'Different Name')`,
      ),
    ).rejects.toThrow();
    client.close();
  });

  test("v46 preserves valid layouts, rejects incomplete rows, and stales iRacing captures", async () => {
    const client = newClient();
    await bootstrap(client);
    await runMigrations(client, 45);
    await client.execute(
      `INSERT INTO sessions (
         id, car_ordinal, track_ordinal, game_id, raw_file, lap_detector_version
       )
       VALUES (1, 10, 20, 'iracing', 'capture.bin.gz', 'lapdetector_v1'),
              (2, 11, 21, 'f1-2025', 'f1-capture.bin.gz', 'lapdetector_v1')`,
    );
    await client.execute(
      `INSERT INTO laps (session_id, lap_number, lap_time, s1_time, s2_time, s3_time)
       VALUES (1, 1, 60, 30, 30, 0),
              (1, 2, 90, 30, 31, 29),
              (1, 3, 60, 30, NULL, NULL),
              (2, 1, 90, 30, 31, NULL),
              (2, 2, 90, 30, 31, 29)`,
    );

    await runMigrations(client);

    const rows = await client.execute(
      "SELECT sector_times FROM laps ORDER BY session_id, lap_number",
    );
    expect(rows.rows.map((row) => JSON.parse(String(row.sector_times)))).toEqual([
      [30, 30],
      [30, 31, 29],
      null,
      null,
      [30, 31, 29],
    ]);
    const sessionVersions = await client.execute(
      "SELECT id, lap_detector_version FROM sessions ORDER BY id",
    );
    expect(
      sessionVersions.rows.map((row) => ({
        id: Number(row.id),
        version: row.lap_detector_version,
      })),
    ).toEqual([
      { id: 1, version: null },
      { id: 2, version: "lapdetector_v1" },
    ]);
    const columns = await client.execute("PRAGMA table_info(laps)");
    const names = columns.rows.map((row) => String(row.name));
    expect(names).toContain("sector_times");
    expect(names).not.toContain("s1_time");
    expect(names).not.toContain("s2_time");
    expect(names).not.toContain("s3_time");
    client.close();
  });

  test("v51 excludes persisted pit entry and exit laps from pace metrics", async () => {
    const client = newClient();
    await bootstrap(client);
    await runMigrations(client, 50);
    await client.execute("INSERT INTO sessions (id, car_ordinal, track_ordinal, game_id) VALUES (1, 10, 20, 'iracing')");
    await client.execute("INSERT INTO laps (session_id, lap_number, lap_time, is_valid) VALUES (1, 7, 110, 1), (1, 8, 150, 1), (1, 9, 100, 1)");
    await client.execute("INSERT INTO session_results (id, session_id) VALUES (1, 1)");
    await client.execute("INSERT INTO pit_events (result_id, sequence, lap_number, linkage) VALUES (1, 1, 7, 'linked')");

    await runMigrations(client);

    const rows = await client.execute("SELECT lap_number, is_valid, invalid_reason FROM laps ORDER BY lap_number");
    expect(rows.rows.map((row) => ({ lapNumber: Number(row.lap_number), isValid: Number(row.is_valid), invalidReason: row.invalid_reason }))).toEqual([
      { lapNumber: 7, isValid: 0, invalidReason: "inlap" },
      { lapNumber: 8, isValid: 0, invalidReason: "outlap" },
      { lapNumber: 9, isValid: 1, invalidReason: null },
    ]);
    client.close();
  });

  test("v58 normalizes pre-existing null and invalid ownership values", async () => {
    const client = newClient();
    await bootstrap(client);
    await runMigrations(client, 57);
    await client.execute("ALTER TABLE sessions ADD COLUMN ownership TEXT");
    await client.execute(
      "INSERT INTO sessions (id, car_ordinal, track_ordinal, game_id, ownership) VALUES (1, 10, 20, 'iracing', NULL), (2, 10, 20, 'iracing', 'legacy')",
    );
    await runMigrations(client);

    const rows = await client.execute("SELECT id, ownership FROM sessions ORDER BY id");
    expect(rows.rows.map((row) => ({ id: Number(row.id), ownership: row.ownership }))).toEqual([
      { id: 1, ownership: "mine" },
      { id: 2, ownership: "mine" },
    ]);
    client.close();
  });

  test("v58 backfills old sessions", async () => {
    const client = newClient();
    await bootstrap(client);
    await runMigrations(client, 57);
    await client.execute(
      "INSERT INTO sessions (id, car_ordinal, track_ordinal, game_id) VALUES (1, 10, 20, 'iracing')",
    );
    await runMigrations(client);

    const rows = await client.execute("SELECT ownership FROM sessions WHERE id = 1");
    expect(rows.rows[0]?.ownership).toBe("mine");
    client.close();
  });
  test("v58 defaults ownership to mine when omitted", async () => {
    const client = newClient();
    await bootstrap(client);
    await runMigrations(client);
    await client.execute(
      "INSERT INTO sessions (id, car_ordinal, track_ordinal, game_id) VALUES (1, 10, 20, 'iracing')",
    );

    const rows = await client.execute("SELECT ownership FROM sessions WHERE id = 1");
    expect(rows.rows[0]?.ownership).toBe("mine");
    client.close();
  });

  test("v59 preserves legacy session ordinals with null string identity", async () => {
    const client = newClient();
    await bootstrap(client);
    await runMigrations(client, 58);
    await client.execute(
      "INSERT INTO sessions (id, car_ordinal, track_ordinal, game_id) VALUES (1, 12345, 67890, 'lmu')"
    );

    await runMigrations(client);

    const rows = await client.execute(
      `SELECT car_ordinal, track_ordinal, car_id, track_id
       FROM sessions WHERE id = 1`,
    );
    expect(rows.rows[0]).toMatchObject({
      car_ordinal: 12345,
      track_ordinal: 67890,
      car_id: null,
      track_id: null
    });
    client.close();
  });
  test("v60 marks existing static lap analysis stale without dropping cached data", async () => {
    const client = newClient();
    await bootstrap(client);
    await runMigrations(client, 59);
    await client.execute(
      "INSERT INTO sessions (id, car_ordinal, track_ordinal, game_id) VALUES (1, 10, 20, 'iracing')",
    );
    await client.execute(
      "INSERT INTO laps (id, session_id, lap_number, lap_time) VALUES (1, 1, 1, 90)",
    );
    await client.execute(
      "INSERT INTO lap_metrics (lap_id, algo_version, insights, segment_stats) VALUES (1, 3, '[{\"id\":\"legacy\"}]', '[]')",
    );

    await runMigrations(client);

    const rows = await client.execute(
      "SELECT insight_version, insights FROM lap_metrics WHERE lap_id = 1",
    );
    expect(rows.rows[0]).toMatchObject({
      insight_version: 0,
      insights: '[{"id":"legacy"}]',
    });
    client.close();
  });
  test("v63 creates and maintains dashboard projections across direct source writes and cascades", async () => {
    const client = newClient();
    await bootstrap(client);
    await runMigrations(client, 62);
    await client.execute(
      `INSERT INTO sessions (id, game_id, ownership, created_at, car_id, track_id, car_ordinal, track_ordinal)
       VALUES (777, 'iracing', 'mine', '2026-08-01T12:34:56.789Z', 'car-x', 'track-y', 0, 0),
              (778, 'iracing', 'mine', '2026-08-02T12:34:56.789Z', 'car-x', 'track-y', 0, 0)`,
    );
    await client.execute(
      `INSERT INTO laps (id, session_id, lap_number, lap_time, is_valid, created_at)
       VALUES (888, 777, 1, 91.25, 1, '2026-08-01T12:35:00.123Z')`,
    );

    await runMigrations(client, 63);
    const projection = await client.execute(
      "SELECT session_id, created_at_ms, lap_time FROM dashboard_lap_index WHERE lap_id = 888",
    );
    expect(projection.rows).toHaveLength(1);
    expect(projection.rows[0]).toMatchObject({
      session_id: 777,
      created_at_ms: Date.parse("2026-08-01T12:35:00.123Z"),
      lap_time: 91.25,
    });
    await runMigrations(client, 63);
    await runMigrations(client, 63);
    expect((await client.execute("PRAGMA foreign_keys")).rows[0]?.foreign_keys).toBe(1);
    const versions = await client.execute("SELECT version FROM schema_migrations ORDER BY version");
    expect(versions.rows.map((row) => Number(row.version)).filter((version) => version > 62)).toEqual([63]);
    const stateColumns = await client.execute("PRAGMA table_info(dashboard_summary_state)");
    const dayColumns = await client.execute("PRAGMA table_info(dashboard_session_days)");
    expect(stateColumns.rows.map((row) => String(row.name))).toContain("retry_count");
    expect(stateColumns.rows.map((row) => String(row.name))).toContain("last_success_at");
    expect(dayColumns.rows.map((row) => String(row.name))).toContain("favourite_seconds");
    expect(dayColumns.rows.map((row) => String(row.name))).toContain("distance_meters");

    const bucketColumns = await client.execute("PRAGMA table_info(dashboard_session_time_buckets)");
    const summaryColumns = await client.execute("PRAGMA table_info(dashboard_session_summaries)");
    expect(bucketColumns.rows.map((row) => String(row.name))).toContain("valid_seconds");
    expect(summaryColumns.rows.map((row) => String(row.name))).toContain("capture_revision");
    expect(summaryColumns.rows.map((row) => String(row.name))).toContain("podium_position");
    expect(summaryColumns.rows.map((row) => String(row.name))).toContain("track_length_meters");
    expect(summaryColumns.rows.map((row) => String(row.name))).toContain("podium_status");
    const state = async (sessionId: number) => (await client.execute(
      "SELECT source_revision, metadata_dirty, capture_dirty, deleted FROM dashboard_summary_state WHERE session_id = ?",
      [sessionId],
    )).rows[0];
    const initial = await state(777);
    expect(initial).toMatchObject({ source_revision: 1, metadata_dirty: 1 });

    await client.execute("UPDATE sessions SET ownership = 'others' WHERE id = 777");
    expect(await state(777)).toMatchObject({ source_revision: 2, metadata_dirty: 1 });
    await client.execute("UPDATE laps SET lap_time = 91.25 WHERE id = 888");
    expect(await state(777)).toMatchObject({ source_revision: 2, metadata_dirty: 1 });
    await client.execute("UPDATE laps SET session_id = 778, lap_time = 90 WHERE id = 888");
    expect(await state(777)).toMatchObject({ source_revision: 3, metadata_dirty: 1 });
    expect(await state(778)).toMatchObject({ source_revision: 2, metadata_dirty: 1 });
    expect((await client.execute("SELECT session_id, lap_time FROM dashboard_lap_index WHERE lap_id = 888")).rows[0])
      .toMatchObject({ session_id: 778, lap_time: 90 });

    await client.execute(
      `INSERT INTO session_results (id, session_id, outcome_status, classification, finishing_position)
       VALUES (999, 777, 'confirmed', 'finished', 1)`,
    );
    expect(await state(777)).toMatchObject({ source_revision: 4, metadata_dirty: 1 });
    await client.execute("UPDATE session_results SET session_id = 778 WHERE id = 999");
    expect(await state(777)).toMatchObject({ source_revision: 5, metadata_dirty: 1 });
    expect(await state(778)).toMatchObject({ source_revision: 3, metadata_dirty: 1 });
    await client.execute("INSERT INTO pit_events (id, result_id, sequence, duration_seconds) VALUES (1000, 999, 1, 20)");
    expect(await state(778)).toMatchObject({ source_revision: 4, metadata_dirty: 1 });
    await client.execute("UPDATE pit_events SET duration_seconds = 22 WHERE id = 1000");
    expect(await state(778)).toMatchObject({ source_revision: 5, metadata_dirty: 1 });

    await client.execute("DELETE FROM sessions WHERE id = 778");
    expect(await state(778)).toMatchObject({ deleted: 1, metadata_dirty: 1 });
    expect((await client.execute("SELECT COUNT(*) AS count FROM laps WHERE session_id = 778")).rows[0]?.count).toBe(0);
    expect((await client.execute("SELECT COUNT(*) AS count FROM session_results WHERE session_id = 778")).rows[0]?.count).toBe(0);
    expect((await client.execute("SELECT COUNT(*) AS count FROM pit_events WHERE id = 1000")).rows[0]?.count).toBe(0);
    expect((await client.execute("SELECT COUNT(*) AS count FROM dashboard_lap_index WHERE lap_id = 888")).rows[0]?.count).toBe(0);
    await client.close();
  });



});
