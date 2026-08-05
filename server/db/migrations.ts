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
  // (see server/experiment-active.ts + queries.ts::insertLap).
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

  // ── v30: Setup Engineer flow — exclusions, F1 snapshot, action log ─────────
  // Three additive changes for the solidified tuning-session flow
  // (docs/setup-engineer-flow-design.md §Phase 0):
  //  • laps.tuning_excluded    — user flag dropping a lap from the tuning aggregate.
  //  • tuning_tests.setup_snapshot — F1's captured/target F1CarSetup JSON (null for
  //    file-based ACC/AC-Evo nodes, which keep using setup_path).
  //  • tuning_actions          — append-only action log backing session undo. Stores
  //    only small refs (JSON inverse payloads), no blobs. Soft ref to the session,
  //    no FK (SQLite can't ALTER-ADD an inline REFERENCES; matches the tuning_session_id
  //    precedent). tuning_tests.status gains a 'deleted' value — no DDL, text column.
  {
    version: 30,
    name: "setup engineer flow: exclusions, F1 snapshot, action log",
    sql: [
      `ALTER TABLE laps ADD COLUMN tuning_excluded INTEGER`,
      `ALTER TABLE tuning_tests ADD COLUMN setup_snapshot TEXT`,
      `CREATE TABLE IF NOT EXISTS tuning_actions (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        tuning_session_id INTEGER NOT NULL,
        kind              TEXT NOT NULL,
        inverse_payload   TEXT,
        undone            INTEGER NOT NULL DEFAULT 0,
        created_at        TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
      `CREATE INDEX IF NOT EXISTS idx_tuning_actions_session ON tuning_actions(tuning_session_id)`,
    ],
  },

  // ── v31: Engineer notes on version nodes ───────────────────────────────────
  // Per-node free-text engineer/AI annotation, distinct from driver_comment
  // (the driver's subjective feel note). The setup-engineer agent writes here
  // to persist per-version reasoning across chat compaction, and it's surfaced
  // in the injected VERSION HISTORY context every turn so the note is readable
  // back after the conversation is summarised.
  {
    version: 31,
    name: "engineer notes on version nodes",
    sql: [`ALTER TABLE tuning_tests ADD COLUMN notes TEXT`],
  },

  // ── v32: Persisted per-lap fuel/tyre metrics ───────────────────────────────
  // fuel_per_lap (litres) and tyre_wear (worst-tyre % worn at lap end) were
  // derived on the fly from each lap's full telemetry on every /lap-metrics
  // request — decoding every frame of every session lap per call. Cache them on
  // the lap row instead: computed once (lazily, on first read) and stored here.
  // Null = not yet computed or no usable telemetry channel.
  {
    version: 32,
    name: "persisted per-lap fuel/tyre metrics",
    sql: [
      `ALTER TABLE laps ADD COLUMN fuel_per_lap REAL`,
      `ALTER TABLE laps ADD COLUMN tyre_wear REAL`,
    ],
  },

  // ── v33: Cached racing-line spread trace ───────────────────────────────────
  // /line-spread decodes every clean lap of a tuning session and runs
  // computeLineSpreadTrace over all of them — expensive at 50 laps. The result
  // is deterministic per (session, clean-lap set), so cache the trace JSON keyed
  // by the tuning session id + a hash of the sorted clean lap ids (+ algo
  // version baked into the hash). A changed lap set yields a new hash.
  {
    version: 33,
    name: "cached racing-line spread trace",
    sql: [
      `CREATE TABLE IF NOT EXISTS line_spread_cache (
        tuning_session_id INTEGER NOT NULL,
        lap_set_hash TEXT NOT NULL,
        trace TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (tuning_session_id, lap_set_hash)
      )`,
    ],
  },

  // ── v34: auto-exclude source tracking for fastest-5 curation ───────────────
  // (docs/superpowers/specs/2026-07-24-tuning-auto-exclude-design.md)
  // `laps.tuning_excluded` was a purely manual flag, so the tuning aggregate
  // disagreed with the fastest-5 curation the review paths (`/line-spread`,
  // `useStintTraces`) actually analysed. This column tracks WHO set the flag:
  //  • 'auto'   — server/experiment-auto-exclude.ts's fastest-5 reconciliation pass.
  //  • 'manual' — user or Setup Engineer; the auto pass never touches these.
  //  • NULL     — not yet reconciled (pre-existing NULL rows).
  // Backfill: every existing `tuning_excluded = 1` row was hand-set (the auto
  // pass didn't exist yet), so it becomes 'manual'. Existing NULL rows stay
  // (NULL, NULL) and reconcile lazily on their next lap save — no bulk
  // recompute here, regressing nothing.
  {
    version: 34,
    name: "auto-exclude source tracking for fastest-5 curation",
    sql: [
      `ALTER TABLE laps ADD COLUMN tuning_excluded_source TEXT`,
      `UPDATE laps SET tuning_excluded_source = 'manual' WHERE tuning_excluded = 1`,
    ],
  },

  // ── v35: purge pre-v0.8.0 laps (no raw capture) ─────────────────────────────
  // `sessions.raw_file` arrived in v19 alongside raw binary lap storage. A
  // session with `raw_file IS NULL` has no .bin behind it, so none of its laps
  // can ever produce telemetry — they were surfaced read-only as "legacy" laps
  // with Analyse/Compare disabled. That carve-out is gone: the rows go instead.
  //
  // Deletes are explicit and child-first rather than leaning on the declared
  // ON DELETE CASCADE, because `runMigrations` sets `PRAGMA foreign_keys = OFF`
  // for the whole batch (SQLite ignores the pragma inside the per-migration
  // transaction, so a migration cannot re-enable it) — under OFF, deleting a
  // session leaves its laps and their analyses orphaned. `compare_analyses`
  // additionally has no foreign key at all, so it would need an explicit
  // delete under either pragma.
  //
  // Nothing on disk to unlink: these sessions never had a raw file.
  {
    version: 35,
    name: "purge pre-v0.8.0 laps with no raw capture",
    sql: [
      `DELETE FROM compare_analyses
         WHERE lap_a_id IN (SELECT id FROM laps WHERE session_id IN (SELECT id FROM sessions WHERE raw_file IS NULL))
            OR lap_b_id IN (SELECT id FROM laps WHERE session_id IN (SELECT id FROM sessions WHERE raw_file IS NULL))`,
      `DELETE FROM lap_analyses
         WHERE lap_id IN (SELECT id FROM laps WHERE session_id IN (SELECT id FROM sessions WHERE raw_file IS NULL))`,
      `DELETE FROM laps WHERE session_id IN (SELECT id FROM sessions WHERE raw_file IS NULL)`,
      `DELETE FROM sessions WHERE raw_file IS NULL`,
    ],
  },

  // ── v36: per-lap derived metrics cache ──────────────────────────────────────
  // Insights + per-segment input stats are pure functions of a lap's raw
  // telemetry, but decoding the .bin costs ~100ms/lap — too slow for the tuning
  // views that read dozens of laps at once. Cached here instead.
  //
  // No backfill: rows are written lazily on first read, so an existing DB just
  // warms up as laps get opened. `algo_version` makes a recompute a code change
  // (bump LAP_METRICS_ALGO_VERSION), not a migration.
  {
    version: 36,
    name: "lap_metrics cache table",
    sql: [
      `CREATE TABLE IF NOT EXISTS lap_metrics (
         lap_id INTEGER PRIMARY KEY REFERENCES laps(id) ON DELETE CASCADE,
         algo_version INTEGER NOT NULL DEFAULT 1,
         insights TEXT NOT NULL,
         segment_stats TEXT NOT NULL,
         computed_at TEXT NOT NULL DEFAULT (datetime('now'))
       )`,
    ],
  },

  // ── v37: tuning tests become experiments ────────────────────────────────────
  // A tuning_test used to mean exactly one thing: "a setup file under
  // evaluation". Pivot tuning (issue #120) needs the same node to also express
  // "a driving change under evaluation" — a drill with no setup file at all —
  // plus the scientific frame around either kind: what we expect to happen
  // (`hypothesis`/`prediction`) and what actually happened (`verdict`).
  //
  // `kind` defaults to 'setup' so every existing row keeps its current meaning;
  // no backfill needed. setup_path / base_setup_path were already nullable, so
  // drill nodes need no table rebuild to omit them.
  //
  // `verdict` is always a human call — 'better'/'worse'/'neutral'/'inconclusive'
  // is a judgement, and nothing in the codebase infers it. Per-lap analysis
  // (`lap_metrics`) is deliberately test-agnostic: it produces concrete
  // observations about how a lap was driven and knows nothing about which
  // experiment, if any, was running. The chat agent reads those observations and
  // may *propose* a verdict; the driver is the one who records it.
  //
  // `verdict_source` therefore records how the driver arrived at the call
  // ('manual' unaided vs 'ai' suggested in chat and accepted), not who wrote the
  // row.
  {
    version: 37,
    name: "tuning_tests experiment semantics (kind, hypothesis, verdict)",
    sql: [
      `ALTER TABLE tuning_tests ADD COLUMN kind TEXT NOT NULL DEFAULT 'setup'`,
      `ALTER TABLE tuning_tests ADD COLUMN hypothesis TEXT`,
      `ALTER TABLE tuning_tests ADD COLUMN prediction TEXT`,
      `ALTER TABLE tuning_tests ADD COLUMN verdict TEXT`,
      `ALTER TABLE tuning_tests ADD COLUMN verdict_at TEXT`,
      `ALTER TABLE tuning_tests ADD COLUMN verdict_source TEXT`,
    ],
  },

  // ── v38: tuning → experiments (the rename) ──────────────────────────────────
  // Concept rename, finally reaching the schema (issue #120). A "tuning session"
  // is an EXPERIMENT and a "tuning test" is one VERSION (a run) inside it. The
  // old names only ever described the setup case, which stopped being the whole
  // story the moment a version could be a driving drill.
  //
  //   tuning_sessions        → experiments
  //   tuning_tests           → experiment_versions
  //   tuning_actions         → experiment_actions
  //   *.tuning_session_id    → experiment_id
  //   laps.tuning_test_id    → experiment_version_id
  //   laps.tuning_excluded*  → experiment_excluded*
  //   experiments.head_test_id → head_version_id
  //
  // ⚠️ `tuning_tests` is REBUILT rather than renamed, and that is not a style
  // choice. `runMigrations` sets `PRAGMA foreign_keys = OFF` for the whole batch
  // (see server/db/index.ts — it must be set outside a transaction, so a
  // migration cannot re-enable it). SQLite only rewrites REFERENCES clauses in
  // *other* tables during `ALTER TABLE ... RENAME TO` when foreign keys are
  // ENABLED. With them off, renaming tuning_sessions would leave
  // tuning_tests.tuning_session_id pointing at a table name that no longer
  // exists — a schema that only fails later, once FKs come back on. Rebuilding
  // the child writes the corrected REFERENCES clause explicitly.
  //
  // Every other table is safe to rename in place: `laps`, `line_spread_cache`
  // and `tuning_actions` hold no runtime FK to these tables (their columns were
  // added by ALTER, which cannot carry an inline REFERENCES), and nothing else
  // references them. There are no views or triggers in this schema.
  //
  // Indexes are dropped and recreated: a renamed table keeps its indexes, but
  // they keep their OLD names too, so leaving them would strand
  // `idx_tuning_sessions_game` on a table called `experiments`.
  {
    version: 38,
    name: "rename tuning_* to experiments/experiment_versions",
    sql: [
      // ── parent: rename in place, no incoming FKs once the child is rebuilt ──
      `ALTER TABLE tuning_sessions RENAME TO experiments`,
      `ALTER TABLE experiments RENAME COLUMN head_test_id TO head_version_id`,

      // ── child: rebuild so its REFERENCES clause names the new parent ────────
      `CREATE TABLE experiment_versions (
         id                 INTEGER PRIMARY KEY AUTOINCREMENT,
         experiment_id      INTEGER NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
         version            INTEGER NOT NULL,
         label              TEXT NOT NULL,
         setup_path         TEXT,
         parent_version_id  INTEGER,
         applied_changes    TEXT,
         driver_comment     TEXT,
         notes              TEXT,
         engine             TEXT,
         setup_snapshot     TEXT,
         kind               TEXT NOT NULL DEFAULT 'setup',
         hypothesis         TEXT,
         prediction         TEXT,
         verdict            TEXT,
         verdict_at         TEXT,
         verdict_source     TEXT,
         status             TEXT NOT NULL DEFAULT 'active',
         created_at         TEXT NOT NULL DEFAULT (datetime('now'))
       )`,
      `INSERT INTO experiment_versions (
         id, experiment_id, version, label, setup_path, parent_version_id,
         applied_changes, driver_comment, notes, engine, setup_snapshot,
         kind, hypothesis, prediction, verdict, verdict_at, verdict_source,
         status, created_at
       )
       SELECT
         id, tuning_session_id, version, label, setup_path, parent_test_id,
         applied_changes, driver_comment, notes, engine, setup_snapshot,
         kind, hypothesis, prediction, verdict, verdict_at, verdict_source,
         status, created_at
       FROM tuning_tests`,
      `DROP TABLE tuning_tests`,

      // ── action log: soft ref only, safe to rename ───────────────────────────
      `ALTER TABLE tuning_actions RENAME TO experiment_actions`,
      `ALTER TABLE experiment_actions RENAME COLUMN tuning_session_id TO experiment_id`,

      // ── laps + caches: plain columns, no FK ─────────────────────────────────
      `ALTER TABLE laps RENAME COLUMN tuning_session_id TO experiment_id`,
      `ALTER TABLE laps RENAME COLUMN tuning_test_id TO experiment_version_id`,
      `ALTER TABLE laps RENAME COLUMN tuning_excluded TO experiment_excluded`,
      `ALTER TABLE laps RENAME COLUMN tuning_excluded_source TO experiment_excluded_source`,
      `ALTER TABLE line_spread_cache RENAME COLUMN tuning_session_id TO experiment_id`,

      // ── indexes: recreate under names that match their tables ───────────────
      `DROP INDEX IF EXISTS idx_tuning_sessions_game`,
      `DROP INDEX IF EXISTS idx_tuning_tests_session`,
      `DROP INDEX IF EXISTS idx_tuning_actions_session`,
      `DROP INDEX IF EXISTS idx_laps_tuning_session`,
      `DROP INDEX IF EXISTS idx_laps_tuning_test`,
      `CREATE INDEX IF NOT EXISTS idx_experiments_game ON experiments(game_id)`,
      `CREATE INDEX IF NOT EXISTS idx_experiment_versions_experiment ON experiment_versions(experiment_id)`,
      `CREATE INDEX IF NOT EXISTS idx_experiment_actions_experiment ON experiment_actions(experiment_id)`,
      `CREATE INDEX IF NOT EXISTS idx_laps_experiment ON laps(experiment_id)`,
      `CREATE INDEX IF NOT EXISTS idx_laps_experiment_version ON laps(experiment_version_id)`,
    ],
  },

  {
    version: 39,
    name: "experiment focus (mutable mode + ledger)",
    sql: [
      // What the experiment is varying now: 'car' or 'driver'. Defaults to
      // 'car', which is what every pre-existing experiment was doing — they all
      // began from a base setup file and their arms are already kind='setup'.
      //
      // Deliberately NOT named 'setup'/'drill' like experiment_versions.kind:
      // the mode and the arm are different levels, and sharing words made
      // "setup" mean three things at once. See shared/experiment-focus.ts.
      `ALTER TABLE experiments ADD COLUMN focus TEXT NOT NULL DEFAULT 'car'`,

      // Append-only record of focus switches, so a session that moved between
      // tuning the car and working on technique can say when and why — and the
      // version tree can mark where each era began.
      `CREATE TABLE IF NOT EXISTS experiment_focus_events (
         id              INTEGER PRIMARY KEY AUTOINCREMENT,
         experiment_id   INTEGER NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
         focus           TEXT NOT NULL,
         from_version_id INTEGER,
         note            TEXT,
         created_at      TEXT NOT NULL DEFAULT (datetime('now'))
       )`,
      `CREATE INDEX IF NOT EXISTS idx_experiment_focus_events_experiment ON experiment_focus_events(experiment_id)`,

      // Seed the ledger so existing experiments aren't blank: each one opened
      // on 'car'. created_at is the experiment's own, not now — the era did
      // start when the experiment did.
      `INSERT INTO experiment_focus_events (experiment_id, focus, created_at)
         SELECT id, 'car', created_at FROM experiments`,
    ],
  },

  {
    version: 40,
    name: "normalise focus values to car/driver",
    sql: [
      // v39 first shipped focus as 'setup'|'driving', which collided with
      // experiment_versions.kind ('setup'|'drill') and made "setup" mean a
      // mode, an arm and a knob edit at once. The values are now 'car'|'driver'
      // (see shared/experiment-focus.ts).
      //
      // v39 is edited in place for anyone who has not run it yet; this pass
      // exists for databases that already applied the old version — a migration
      // that has run is never re-run, so those rows would otherwise sit on a
      // value the zod enum now rejects, breaking the focus switcher and
      // rendering a blank badge.
      `UPDATE experiments SET focus = 'car' WHERE focus = 'setup'`,
      `UPDATE experiments SET focus = 'driver' WHERE focus = 'driving'`,
      `UPDATE experiment_focus_events SET focus = 'car' WHERE focus = 'setup'`,
      `UPDATE experiment_focus_events SET focus = 'driver' WHERE focus = 'driving'`,
    ],
  },

  {
    version: 41,
    name: "enforce unique (experiment_id, version) on experiment_versions",
    sql: [
      // Two write paths derived the next version number differently: the routes
      // asked the DB (`nextVersion`, MAX over every row), while the apply-changes
      // and record-drill tools took MAX over `listExperimentVersions`, which
      // filters `status='deleted'`. Soft-delete the highest arm, apply a change,
      // and the new arm reuses that number — after which `target: "v5"` in a tool
      // call, the version tree and the undo log all disagree about which arm is
      // meant. Nothing in the schema objected, so the divergence was silent.
      //
      // Both call sites now use `nextVersion`; this makes the invariant the
      // database's, so a third write path cannot reintroduce it.
      //
      // Existing duplicates must be renumbered before the index will build.
      // Keep the lowest id on the original number (it is the one the labels and
      // the action log already point at) and push the rest above the current max
      // for their experiment, preserving relative order.
      `UPDATE experiment_versions
         SET version = (
           SELECT MAX(v2.version) FROM experiment_versions v2
            WHERE v2.experiment_id = experiment_versions.experiment_id
         ) + (
           SELECT COUNT(*) FROM experiment_versions v3
            WHERE v3.experiment_id = experiment_versions.experiment_id
              AND v3.id < experiment_versions.id
              AND v3.version = experiment_versions.version
         )
       WHERE EXISTS (
         SELECT 1 FROM experiment_versions v4
          WHERE v4.experiment_id = experiment_versions.experiment_id
            AND v4.version = experiment_versions.version
            AND v4.id < experiment_versions.id
       )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_experiment_versions_experiment_version
         ON experiment_versions(experiment_id, version)`,
    ],
  },

  // ── v42: fix the focus COLUMN DEFAULT left behind by the v39 edit ───────────
  // v40 rewrote the focus *values* but not the column's DEFAULT, and a migration
  // that has already run is never re-run. So a database that applied the
  // pre-rename v39 still carries `focus TEXT NOT NULL DEFAULT 'setup'` — a value
  // `ExperimentFocusSchema` rejects. Nothing hits it today only because
  // `createExperiment` always passes focus explicitly; the next insert path that
  // omits it would silently write an unparseable experiment. Fixing the schema
  // is cheaper than relying on every future caller to remember.
  //
  // SQLite has no `ALTER COLUMN ... SET DEFAULT`, so the table is rebuilt —
  // same shape as v18/v22. Column list and order are taken from the live schema
  // after v38/v39 (`seq`, `head_version_id` and `focus` were appended by ALTER,
  // so they trail the v24 columns).
  //
  // Renaming the rebuilt table into place is safe here, unlike the parent rename
  // in v38: `experiment_versions` and `experiment_focus_events` reference this
  // table BY NAME, and the name is identical before and after. With
  // `PRAGMA foreign_keys = OFF` (set by `runMigrations` for the whole batch)
  // SQLite does not rewrite other tables' REFERENCES clauses during a rename —
  // which is exactly what makes an unchanged name a no-op for them, and what
  // made v38's changed name a hazard.
  {
    version: 42,
    name: "rebuild experiments with focus DEFAULT 'car'",
    sql: [
      `CREATE TABLE experiments_new (
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
         updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
         seq             INTEGER NOT NULL DEFAULT 1,
         head_version_id INTEGER,
         focus           TEXT NOT NULL DEFAULT 'car'
       )`,
      `INSERT INTO experiments_new (
         id, game_id, name, car_ordinal, track_ordinal, car_name, track_name,
         base_setup_path, status, notes, created_at, updated_at, seq,
         head_version_id, focus
       )
       SELECT
         id, game_id, name, car_ordinal, track_ordinal, car_name, track_name,
         base_setup_path, status, notes, created_at, updated_at, seq,
         head_version_id, focus
       FROM experiments`,
      `DROP TABLE experiments`,
      `ALTER TABLE experiments_new RENAME TO experiments`,
      `CREATE INDEX IF NOT EXISTS idx_experiments_game ON experiments(game_id)`,
    ],
  },
  {
    version: 43,
    name: "record how a session's telemetry was obtained",
    sql: [
      // NULL means the session was recorded live from the game, which is every
      // pre-existing row — the flag only needs to mark the cases that are not
      // direct captures. 'motec' means the frames were transcoded from a MoTeC
      // .ld export, so quantities MoTeC does not log (notably the racing line)
      // are reconstructions and the UI must not present them as measured.
      `ALTER TABLE sessions ADD COLUMN source TEXT`,
    ],
  },

  // ── v44: cached driver improvement plans ────────────────────────────────────
  // One row per profile scope. `scope_key` rather than a composite UNIQUE over
  // (game_id, car_ordinal, track_ordinal) because SQLite treats NULLs as
  // distinct in a UNIQUE index: a global-scope profile has both ordinals NULL,
  // so a composite index would happily hold two of them and the upsert would
  // never find the row it meant to replace.
  //
  // No foreign key to laps: the pool is a scope query, not a fixed set of rows,
  // and `pool_key` (a digest of the contributing lap ids) already invalidates
  // the row when that scope's laps change. A cascade would instead delete a
  // still-serviceable plan whenever one old lap was pruned.
  {
    version: 44,
    name: "driver profiles (cached improvement plans)",
    sql: [
      `CREATE TABLE IF NOT EXISTS driver_profiles (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         scope_key TEXT NOT NULL,
         game_id TEXT NOT NULL,
         car_ordinal INTEGER,
         track_ordinal INTEGER,
         pool_key TEXT NOT NULL,
         fingerprint TEXT NOT NULL,
         plan TEXT NOT NULL,
         input_tokens INTEGER NOT NULL DEFAULT 0,
         output_tokens INTEGER NOT NULL DEFAULT 0,
         cost_usd REAL NOT NULL DEFAULT 0,
         duration_ms INTEGER NOT NULL DEFAULT 0,
         model TEXT NOT NULL DEFAULT '',
         created_at TEXT NOT NULL DEFAULT (datetime('now'))
       )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS driver_profiles_scope_key_idx ON driver_profiles (scope_key)`,
      `CREATE INDEX IF NOT EXISTS driver_profiles_game_idx ON driver_profiles (game_id)`,
    ],
  },

  // v45: Runtime-discovered identity registries
  // v23 established discovered_cars for runtime-provided car identity, but its
  // name constraint incorrectly treated display text as identity. Rebuild it
  // so native ordinals remain the only per-game key. iRacing also provides
  // stable track ordinals and names at runtime, so keep the same normalized
  // mapping for tracks instead of repeating names on session rows.
  {
    version: 45,
    name: "runtime-discovered identity registries",
    sql: [
      `CREATE TABLE discovered_cars_v45 (
         id          INTEGER PRIMARY KEY AUTOINCREMENT,
         game_id     TEXT NOT NULL,
         ordinal     INTEGER NOT NULL,
         name        TEXT NOT NULL,
         model       TEXT NOT NULL DEFAULT '',
         created_at  TEXT NOT NULL DEFAULT (datetime('now')),
         UNIQUE(game_id, ordinal)
       )`,
      `INSERT INTO discovered_cars_v45
         (id, game_id, ordinal, name, model, created_at)
       SELECT id, game_id, ordinal, name, model, created_at
       FROM discovered_cars`,
      `DROP TABLE discovered_cars`,
      `ALTER TABLE discovered_cars_v45 RENAME TO discovered_cars`,
      `CREATE TABLE IF NOT EXISTS discovered_tracks (
         id          INTEGER PRIMARY KEY AUTOINCREMENT,
         game_id     TEXT NOT NULL,
         ordinal     INTEGER NOT NULL,
         name        TEXT NOT NULL,
         created_at  TEXT NOT NULL DEFAULT (datetime('now')),
         UNIQUE(game_id, ordinal)
       )`,
    ],
  },

  // v46: Dynamic source-defined sector times (GitHub #134)
  // Sector count belongs to the session layout. iRacing can publish layouts
  // beyond the old fixed S1/S2/S3 shape, including two-sector ovals and road
  // layouts with more than three timing splits. Replace the three summary
  // columns with one ordered JSON array; no projection or compatibility
  // summary is retained.
  {
    version: 46,
    name: "dynamic source-defined sector times",
    sql: [
      // Both histories can reach this migration: upstream still has S1-S3,
      // while databases that ran the iRacing branch already have sector_times.
      // Add whichever source columns are absent, populate only missing arrays,
      // then rebuild to the single authoritative ordered-array representation.
      `ALTER TABLE laps ADD COLUMN sector_times TEXT`,
      `ALTER TABLE laps ADD COLUMN s1_time REAL`,
      `ALTER TABLE laps ADD COLUMN s2_time REAL`,
      `ALTER TABLE laps ADD COLUMN s3_time REAL`,
      `UPDATE laps
       SET sector_times = CASE
         WHEN s1_time IS NULL OR s1_time <= 0
           OR s2_time IS NULL OR s2_time <= 0
           THEN NULL
         WHEN s3_time IS NOT NULL AND s3_time > 0
           THEN json_array(s1_time, s2_time, s3_time)
         WHEN s3_time = 0 AND EXISTS (
           SELECT 1
           FROM sessions
           WHERE sessions.id = laps.session_id
             AND sessions.game_id = 'iracing'
         )
           THEN json_array(s1_time, s2_time)
         ELSE NULL
       END
       WHERE sector_times IS NULL`,
      `CREATE TABLE laps_v46 (
         id                         INTEGER PRIMARY KEY AUTOINCREMENT,
         session_id                 INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
         lap_number                 INTEGER NOT NULL,
         lap_time                   REAL NOT NULL,
         is_valid                   INTEGER NOT NULL DEFAULT 1,
         invalid_reason             TEXT,
         notes                      TEXT,
         profile_id                 INTEGER REFERENCES profiles(id),
         pi                         INTEGER,
         car_setup                  TEXT,
         tune_id                    INTEGER REFERENCES tunes(id) ON DELETE SET NULL,
         sector_times               TEXT,
         raw_byte_offset            INTEGER,
         raw_frame_count            INTEGER,
         experiment_id              INTEGER,
         experiment_version_id      INTEGER,
         experiment_excluded        INTEGER,
         experiment_excluded_source TEXT,
         fuel_per_lap               REAL,
         tyre_wear                  REAL,
         created_at                 TEXT NOT NULL DEFAULT (datetime('now'))
       )`,
      `INSERT INTO laps_v46 (
         id, session_id, lap_number, lap_time, is_valid, invalid_reason,
         notes, profile_id, pi, car_setup, tune_id, sector_times,
         raw_byte_offset, raw_frame_count, experiment_id, experiment_version_id,
         experiment_excluded, experiment_excluded_source, fuel_per_lap,
         tyre_wear, created_at
       )
       SELECT
         id, session_id, lap_number, lap_time, is_valid, invalid_reason,
         notes, profile_id, pi, car_setup, tune_id, sector_times,
         raw_byte_offset, raw_frame_count, experiment_id,
         experiment_version_id, experiment_excluded,
         experiment_excluded_source, fuel_per_lap, tyre_wear, created_at
       FROM laps`,
      `DROP TABLE laps`,
      `ALTER TABLE laps_v46 RENAME TO laps`,
      `CREATE INDEX IF NOT EXISTS idx_laps_session ON laps(session_id)`,
      `CREATE INDEX IF NOT EXISTS idx_laps_experiment ON laps(experiment_id)`,
      `CREATE INDEX IF NOT EXISTS idx_laps_experiment_version ON laps(experiment_version_id)`,
      `UPDATE sessions
       SET lap_detector_version = NULL
       WHERE game_id = 'iracing'
         AND raw_file IS NOT NULL`,
    ],
  },

  // v47: Persist driver-profile execution history independently of the
  // successful current-profile cache in driver_profiles.
  {
    version: 47,
    name: "driver profile run history",
    sql: [
      `CREATE TABLE IF NOT EXISTS driver_profile_runs (
         id              INTEGER PRIMARY KEY AUTOINCREMENT,
         scope_key       TEXT NOT NULL,
         game_id         TEXT NOT NULL,
         car_ordinal     INTEGER,
         track_ordinal   INTEGER,
         pool_key        TEXT NOT NULL,
         status          TEXT NOT NULL DEFAULT 'queued'
                         CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
         fingerprint     TEXT,
         plan            TEXT,
         error           TEXT,
         input_tokens    INTEGER NOT NULL DEFAULT 0,
         output_tokens   INTEGER NOT NULL DEFAULT 0,
         cost_usd        REAL NOT NULL DEFAULT 0,
         duration_ms     INTEGER NOT NULL DEFAULT 0,
         model           TEXT NOT NULL DEFAULT '',
         created_at      TEXT NOT NULL DEFAULT (datetime('now')),
         started_at      TEXT,
         completed_at    TEXT
       )`,
      `CREATE INDEX IF NOT EXISTS driver_profile_runs_scope_status_idx
       ON driver_profile_runs (scope_key, status)`,
      `CREATE INDEX IF NOT EXISTS driver_profile_runs_scope_created_idx
       ON driver_profile_runs (scope_key, created_at DESC, id DESC)`,
    ],
  },
  // v48: Persist normalized race results and ordered pit events.
  {
    version: 48,
    name: "race result metadata",
    sql: [
      `CREATE TABLE IF NOT EXISTS session_results (
         id                  INTEGER PRIMARY KEY AUTOINCREMENT,
         session_id          INTEGER NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
         session_type        TEXT NOT NULL DEFAULT 'unknown',
         classification      TEXT NOT NULL DEFAULT 'unknown',
         finishing_position  INTEGER,
         qualifying_position INTEGER,
         is_podium           INTEGER,
         is_fastest_lap      INTEGER,
         pit_count           INTEGER NOT NULL DEFAULT 0,
         tyre_strategy       TEXT,
         fuel_strategy       TEXT,
         provenance          TEXT,
         reasons             TEXT,
         created_at          TEXT NOT NULL DEFAULT (datetime('now')),
         updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
       )`,
      `CREATE INDEX IF NOT EXISTS idx_session_results_session ON session_results(session_id)`,
      `CREATE TABLE IF NOT EXISTS pit_events (
         id                INTEGER PRIMARY KEY AUTOINCREMENT,
         result_id         INTEGER NOT NULL REFERENCES session_results(id) ON DELETE CASCADE,
         sequence          INTEGER NOT NULL,
         lap_number        INTEGER,
         elapsed_seconds   REAL,
         duration_seconds  REAL,
         service           TEXT NOT NULL DEFAULT 'unknown',
         tyre_change       TEXT,
         fuel_added        REAL,
         fuel_before       REAL,
         fuel_after        REAL,
         linkage           TEXT NOT NULL DEFAULT 'linked',
         source            TEXT,
         created_at        TEXT NOT NULL DEFAULT (datetime('now')),
         UNIQUE(result_id, sequence)
       )`,
      `CREATE INDEX IF NOT EXISTS idx_pit_events_result ON pit_events(result_id, sequence)`,
    ],
  },
  // v49: Version normalized race-result derivation for future reconciliation.
  {
    version: 49,
    name: "version race result processor",
    sql: [
      `ALTER TABLE session_results ADD COLUMN processor_version TEXT NOT NULL DEFAULT 'race-result-v1'`,
    ],
  },
  // v50: Persist race timeline event types and position transitions.
  {
    version: 50,
    name: "persist race timeline positions",
    sql: [
      `ALTER TABLE pit_events ADD COLUMN event_type TEXT NOT NULL DEFAULT 'pit'`,
      `ALTER TABLE pit_events ADD COLUMN position_before INTEGER`,
      `ALTER TABLE pit_events ADD COLUMN position_after INTEGER`,
    ],
  },
];
