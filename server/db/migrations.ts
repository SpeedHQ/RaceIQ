/**
 * Numbered migrations for the Forza Telemetry database.
 * Each migration runs exactly once, in order. Add new migrations at the end.
 * Never modify or remove existing migrations.
 */
export const migrations: { version: number; name: string; sql: string[] }[] = [
  {
    version: 1,
    name: "initial schema",
    sql: [
      `CREATE TABLE IF NOT EXISTS sessions (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        car_ordinal   INTEGER NOT NULL,
        track_ordinal INTEGER NOT NULL,
        created_at    TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
      `CREATE TABLE IF NOT EXISTS laps (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id  INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        lap_number  INTEGER NOT NULL,
        lap_time    REAL NOT NULL,
        is_valid    INTEGER NOT NULL DEFAULT 1,
        telemetry   BLOB NOT NULL,
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
      `CREATE INDEX IF NOT EXISTS idx_laps_session ON laps(session_id)`,
      `CREATE TABLE IF NOT EXISTS track_corners (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        track_ordinal   INTEGER NOT NULL,
        corner_index    INTEGER NOT NULL,
        label           TEXT NOT NULL,
        distance_start  REAL NOT NULL,
        distance_end    REAL NOT NULL,
        is_auto         INTEGER NOT NULL DEFAULT 1,
        UNIQUE(track_ordinal, corner_index)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_corners_track ON track_corners(track_ordinal)`,
      `CREATE TABLE IF NOT EXISTS track_outlines (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        track_ordinal   INTEGER NOT NULL UNIQUE,
        outline         BLOB NOT NULL,
        created_at      TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
      `CREATE INDEX IF NOT EXISTS idx_outlines_track ON track_outlines(track_ordinal)`,
      `CREATE TABLE IF NOT EXISTS lap_analyses (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        lap_id          INTEGER NOT NULL UNIQUE REFERENCES laps(id) ON DELETE CASCADE,
        analysis        TEXT NOT NULL,
        created_at      TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
      `CREATE TABLE IF NOT EXISTS profiles (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
    ],
  },
  {
    version: 2,
    name: "tunes and assignments",
    sql: [
      `CREATE TABLE IF NOT EXISTS tunes (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        name            TEXT NOT NULL,
        author          TEXT NOT NULL,
        car_ordinal     INTEGER NOT NULL,
        category        TEXT NOT NULL,
        track_ordinal   INTEGER,
        description     TEXT NOT NULL DEFAULT '',
        strengths       TEXT,
        weaknesses      TEXT,
        best_tracks     TEXT,
        strategies      TEXT,
        settings        TEXT NOT NULL,
        source          TEXT NOT NULL DEFAULT 'user',
        catalog_id      TEXT,
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
      `CREATE INDEX IF NOT EXISTS idx_tunes_car ON tunes(car_ordinal)`,
      `CREATE TABLE IF NOT EXISTS tune_assignments (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        car_ordinal     INTEGER NOT NULL,
        track_ordinal   INTEGER NOT NULL,
        tune_id         INTEGER NOT NULL REFERENCES tunes(id) ON DELETE CASCADE,
        UNIQUE(car_ordinal, track_ordinal)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_assignments_tune ON tune_assignments(tune_id)`,
    ],
  },
  {
    version: 3,
    name: "add tune_id to laps",
    sql: [
      `ALTER TABLE laps ADD COLUMN tune_id INTEGER REFERENCES tunes(id) ON DELETE SET NULL`,
    ],
  },
  {
    version: 4,
    name: "add unit_system to tunes",
    sql: [
      `ALTER TABLE tunes ADD COLUMN unit_system TEXT NOT NULL DEFAULT 'metric'`,
    ],
  },
  {
    version: 5,
    name: "add sectors to track_outlines",
    sql: [
      `ALTER TABLE track_outlines ADD COLUMN sectors TEXT`,
    ],
  },
  {
    version: 6,
    name: "add analytics columns to lap_analyses",
    sql: [
      `ALTER TABLE lap_analyses ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE lap_analyses ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE lap_analyses ADD COLUMN cost_usd REAL NOT NULL DEFAULT 0`,
      `ALTER TABLE lap_analyses ADD COLUMN duration_ms INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE lap_analyses ADD COLUMN model TEXT NOT NULL DEFAULT ''`,
    ],
  },
  {
    version: 7,
    name: "add profile_id to laps",
    sql: [
      `ALTER TABLE laps ADD COLUMN profile_id INTEGER REFERENCES profiles(id)`,
    ],
  },
  {
    version: 8,
    name: "add pi to laps",
    sql: [
      `ALTER TABLE laps ADD COLUMN pi INTEGER`,
    ],
  },
];
