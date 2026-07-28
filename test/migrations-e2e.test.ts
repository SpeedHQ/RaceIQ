import { describe, test, expect } from "bun:test";
import { createClient, type Client } from "@libsql/client/sqlite3";
import { migrations } from "../server/db/migrations";

/**
 * E2E migration runner test. Mirrors the logic in server/db/index.ts so a
 * fresh install (and a partially-migrated install) can advance to the latest
 * schema without errors.
 */

async function bootstrap(client: Client) {
  await client.execute("PRAGMA foreign_keys = ON");
  await client.execute(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}

async function runMigrations(client: Client, throughVersion = Number.POSITIVE_INFINITY) {
  const appliedRows = await client.execute("SELECT version FROM schema_migrations");
  const applied = new Set(appliedRows.rows.map((r) => Number(r.version)));
  const pending = migrations
    .filter((m) => !applied.has(m.version) && m.version <= throughVersion)
    .sort((a, b) => a.version - b.version);

  if (pending.length === 0) return 0;

  await client.execute("PRAGMA foreign_keys = OFF");
  try {
    for (const migration of pending) {
      await client.execute("BEGIN");
      try {
        for (const sql of migration.sql) {
          try {
            await client.execute(sql);
          } catch (stmtErr: unknown) {
            const msg = stmtErr instanceof Error ? stmtErr.message : String(stmtErr);
            if (!msg.includes("duplicate column name")) throw stmtErr;
          }
        }
        await client.execute({
          sql: "INSERT INTO schema_migrations (version, name) VALUES (?, ?)",
          args: [migration.version, migration.name],
        });
        await client.execute("COMMIT");
      } catch (err) {
        await client.execute("ROLLBACK");
        throw err;
      }
    }
  } finally {
    await client.execute("PRAGMA foreign_keys = ON");
  }
  return pending.length;
}

async function getAppliedVersions(client: Client): Promise<number[]> {
  const rows = await client.execute("SELECT version FROM schema_migrations ORDER BY version");
  return rows.rows.map((r) => Number(r.version));
}

function newClient(): Client {
  return createClient({ url: ":memory:" });
}

describe("migration runner e2e", () => {
  test("fresh DB advances to latest in one pass", async () => {
    const client = newClient();
    await bootstrap(client);

    const applied = await runMigrations(client);
    expect(applied).toBe(migrations.length);

    const versions = await getAppliedVersions(client);
    const expected = migrations.map((m) => m.version).sort((a, b) => a - b);
    expect(versions).toEqual(expected);

    client.close();
  });

  test("re-running runner on up-to-date DB is a no-op", async () => {
    const client = newClient();
    await bootstrap(client);
    await runMigrations(client);

    const second = await runMigrations(client);
    expect(second).toBe(0);

    const third = await runMigrations(client);
    expect(third).toBe(0);

    client.close();
  });

  test("resumes from partially-migrated state", async () => {
    if (migrations.length < 2) return;

    const client = newClient();
    await bootstrap(client);

    // Apply only the first half manually, then let the runner finish.
    const cutoff = Math.floor(migrations.length / 2);
    const head = [...migrations].sort((a, b) => a.version - b.version).slice(0, cutoff);

    await client.execute("PRAGMA foreign_keys = OFF");
    for (const m of head) {
      for (const sql of m.sql) await client.execute(sql);
      await client.execute({
        sql: "INSERT INTO schema_migrations (version, name) VALUES (?, ?)",
        args: [m.version, m.name],
      });
    }
    await client.execute("PRAGMA foreign_keys = ON");

    const remaining = await runMigrations(client);
    expect(remaining).toBe(migrations.length - cutoff);

    const versions = await getAppliedVersions(client);
    expect(versions).toEqual(migrations.map((m) => m.version).sort((a, b) => a - b));

    client.close();
  });

  test("each migration applies in its own transaction without errors", async () => {
    const client = newClient();
    await bootstrap(client);

    await client.execute("PRAGMA foreign_keys = OFF");
    const ordered = [...migrations].sort((a, b) => a.version - b.version);
    for (const m of ordered) {
      await client.execute("BEGIN");
      try {
        for (const sql of m.sql) {
          try {
            await client.execute(sql);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (!msg.includes("duplicate column name")) throw err;
          }
        }
        await client.execute("COMMIT");
      } catch (err) {
        await client.execute("ROLLBACK");
        throw new Error(`Migration v${m.version} (${m.name}) failed: ${(err as Error).message}`);
      }
    }
    await client.execute("PRAGMA foreign_keys = ON");

    client.close();
  });

  test("migration versions are unique and monotonic", () => {
    const versions = migrations.map((m) => m.version);
    const unique = new Set(versions);
    expect(unique.size).toBe(versions.length);
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
  });

  test("v36 keeps native car ordinals unique without treating names as identity", async () => {
    const client = newClient();
    await bootstrap(client);
    await runMigrations(client, 35);
    await client.execute(
      `INSERT INTO discovered_cars (game_id, ordinal, name)
       VALUES ('iracing', 101, 'Shared Display Name')`,
    );

    await runMigrations(client, 36);
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

  test("v37 preserves valid layouts, rejects incomplete rows, and stales iRacing captures", async () => {
    const client = newClient();
    await bootstrap(client);
    await runMigrations(client, 36);
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
});
