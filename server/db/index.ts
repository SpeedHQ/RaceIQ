import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "./schema";
import { migrations } from "./migrations";
import { mkdirSync, existsSync } from "fs";

const DB_DIR = process.env.DATA_DIR ?? "./data";
const DB_PATH = `${DB_DIR}/forza-telemetry.db`;

// Ensure data directory exists
if (!existsSync(DB_DIR)) {
  mkdirSync(DB_DIR, { recursive: true });
}

const sqlite = new Database(DB_PATH);

// Enable WAL mode for better concurrent read/write performance
sqlite.exec("PRAGMA journal_mode = WAL");
sqlite.exec("PRAGMA foreign_keys = ON");

// ── Migration system ────────────────────────────────────────────────
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

function getAppliedVersions(): Set<number> {
  const rows = sqlite.query("SELECT version FROM schema_migrations").all() as { version: number }[];
  return new Set(rows.map((r) => r.version));
}

function runMigrations() {
  const applied = getAppliedVersions();
  const pending = migrations.filter((m) => !applied.has(m.version)).sort((a, b) => a.version - b.version);

  if (pending.length === 0) return;

  console.log(`[DB] Running ${pending.length} migration(s)...`);

  for (const migration of pending) {
    console.log(`[DB]   v${migration.version}: ${migration.name}`);
    sqlite.exec("BEGIN");
    try {
      for (const sql of migration.sql) {
        sqlite.exec(sql);
      }
      sqlite.prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)").run(migration.version, migration.name);
      sqlite.exec("COMMIT");
    } catch (err) {
      sqlite.exec("ROLLBACK");
      // For ALTER TABLE that may already exist (migrating from legacy inline migrations)
      const msg = String(err);
      if (msg.includes("duplicate column") || msg.includes("already exists")) {
        console.log(`[DB]     (already applied, marking as done)`);
        sqlite.prepare("INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (?, ?)").run(migration.version, migration.name);
      } else {
        throw err;
      }
    }
  }

  console.log(`[DB] Migrations complete. Schema at v${migrations[migrations.length - 1].version}`);
}

// Detect legacy DB (has tables but no schema_migrations entries)
// Mark existing migrations as applied so they don't re-run
function detectLegacyDb() {
  const applied = getAppliedVersions();
  if (applied.size > 0) return; // Already using migration system

  // Check if sessions table exists (sign of an existing DB)
  const table = sqlite.query("SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'").get();
  if (!table) return; // Fresh DB, nothing to detect

  console.log(`[DB] Detected legacy database, marking existing migrations...`);

  // Check which tables/columns exist and mark corresponding migrations
  const tables = new Set(
    (sqlite.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name)
  );

  const getColumns = (table: string): Set<string> => {
    try {
      return new Set(
        (sqlite.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((r) => r.name)
      );
    } catch {
      return new Set();
    }
  };

  // v1: initial schema
  if (tables.has("sessions")) {
    sqlite.prepare("INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (?, ?)").run(1, "initial schema");
  }
  // v2: tunes
  if (tables.has("tunes")) {
    sqlite.prepare("INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (?, ?)").run(2, "tunes and assignments");
  }
  // v3: tune_id on laps
  if (getColumns("laps").has("tune_id")) {
    sqlite.prepare("INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (?, ?)").run(3, "add tune_id to laps");
  }
  // v4: unit_system on tunes
  if (getColumns("tunes").has("unit_system")) {
    sqlite.prepare("INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (?, ?)").run(4, "add unit_system to tunes");
  }
  // v5: sectors on track_outlines
  if (getColumns("track_outlines").has("sectors")) {
    sqlite.prepare("INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (?, ?)").run(5, "add sectors to track_outlines");
  }
  // v6: analytics on lap_analyses
  if (getColumns("lap_analyses").has("input_tokens")) {
    sqlite.prepare("INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (?, ?)").run(6, "add analytics columns to lap_analyses");
  }
  // v7: profile_id on laps
  if (getColumns("laps").has("profile_id")) {
    sqlite.prepare("INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (?, ?)").run(7, "add profile_id to laps");
  }
  // v8: pi on laps
  if (getColumns("laps").has("pi")) {
    sqlite.prepare("INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (?, ?)").run(8, "add pi to laps");
  }
}

detectLegacyDb();
runMigrations();

// ── Post-migration data backfills ───────────────────────────────────

// Backfill pi from telemetry blobs for existing laps missing it
{
  const rows = sqlite.query("SELECT id, telemetry FROM laps WHERE pi IS NULL").all() as { id: number; telemetry: Buffer }[];
  if (rows.length > 0) {
    console.log(`[DB] Backfilling PI for ${rows.length} laps...`);
    const update = sqlite.prepare("UPDATE laps SET pi = ? WHERE id = ?");
    for (const row of rows) {
      try {
        const decompressed = Bun.gunzipSync(row.telemetry);
        const packets = JSON.parse(new TextDecoder().decode(decompressed));
        const pi = packets[0]?.CarPerformanceIndex ?? 0;
        update.run(pi, row.id);
      } catch {
        update.run(0, row.id);
      }
    }
    console.log(`[DB] PI backfill complete.`);
  }
}

// Seed default profile if none exist
const profileCount = sqlite.query("SELECT COUNT(*) as c FROM profiles").get() as { c: number };
if (profileCount.c === 0) {
  sqlite.exec("INSERT INTO profiles (name) VALUES ('Driver 1')");
}
// Always backfill any laps that have no profile assigned
sqlite.exec("UPDATE laps SET profile_id = (SELECT id FROM profiles ORDER BY id LIMIT 1) WHERE profile_id IS NULL");

export const db = drizzle(sqlite, { schema });
export { sqlite };
