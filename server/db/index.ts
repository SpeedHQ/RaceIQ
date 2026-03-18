import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "./schema";
import { mkdirSync, existsSync } from "fs";

const DB_DIR = "./data";
const DB_PATH = `${DB_DIR}/forza-telemetry.db`;

// Ensure data directory exists
if (!existsSync(DB_DIR)) {
  mkdirSync(DB_DIR, { recursive: true });
}

const sqlite = new Database(DB_PATH);

// Enable WAL mode for better concurrent read/write performance
sqlite.exec("PRAGMA journal_mode = WAL");
sqlite.exec("PRAGMA foreign_keys = ON");

// Create tables if they don't exist
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    car_ordinal   INTEGER NOT NULL,
    track_ordinal INTEGER NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS laps (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    lap_number  INTEGER NOT NULL,
    lap_time    REAL NOT NULL,
    is_valid    INTEGER NOT NULL DEFAULT 1,
    telemetry   BLOB NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_laps_session ON laps(session_id);

  CREATE TABLE IF NOT EXISTS track_corners (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    track_ordinal   INTEGER NOT NULL,
    corner_index    INTEGER NOT NULL,
    label           TEXT NOT NULL,
    distance_start  REAL NOT NULL,
    distance_end    REAL NOT NULL,
    is_auto         INTEGER NOT NULL DEFAULT 1,
    UNIQUE(track_ordinal, corner_index)
  );

  CREATE INDEX IF NOT EXISTS idx_corners_track ON track_corners(track_ordinal);

  CREATE TABLE IF NOT EXISTS track_outlines (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    track_ordinal   INTEGER NOT NULL UNIQUE,
    outline         BLOB NOT NULL,
    sectors         TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_outlines_track ON track_outlines(track_ordinal);



`);

// Migration: add sectors column to track_outlines if it doesn't exist (for existing DBs)
try {
  sqlite.exec("ALTER TABLE track_outlines ADD COLUMN sectors TEXT");
} catch {
  // Column already exists — ignore
}

export const db = drizzle(sqlite, { schema });
export { sqlite };
