import { describe, test, expect } from "bun:test";
import { migrations } from "../../../server/db/migrations";
import {
  bootstrap,
  getAppliedVersions,
  newClient,
  runMigrations,
} from "../../support/db/migrations";

describe("migration regressions", () => {
  test("v19 legacy telemetry remains replayable through latest migration", async () => {
    const client = newClient();
    await bootstrap(client);
    await runMigrations(client, 18);

    const legacyTelemetry = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0x52, 0x49, 0x51]);
    await client.execute(
      `INSERT INTO sessions (id, car_ordinal, track_ordinal, game_id)
       VALUES (101, 10, 20, 'fm-2023'),
              (102, 11, 21, 'fm-2023')`,
    );
    await client.execute({
      sql: `INSERT INTO laps (
              id, session_id, lap_number, lap_time, telemetry
            ) VALUES (?, ?, ?, ?, ?)`,
      args: [201, 101, 1, 90.25, legacyTelemetry],
    });

    await runMigrations(client);

    const survivingSessions = await client.execute(
      "SELECT id, raw_file FROM sessions ORDER BY id",
    );
    expect(
      survivingSessions.rows.map((row) => ({
        id: Number(row.id),
        rawFile: row.raw_file,
      })),
    ).toEqual([{ id: 101, rawFile: null }]);

    const retainedLap = await client.execute(
      `SELECT raw_byte_offset, raw_frame_count, legacy_telemetry
       FROM laps WHERE id = 201`,
    );
    expect(retainedLap.rows).toHaveLength(1);
    expect(retainedLap.rows[0].raw_byte_offset).toBeNull();
    expect(retainedLap.rows[0].raw_frame_count).toBeNull();
    expect(new Uint8Array(retainedLap.rows[0].legacy_telemetry as ArrayBuffer)).toEqual(
      legacyTelemetry,
    );

    const sessionColumns = await client.execute("PRAGMA table_info(sessions)");
    const lapColumns = await client.execute("PRAGMA table_info(laps)");
    for (const columns of [sessionColumns, lapColumns]) {
      const names = columns.rows.map((row) => String(row.name));
      expect(names).toEqual(
        expect.arrayContaining([
          "catalog_version",
          "catalog_hash",
          "catalog_schema_version",
          "parser_version",
          "resolver_version",
          "derivation_version",
        ]),
      );
    }
    expect(lapColumns.rows.map((row) => String(row.name))).toContain("legacy_telemetry");
    expect(lapColumns.rows.map((row) => String(row.name))).not.toContain("telemetry");

    client.close();
  });

  test("v51 restores fallback after a partially applied v50 history", async () => {
    // v51 can restore only the missing column. Any row purged by an already
    // applied v35 has no remaining bytes and is intentionally unrecoverable.
    const client = newClient();
    await bootstrap(client);
    await runMigrations(client, 50);
    await client.execute("ALTER TABLE laps DROP COLUMN legacy_telemetry");

    await runMigrations(client);

    const columns = await client.execute("PRAGMA table_info(laps)");
    expect(columns.rows.map((row) => String(row.name))).toContain("legacy_telemetry");
    client.close();
  });

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

  test("v52 excludes persisted pit entry and exit laps from pace metrics", async () => {
    const client = newClient();
    await bootstrap(client);
    await runMigrations(client, 51);
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

  test("v51 repairs legacy v43/v44 collisions without data loss", async () => {
    const client = newClient();
    await bootstrap(client);
    await runMigrations(client, 42);

    const legacyTelemetry = new Uint8Array([0x01, 0x02, 0x03]);
    await client.execute(
      `INSERT INTO sessions (id, car_ordinal, track_ordinal, game_id)
       VALUES (11, 10, 20, 'fm-2023')`,
    );
    await client.execute({
      sql: `INSERT INTO laps (id, session_id, lap_number, lap_time, legacy_telemetry)
            VALUES (?, ?, ?, ?, ?)`,
      args: [101, 11, 1, 112.5, legacyTelemetry],
    });

    const collidedOperations = [
      {
        version: 43,
        name: "runtime-discovered identity registries",
        sql: migrations.find((migration) => migration.version === 45)!.sql,
      },
      {
        version: 44,
        name: "dynamic source-defined sector times",
        sql: migrations.find((migration) => migration.version === 46)!.sql,
      },
    ];
    await client.execute("PRAGMA foreign_keys = OFF");
    try {
      for (const operation of collidedOperations) {
        await client.execute("BEGIN");
        try {
          for (const sql of operation.sql) {
            try {
              await client.execute(sql);
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              if (!message.includes("duplicate column name")) throw error;
            }
          }
          await client.execute({
            sql: "INSERT INTO schema_migrations (version, name) VALUES (?, ?)",
            args: [operation.version, operation.name],
          });
          await client.execute("COMMIT");
        } catch (error) {
          await client.execute("ROLLBACK");
          throw error;
        }
      }
    } finally {
      await client.execute("PRAGMA foreign_keys = ON");
    }

    const preTables = await client.execute(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'driver_profiles'",
    );
    expect(preTables.rows).toHaveLength(0);
    const preSessionColumns = await client.execute("PRAGMA table_info(sessions)");
    expect(preSessionColumns.rows.map((row) => String(row.name))).not.toContain("source");

    const applied = await runMigrations(client);
    expect(applied).toBe(migrations.filter((migration) => migration.version > 44).length);

    const versions = await getAppliedVersions(client);
    expect(versions).toEqual(migrations.map((migration) => migration.version));
    expect(versions.at(-1)).toBe(55);
    expect(versions.filter((version) => version === 53)).toHaveLength(1);
    const collidedLedger = await client.execute(
      "SELECT version, name FROM schema_migrations WHERE version IN (43, 44) ORDER BY version",
    );
    expect(
      collidedLedger.rows.map((row) => ({
        version: Number(row.version),
        name: String(row.name),
      })),
    ).toEqual([
      { version: 43, name: "runtime-discovered identity registries" },
      { version: 44, name: "dynamic source-defined sector times" },
    ]);

    const postTables = await client.execute(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'driver_profiles'",
    );
    expect(postTables.rows).toHaveLength(1);

    const sessionColumns = await client.execute("PRAGMA table_info(sessions)");
    const source = sessionColumns.rows.find((row) => String(row.name) === "source");
    expect(source).toBeDefined();
    expect(Number(source?.notnull ?? 1)).toBe(0);

    const driverProfileIndexes = await client.execute("PRAGMA index_list(driver_profiles)");
    const scopeKeyIndex = driverProfileIndexes.rows.find(
      (row) => String(row.name) === "driver_profiles_scope_key_idx",
    );
    const gameIndex = driverProfileIndexes.rows.find(
      (row) => String(row.name) === "driver_profiles_game_idx",
    );
    expect(Number(scopeKeyIndex?.unique ?? 0)).toBe(1);
    expect(Number(gameIndex?.unique ?? 1)).toBe(0);

    const scopeKeyColumns = await client.execute(
      "PRAGMA index_info(driver_profiles_scope_key_idx)",
    );
    expect(scopeKeyColumns.rows.map((row) => String(row.name))).toEqual(["scope_key"]);
    const gameColumns = await client.execute("PRAGMA index_info(driver_profiles_game_idx)");
    expect(gameColumns.rows.map((row) => String(row.name))).toEqual(["game_id"]);

    const sessions = await client.execute(
      "SELECT id, car_ordinal, track_ordinal, game_id, source FROM sessions ORDER BY id",
    );
    expect(
      sessions.rows.map((row) => ({
        id: Number(row.id),
        carOrdinal: Number(row.car_ordinal),
        trackOrdinal: Number(row.track_ordinal),
        gameId: String(row.game_id),
        source: row.source,
      })),
    ).toEqual([{ id: 11, carOrdinal: 10, trackOrdinal: 20, gameId: "fm-2023", source: null }]);

    const lapRow = await client.execute({
      sql: `SELECT id, session_id, lap_number, lap_time, legacy_telemetry
            FROM laps WHERE id = ?`,
      args: [101],
    });
    expect(lapRow.rows).toHaveLength(1);
    expect({
      id: Number(lapRow.rows[0].id),
      sessionId: Number(lapRow.rows[0].session_id),
      lapNumber: Number(lapRow.rows[0].lap_number),
      lapTime: Number(lapRow.rows[0].lap_time),
    }).toEqual({ id: 101, sessionId: 11, lapNumber: 1, lapTime: 112.5 });
    expect(new Uint8Array(lapRow.rows[0].legacy_telemetry as ArrayBuffer)).toEqual(
      legacyTelemetry,
    );

    client.close();
  });
});
