import { createClient, type Client } from "@libsql/client/sqlite3";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "./schema";
import { migrations } from "./migrations";
import { mkdirSync, existsSync } from "fs";
import { resolveDataDir } from "../data-dir";

const DB_DIR = resolveDataDir();
const DB_PATH = `${DB_DIR}/forza-telemetry.db`;

// Ensure data directory exists
if (!existsSync(DB_DIR)) {
  mkdirSync(DB_DIR, { recursive: true });
}

const client: Client = createClient({ url: `file:${DB_PATH}` });

// Enable WAL mode for better concurrent read/write performance
await client.execute("PRAGMA journal_mode = WAL");
await client.execute("PRAGMA foreign_keys = ON");
// Wait up to 5s when another process holds the write lock (e.g. during hot-reload)
await client.execute("PRAGMA busy_timeout = 5000");

// ── Migration system ────────────────────────────────────────────────
await client.execute(`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

async function runMigrations() {
  const appliedRows = await client.execute("SELECT version FROM schema_migrations");
  const applied = new Set(appliedRows.rows.map((r) => Number(r.version)));
  const pending = migrations.filter((m) => !applied.has(m.version)).sort((a, b) => a.version - b.version);

  if (pending.length === 0) return;

  console.log(`[DB] Running ${pending.length} migration(s)...`);

  for (const migration of pending) {
    console.log(`[DB]   v${migration.version}: ${migration.name}`);
    await client.execute("BEGIN");
    try {
      for (const sql of migration.sql) {
        try {
          await client.execute(sql);
        } catch (stmtErr: unknown) {
          // ALTER TABLE ADD COLUMN is idempotent — ignore "duplicate column name" errors
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

  console.log(`[DB] Migrations complete.`);
}

await runMigrations();

// Seed default profile if none exist
const profileCount = await client.execute("SELECT COUNT(*) as c FROM profiles");
if (Number(profileCount.rows[0].c) === 0) {
  await client.execute("INSERT INTO profiles (name) VALUES ('Driver 1')");
}
// Backfill any laps that have no profile assigned
await client.execute("UPDATE laps SET profile_id = (SELECT id FROM profiles ORDER BY id LIMIT 1) WHERE profile_id IS NULL");

export const db = drizzle(client, { schema });
export { client };
