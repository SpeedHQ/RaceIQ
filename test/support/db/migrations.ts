import { createClient, type Client } from "@libsql/client/sqlite3";
import { migrations } from "../../../server/db/migrations";

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
): Promise<number> {
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

export async function getAppliedVersions(client: Client): Promise<number[]> {
  const rows = await client.execute("SELECT version FROM schema_migrations ORDER BY version");
  return rows.rows.map((r) => Number(r.version));
}

export function newClient(): Client {
  return createClient({ url: ":memory:" });
}
