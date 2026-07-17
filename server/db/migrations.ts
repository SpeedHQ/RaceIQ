/**
 * Database migrations for RaceIQ.
 *
 * WHY hand-rolled instead of Drizzle's migrate():
 *   The app ships as a self-contained binary (raceiq.exe). Drizzle's migrate()
 *   reads SQL files from disk at runtime, which breaks single-binary distribution.
 *   This system embeds all migration SQL directly in the compiled output.
 *
 * Drizzle is used only as a query builder and type-safe schema reference.
 * server/db/schema.ts must be kept in sync with migrations here, but schema
 *   changes must always go through this file — never via `bun run db:push`.
 *
 * To add a schema change:
 *   1. Edit server/db/schema.ts
 *   2. Add a new { version, name, sql } entry below with the next version number
 */
export const migrations: { version: number; name: string; sql: string[] }[] = [
  {
    version: 1,
    name: "current schema",
    sql: [
      `CREATE TABLE IF NOT EXISTS profiles (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,

      `CREATE TABLE IF NOT EXISTS sessions (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        car_ordinal   INTEGER NOT NULL,
        track_ordinal INTEGER NOT NULL,
        game_id       TEXT NOT NULL DEFAULT 'fm-2023',
        session_type  TEXT,
        created_at    TEXT NOT NULL DEFAULT (datetime('now'))
      )`,

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
        unit_system     TEXT NOT NULL DEFAULT 'metric',
        source          TEXT NOT NULL DEFAULT 'user',
        catalog_id      TEXT,
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
      `CREATE INDEX IF NOT EXISTS idx_tunes_car ON tunes(car_ordinal)`,

      `CREATE TABLE IF NOT EXISTS laps (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id   INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        lap_number   INTEGER NOT NULL,
        lap_time     REAL NOT NULL,
        is_valid     INTEGER NOT NULL DEFAULT 1,
        invalid_reason TEXT,
        profile_id   INTEGER REFERENCES profiles(id),
        pi           INTEGER,
        tune_id      INTEGER REFERENCES tunes(id) ON DELETE SET NULL,
        telemetry    BLOB NOT NULL,
        created_at   TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
      `CREATE INDEX IF NOT EXISTS idx_laps_session ON laps(session_id)`,

      `CREATE TABLE IF NOT EXISTS tune_assignments (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        car_ordinal     INTEGER NOT NULL,
        track_ordinal   INTEGER NOT NULL,
        tune_id         INTEGER NOT NULL REFERENCES tunes(id) ON DELETE CASCADE,
        UNIQUE(car_ordinal, track_ordinal)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_assignments_tune ON tune_assignments(tune_id)`,

      `CREATE TABLE IF NOT EXISTS track_outlines (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        track_ordinal   INTEGER NOT NULL,
        game_id         TEXT NOT NULL DEFAULT 'fm-2023',
        outline         BLOB NOT NULL,
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        sectors         TEXT,
        UNIQUE(track_ordinal, game_id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_outlines_track ON track_outlines(track_ordinal)`,

      `CREATE TABLE IF NOT EXISTS track_corners (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        track_ordinal   INTEGER NOT NULL,
        game_id         TEXT NOT NULL DEFAULT 'fm-2023',
        corner_index    INTEGER NOT NULL,
        label           TEXT NOT NULL,
        distance_start  REAL NOT NULL,
        distance_end    REAL NOT NULL,
        is_auto         INTEGER NOT NULL DEFAULT 1,
        UNIQUE(track_ordinal, game_id, corner_index)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_corners_track ON track_corners(track_ordinal)`,

      `CREATE TABLE IF NOT EXISTS lap_analyses (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        lap_id          INTEGER NOT NULL UNIQUE REFERENCES laps(id) ON DELETE CASCADE,
        analysis        TEXT NOT NULL,
        input_tokens    INTEGER NOT NULL DEFAULT 0,
        output_tokens   INTEGER NOT NULL DEFAULT 0,
        cost_usd        REAL NOT NULL DEFAULT 0,
        duration_ms     INTEGER NOT NULL DEFAULT 0,
        model           TEXT NOT NULL DEFAULT '',
        created_at      TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
    ],
  },
  {
    version: 13,
    name: "add car setup to laps",
    sql: [
      `ALTER TABLE laps ADD COLUMN car_setup TEXT`,
    ],
  },
  {
    version: 14,
    name: "add notes to sessions and laps",
    sql: [
      `ALTER TABLE sessions ADD COLUMN notes TEXT`,
      `ALTER TABLE laps ADD COLUMN notes TEXT`,
    ],
  },
  {
    version: 15,
    name: "add sector times to laps",
    sql: [
      `ALTER TABLE laps ADD COLUMN s1_time REAL`,
      `ALTER TABLE laps ADD COLUMN s2_time REAL`,
      `ALTER TABLE laps ADD COLUMN s3_time REAL`,
    ],
  },
  {
    version: 16,
    name: "create compare_analyses table",
    sql: [
      `CREATE TABLE IF NOT EXISTS compare_analyses (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        lap_a_id      INTEGER NOT NULL,
        lap_b_id      INTEGER NOT NULL,
        kind          TEXT NOT NULL DEFAULT 'inputs',
        analysis      TEXT NOT NULL,
        input_tokens  INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd      REAL NOT NULL DEFAULT 0,
        duration_ms   INTEGER NOT NULL DEFAULT 0,
        model         TEXT NOT NULL DEFAULT '',
        created_at    TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (lap_a_id, lap_b_id, kind)
      )`,
    ],
  },
  {
    version: 17,
    name: "drop sectors column from track_outlines",
    sql: [
      `ALTER TABLE track_outlines DROP COLUMN sectors`,
    ],
  },

  // ── v18: drop DEFAULT 'fm-2023' from game_id columns ─────────────────
  //
  // The `DEFAULT 'fm-2023'` added in v1 was a silent fallback: if any insert
  // path ever omitted `game_id`, SQLite would quietly stamp it as Forza. All
  // callers now supply the game explicitly, so the default is dead code and
  // removing it makes "missing gameId" a hard failure at the DB boundary.
  //
  // SQLite has no `ALTER COLUMN DROP DEFAULT`, so each table is rebuilt:
  //   1. CREATE <table>_new without the default
  //   2. copy rows
  //   3. drop old, rename new
  //   4. recreate indexes
  // FK enforcement is toggled off in the runner so `DROP TABLE sessions`
  // succeeds while `laps.session_id` references it.
  {
    version: 18,
    name: "drop fm-2023 default from gameId columns",
    sql: [
      // sessions — referenced by laps.session_id (FK cascade)
      `CREATE TABLE sessions_new (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        car_ordinal   INTEGER NOT NULL,
        track_ordinal INTEGER NOT NULL,
        game_id       TEXT NOT NULL,
        session_type  TEXT,
        notes         TEXT,
        created_at    TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
      `INSERT INTO sessions_new (id, car_ordinal, track_ordinal, game_id, session_type, notes, created_at)
         SELECT id, car_ordinal, track_ordinal, game_id, session_type, notes, created_at FROM sessions`,
      `DROP TABLE sessions`,
      `ALTER TABLE sessions_new RENAME TO sessions`,

      // track_outlines — has UNIQUE(track_ordinal, game_id) + idx_outlines_track
      `CREATE TABLE track_outlines_new (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        track_ordinal   INTEGER NOT NULL,
        game_id         TEXT NOT NULL,
        outline         BLOB NOT NULL,
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(track_ordinal, game_id)
      )`,
      `INSERT INTO track_outlines_new (id, track_ordinal, game_id, outline, created_at)
         SELECT id, track_ordinal, game_id, outline, created_at FROM track_outlines`,
      `DROP TABLE track_outlines`,
      `ALTER TABLE track_outlines_new RENAME TO track_outlines`,
      `CREATE INDEX IF NOT EXISTS idx_outlines_track ON track_outlines(track_ordinal)`,

      // track_corners — has UNIQUE(track_ordinal, game_id, corner_index) + idx_corners_track
      `CREATE TABLE track_corners_new (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        track_ordinal   INTEGER NOT NULL,
        game_id         TEXT NOT NULL,
        corner_index    INTEGER NOT NULL,
        label           TEXT NOT NULL,
        distance_start  REAL NOT NULL,
        distance_end    REAL NOT NULL,
        is_auto         INTEGER NOT NULL DEFAULT 1,
        UNIQUE(track_ordinal, game_id, corner_index)
      )`,
      `INSERT INTO track_corners_new (id, track_ordinal, game_id, corner_index, label, distance_start, distance_end, is_auto)
         SELECT id, track_ordinal, game_id, corner_index, label, distance_start, distance_end, is_auto FROM track_corners`,
      `DROP TABLE track_corners`,
      `ALTER TABLE track_corners_new RENAME TO track_corners`,
      `CREATE INDEX IF NOT EXISTS idx_corners_track ON track_corners(track_ordinal)`,
    ],
  },
  {
    version: 19,
    name: "raw binary lap storage",
    sql: [
      `ALTER TABLE sessions ADD COLUMN raw_file TEXT`,
      `ALTER TABLE sessions ADD COLUMN lap_detector_version TEXT`,
      `ALTER TABLE laps ADD COLUMN raw_byte_offset INTEGER`,
      `ALTER TABLE laps ADD COLUMN raw_frame_count INTEGER`,
      `ALTER TABLE laps DROP COLUMN telemetry`,
    ],
  },
  {
    version: 20,
    name: "community tunes",
    sql: [
      `CREATE TABLE IF NOT EXISTS community_tunes (
        id            TEXT PRIMARY KEY,
        game_id       TEXT NOT NULL,
        car_ordinal   INTEGER NOT NULL,
        track_ordinal INTEGER,
        name          TEXT NOT NULL,
        author        TEXT NOT NULL,
        category      TEXT NOT NULL,
        description   TEXT NOT NULL DEFAULT '',
        source_name   TEXT NOT NULL DEFAULT '',
        settings      TEXT NOT NULL,
        synced_at     TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
      `CREATE INDEX IF NOT EXISTS idx_community_tunes_game ON community_tunes(game_id)`,
    ],
  },

  // ── v21: add game_id to tunes ─────────────────────────────────────────
  //
  // Tunes were previously Forza-only. Multi-game support (ACC, AC-EVO, F1 2025)
  // requires disambiguating which game a tune belongs to. Existing rows are
  // backfilled to 'fm-2023' since that was the only game with tune management.
  {
    version: 21,
    name: "add game_id to tunes",
    sql: [
      `ALTER TABLE tunes ADD COLUMN game_id TEXT NOT NULL DEFAULT 'fm-2023'`,
      `CREATE INDEX IF NOT EXISTS idx_tunes_game_car ON tunes(game_id, car_ordinal)`,
    ],
  },

  // ── v22: scope tune_assignments by game_id ────────────────────────────
  //
  // Assignments were previously Forza-only (unique on car+track). Multi-game
  // tune management means the same car/track ordinal pair can exist under
  // different games, so game_id joins the unique key. Existing rows are
  // backfilled to 'fm-2023', the only game with assignments so far.
  {
    version: 22,
    name: "scope tune_assignments by game_id",
    sql: [
      `CREATE TABLE tune_assignments_new (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        game_id       TEXT NOT NULL DEFAULT 'fm-2023',
        car_ordinal   INTEGER NOT NULL,
        track_ordinal INTEGER NOT NULL,
        tune_id       INTEGER NOT NULL REFERENCES tunes(id) ON DELETE CASCADE,
        UNIQUE(game_id, car_ordinal, track_ordinal)
      )`,
      `INSERT INTO tune_assignments_new (id, game_id, car_ordinal, track_ordinal, tune_id)
         SELECT id, 'fm-2023', car_ordinal, track_ordinal, tune_id FROM tune_assignments`,
      `DROP TABLE tune_assignments`,
      `ALTER TABLE tune_assignments_new RENAME TO tune_assignments`,
      `CREATE INDEX IF NOT EXISTS idx_assignments_tune ON tune_assignments(tune_id)`,
    ],
  },

  // ── v23: discovered cars — auto-registered cars not (yet) in cars.csv ─────
  // AC Evo has no stable ordinals; cars are keyed by name. When the shared
  // memory reports a car name that isn't in shared/games/ac-evo/cars.csv we
  // register it here with a generated ordinal (>= 100000, far above any CSV
  // id) instead of importing the session as -1/"Unknown Car". On startup,
  // reconcileDiscoveredCars() promotes rows whose name has since been added
  // to the CSV: sessions/tunes/etc are remapped to the canonical CSV id and
  // the discovered row is deleted.
  {
    version: 23,
    name: "discovered cars registry",
    sql: [
      `CREATE TABLE IF NOT EXISTS discovered_cars (
         id          INTEGER PRIMARY KEY AUTOINCREMENT,
         game_id     TEXT NOT NULL,
         ordinal     INTEGER NOT NULL,
         name        TEXT NOT NULL,
         model       TEXT NOT NULL DEFAULT '',
         created_at  TEXT NOT NULL DEFAULT (datetime('now')),
         UNIQUE(game_id, ordinal),
         UNIQUE(game_id, name)
       )`,
    ],
  },

  // ── v24: tuning sessions (Setup Engineer front door, plan §6a) ─────────────
  //
  // Parent container for the Setup IQ loop. Car/track stored as both ordinals
  // (live/recorded-session seed) and names (ACC/AC-Evo setup-file seed); all
  // nullable so either origin works. setupVersions.tuning_session_id will FK
  // into this in a later phase.
  {
    version: 24,
    name: "tuning sessions",
    sql: [
      `CREATE TABLE IF NOT EXISTS tuning_sessions (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        game_id         TEXT NOT NULL,
        name            TEXT NOT NULL,
        car_ordinal     INTEGER,
        track_ordinal   INTEGER,
        car_name        TEXT,
        track_name      TEXT,
        base_setup_path TEXT,
        status          TEXT NOT NULL DEFAULT 'active',
        notes           TEXT,
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
      `CREATE INDEX IF NOT EXISTS idx_tuning_sessions_game ON tuning_sessions(game_id)`,
    ],
  },

  // ── v25: tuning tests (setup versions under evaluation, plan §2) ───────────
  //
  // One row per setup being tested inside a tuning session. v1 "base" is seeded
  // on session create from the session's base_setup_path; each Save & recommend
  // appends v(N+1) with the applied diff (applied_changes JSON) and the written
  // setup file. FK cascades from tuning_sessions so archiving/deleting a session
  // takes its tests with it. parent_test_id is self-referential but intentionally
  // not a hard FK — a parent version can be archived independently of its child.
  {
    version: 25,
    name: "tuning tests",
    sql: [
      `CREATE TABLE IF NOT EXISTS tuning_tests (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        tuning_session_id  INTEGER NOT NULL REFERENCES tuning_sessions(id) ON DELETE CASCADE,
        version            INTEGER NOT NULL,
        label              TEXT NOT NULL,
        setup_path         TEXT,
        parent_test_id     INTEGER,
        applied_changes    TEXT,
        driver_comment     TEXT,
        engine             TEXT,
        status             TEXT NOT NULL DEFAULT 'active',
        created_at         TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
      `CREATE INDEX IF NOT EXISTS idx_tuning_tests_session ON tuning_tests(tuning_session_id)`,
    ],
  },

  // ── v26: explicit lap ↔ tuning-session link ────────────────────────────────
  //
  // Decouples tuning-session membership from race (telemetry) sessionId. A
  // tuning session can span MANY race sessions on the same car+track (multiple
  // stints while iterating setups), so membership can't be derived from
  // sessionId or a fragile created-at time window. Instead every lap recorded
  // while a tuning session is active is stamped with its id at insert time
  // (see server/tuning-active.ts + queries.ts::insertLap).
  //
  // NOTE: SQLite cannot add a column WITH an inline REFERENCES clause via
  // ALTER TABLE, so the FK is omitted here — the column is a plain nullable
  // INTEGER. schema.ts still declares the intended `.references(tuning_sessions)`
  // as type-level documentation; there is no runtime FK enforcement or
  // ON DELETE SET NULL cascade on this column. Laps recorded before this
  // migration keep tuning_session_id = NULL and simply won't appear in any
  // tuning session (acceptable — the feature is opt-in going forward).
  {
    version: 26,
    name: "explicit lap to tuning-session link",
    sql: [
      `ALTER TABLE laps ADD COLUMN tuning_session_id INTEGER`,
      `CREATE INDEX IF NOT EXISTS idx_laps_tuning_session ON laps(tuning_session_id)`,
    ],
  },

  // ── v27: per-game tuning-session display number ───────────────────────────
  //
  // A stable 1..N number per game, independent of the churned autoincrement id
  // and of race sessions. Assigned on create as max(seq)+1 per game; existing
  // rows are backfilled in id order within each game.
  {
    version: 27,
    name: "tuning-session display seq",
    sql: [
      `ALTER TABLE tuning_sessions ADD COLUMN seq INTEGER NOT NULL DEFAULT 1`,
      `UPDATE tuning_sessions
         SET seq = (
           SELECT COUNT(*) FROM tuning_sessions t2
           WHERE t2.game_id = tuning_sessions.game_id AND t2.id <= tuning_sessions.id
         )`,
    ],
  },

  // ── v28: persisted checked-out version (head) per tuning session ──────────
  {
    version: 28,
    name: "tuning-session head test id",
    sql: [
      `ALTER TABLE tuning_sessions ADD COLUMN head_test_id INTEGER`,
    ],
  },

  // ── v29: explicit lap → tuning-test link ──────────────────────────────────
  // Correct lap→version attribution under branching. Laps recorded before this
  // (or with no head) keep tuning_test_id = NULL and fall back to the
  // createdAt time-window grouping in the UI.
  {
    version: 29,
    name: "explicit lap to tuning-test link",
    sql: [
      `ALTER TABLE laps ADD COLUMN tuning_test_id INTEGER`,
      `CREATE INDEX IF NOT EXISTS idx_laps_tuning_test ON laps(tuning_test_id)`,
    ],
  },
];
