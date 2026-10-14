import { createClient, type Client } from "@libsql/client/sqlite3";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrations } from "../../db/migrations";
import { pendingMigrations } from "../../db/migration-plan";
export async function bootstrap(client: Client): Promise<void> {
  await client.execute("PRAGMA foreign_keys = ON");
  await client.execute(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}

export async function runMigrations(
  client: Client,
  throughVersion = Number.POSITIVE_INFINITY,
  migrationSet = migrations,
): Promise<number> {
  const appliedRows = await client.execute("SELECT version, name FROM schema_migrations");
  const pending = pendingMigrations(migrationSet, appliedRows.rows.map((row) => ({
    version: Number(row.version), name: String(row.name),
  }))).filter((migration) => migration.version <= throughVersion);

  if (pending.length === 0) return 0;

  await client.execute("PRAGMA foreign_keys = OFF");
  try {
    for (const migration of pending) {
      const tx = await client.transaction("write");
      try {
        for (const sql of migration.sql) {
          try {
            await tx.execute(sql);
          } catch (stmtErr: unknown) {
            const msg = stmtErr instanceof Error ? stmtErr.message : String(stmtErr);
            if (!msg.includes("duplicate column name")) throw stmtErr;
          }
        }
        await tx.execute({
          sql: "INSERT INTO schema_migrations (version, name) VALUES (?, ?)",
          args: [migration.version, migration.name],
        });
        await tx.commit();
      } catch (err) {
        await tx.rollback();
        throw err;
      }
    }
  } finally {
    await client.execute("PRAGMA foreign_keys = ON");
  }
  return pending.length;
}

export async function getAppliedVersions(client: Client): Promise<number[]> {
  const rows = await client.execute("SELECT version FROM schema_migrations ORDER BY version");
  return rows.rows.map((r) => Number(r.version));
}

let clientSequence = 0;

export function newClient(): Client {
  clientSequence += 1;
  return createClient({ url: `file:${join(tmpdir(), `raceiq-migrations-${process.pid}-${clientSequence}.db`)}` });
}
