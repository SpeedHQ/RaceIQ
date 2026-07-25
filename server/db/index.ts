import { createClient, type Client } from "@libsql/client/sqlite3";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "./schema";
import { migrations } from "./migrations";
import { mkdirSync, existsSync } from "fs";
import { resolveDataDir } from "../data-dir";

// Always resolve the data dir, even when the DB itself lives in memory: the
// call doubles as the safety net that throws if a test run somehow reaches
// here with DATA_DIR unset (see server/data-dir.ts), and sibling state such as
// settings.json still lives on disk.
const DB_DIR = resolveDataDir();
const DB_PATH = `${DB_DIR}/forza-telemetry.db`;

/**
 * Opt-in only: set DB_IN_MEMORY=1. Tests deliberately do NOT default to this.
 *
 * `:memory:` in libsql is per-connection, not per-process. Migrations run on
 * the connection this module opens; any second connection the client opens is
 * a brand-new empty database, so queries there fail with "no such table: X"
 * for whichever table they touch. A file: DB is shared across connections and
 * does not have this failure mode.
 *
 * Measured on an 11-file subset: DB_IN_MEMORY=1 gave 59 pass / 18 fail (all
 * "no such table"), the same files on the file DB gave 77 pass / 0 fail.
 * Don't flip this default without re-running that comparison.
 */
const IN_MEMORY = process.env.DB_IN_MEMORY === "1";

// Ensure data directory exists
if (!existsSync(DB_DIR)) {
  mkdirSync(DB_DIR, { recursive: true });
}

const client: Client = createClient({ url: IN_MEMORY ? ":memory:" : `file:${DB_PATH}` });

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

  // Disable FK enforcement during migrations so schema rebuilds (e.g. dropping
  // and recreating a table to remove a column default) can proceed even when
  // other tables reference the dropped one. SQLite requires this pragma to be
  // set outside any transaction, which is why it lives at the runner level.
  await client.execute("PRAGMA foreign_keys = OFF");

  try {
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
  } finally {
    await client.execute("PRAGMA foreign_keys = ON");
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

// ── Orphaned tuning-stamp sweep ─────────────────────────────────────
// Laps carry tuning_session_id / tuning_test_id foreign keys, but there is
// no cascade: if a tuning_sessions / tuning_tests row disappears (a DB reset
// or swap that drops those tables while laps persist), the laps are left
// pointing at ids that no longer resolve. Those dangling ids make the review
// page (and any tuning dashboard) request a session that 404s. Null them out
// on every boot — idempotent, cheap, and catches orphans from any cause.
const orphanSession = await client.execute(
  "UPDATE laps SET tuning_session_id = NULL WHERE tuning_session_id IS NOT NULL AND tuning_session_id NOT IN (SELECT id FROM tuning_sessions)",
);
const orphanTest = await client.execute(
  "UPDATE laps SET tuning_test_id = NULL WHERE tuning_test_id IS NOT NULL AND tuning_test_id NOT IN (SELECT id FROM tuning_tests)",
);
const orphanCleared = Number(orphanSession.rowsAffected ?? 0) + Number(orphanTest.rowsAffected ?? 0);
if (orphanCleared > 0) {
  console.log(`[DB] Cleared ${orphanCleared} orphaned tuning stamp(s) on laps (parent session/test gone)`);
}

export const db = drizzle(client, { schema });
export { client };
