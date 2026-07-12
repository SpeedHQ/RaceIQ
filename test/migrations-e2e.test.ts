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

async function runMigrations(client: Client) {
  const appliedRows = await client.execute("SELECT version FROM schema_migrations");
  const applied = new Set(appliedRows.rows.map((r) => Number(r.version)));
  const pending = migrations
    .filter((m) => !applied.has(m.version))
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
});
