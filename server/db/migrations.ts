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
  // v51: Materialize catalog-derived pit transitions as non-pace laps.
  {
    version: 51,
    name: "exclude pit transitions from lap metrics",
    sql: [
      `UPDATE laps
       SET is_valid = 0, invalid_reason = 'inlap'
       WHERE is_valid = 1
         AND EXISTS (
           SELECT 1
           FROM session_results
           JOIN pit_events ON pit_events.result_id = session_results.id
           WHERE session_results.session_id = laps.session_id
             AND pit_events.linkage = 'linked'
             AND pit_events.lap_number = laps.lap_number
         )`,
      `UPDATE laps
       SET is_valid = 0, invalid_reason = 'outlap'
       WHERE is_valid = 1
         AND EXISTS (
           SELECT 1
           FROM session_results
           JOIN pit_events ON pit_events.result_id = session_results.id
           WHERE session_results.session_id = laps.session_id
             AND pit_events.linkage = 'linked'
             AND pit_events.lap_number + 1 = laps.lap_number
         )`,
    ],
  },
  // v52: Version normalized race-result derivation for future reconciliation.
  {
    version: 52,
    name: "version race result processor",
    sql: [
      `ALTER TABLE session_results ADD COLUMN processor_version TEXT NOT NULL DEFAULT 'legacy-race-result-v0'`,
    ],
  },
  // v53: Persist race timeline event types and position transitions.
  {
    version: 53,
    name: "persist race timeline positions",
    sql: [
      `ALTER TABLE pit_events ADD COLUMN event_type TEXT NOT NULL DEFAULT 'pit'`,
      `ALTER TABLE pit_events ADD COLUMN position_before INTEGER`,
      `ALTER TABLE pit_events ADD COLUMN position_after INTEGER`,
    ],
  },
  // v54: Persist telemetry catalog and resolver identity on sessions.
  {
    version: 54,
    name: "persist telemetry version identity",
    sql: [
      `ALTER TABLE sessions ADD COLUMN catalog_version TEXT`,
      `ALTER TABLE sessions ADD COLUMN catalog_hash TEXT`,
      `ALTER TABLE sessions ADD COLUMN catalog_schema_version TEXT`,
      `ALTER TABLE sessions ADD COLUMN parser_version TEXT`,
      `ALTER TABLE sessions ADD COLUMN resolver_version TEXT`,
      `ALTER TABLE sessions ADD COLUMN derivation_version TEXT`,
    ],
  },
  // v55: Persist telemetry version identity on laps.
  {
    version: 55,
    name: "persist lap telemetry version identity",
    sql: [
      `ALTER TABLE laps ADD COLUMN catalog_version TEXT`,
      `ALTER TABLE laps ADD COLUMN catalog_hash TEXT`,
      `ALTER TABLE laps ADD COLUMN catalog_schema_version TEXT`,
      `ALTER TABLE laps ADD COLUMN parser_version TEXT`,
      `ALTER TABLE laps ADD COLUMN resolver_version TEXT`,
      `ALTER TABLE laps ADD COLUMN derivation_version TEXT`,
    ],
  },
  // v56: Persist race result outcome status.
  {
    version: 56,
    name: "persist race result outcome status",
    sql: [
      `ALTER TABLE session_results ADD COLUMN outcome_status TEXT NOT NULL DEFAULT 'unavailable'`,
    ],
  },
  // v57: Persist structured race-result evidence.
  {
    version: 57,
    name: "persist race result evidence",
    sql: [
      `ALTER TABLE session_results ADD COLUMN evidence TEXT`,
    ],
  },
  // v58: Persist whether a session belongs to the user or another driver.
  {
    version: 58,
    name: "persist session ownership",
    sql: [
      `ALTER TABLE sessions ADD COLUMN ownership TEXT NOT NULL DEFAULT 'mine'`,
      `UPDATE sessions
       SET ownership = 'mine'
       WHERE ownership IS NULL OR ownership NOT IN ('mine', 'others')`,
    ],
  },
  // v59: Persist telemetry quality, source fidelity, and derived-data provenance.
  // Also restores pit_events for databases affected by overlapping migration histories.
  {
    version: 59,
    name: "telemetry quality and provenance",
    sql: [
      `ALTER TABLE sessions ADD COLUMN recording_quality TEXT`,
      `ALTER TABLE sessions ADD COLUMN quality_schema_version TEXT`,
      `ALTER TABLE sessions ADD COLUMN quality_policy_version TEXT`,
      `ALTER TABLE sessions ADD COLUMN quality_config_version TEXT`,
      `ALTER TABLE sessions ADD COLUMN quality_generation TEXT`,
      `ALTER TABLE laps ADD COLUMN quality TEXT`,
      `ALTER TABLE laps ADD COLUMN eligibility TEXT`,
      `ALTER TABLE laps ADD COLUMN quality_schema_version TEXT`,
      `ALTER TABLE laps ADD COLUMN quality_policy_version TEXT`,
      `ALTER TABLE laps ADD COLUMN quality_config_version TEXT`,
      `ALTER TABLE laps ADD COLUMN quality_generation TEXT`,
      `ALTER TABLE lap_analyses ADD COLUMN quality_generation TEXT`,
      `ALTER TABLE lap_analyses ADD COLUMN quality_policy_version TEXT`,
      `ALTER TABLE compare_analyses ADD COLUMN quality_generation TEXT`,
      `ALTER TABLE compare_analyses ADD COLUMN quality_policy_version TEXT`,
      `DELETE FROM lap_analyses`,
      `DELETE FROM compare_analyses`,
      `UPDATE sessions
       SET recording_quality = json_object(
         'lifecycleState', 'unavailable',
         'gapSummary', json_object(
           'expectedCount', 0,
           'observedCount', 0,
           'totalMissingCount', NULL,
           'totalMissingFraction', NULL,
           'largestContiguousGapMs', 0,
           'countMethod', 'unavailable'
         ),
         'facts', json_array(
           json_object(
             'id', 'legacy:quality_not_rebuilt',
             'code', 'quality_not_rebuilt',
             'severity', 'warning',
             'timeRange', NULL,
             'distanceRange', NULL,
             'semanticIds', json_array(),
             'channelFamilies', json_array(),
             'provenance', json_object(
               'schemaVersion', 'legacy',
               'policyVersion', 'legacy',
               'configurationVersion', 'legacy',
               'sourceGeneration', 'legacy',
               'outputGeneration', 'legacy'
             ),
             'eventIds', json_array()
           ),
           json_object(
             'id', 'legacy:provenance_missing',
             'code', 'provenance_missing',
             'severity', 'error',
             'timeRange', NULL,
             'distanceRange', NULL,
             'semanticIds', json_array(),
             'channelFamilies', json_array(),
             'provenance', json_object(
               'schemaVersion', 'legacy',
               'policyVersion', 'legacy',
               'configurationVersion', 'legacy',
               'sourceGeneration', 'legacy',
               'outputGeneration', 'legacy'
             ),
             'eventIds', json_array()
           )
         ),
         'sourceKind', CASE
           WHEN source IN (
             'native-live', 'raceiq-raw', 'raceiq-archive', 'canonical-archive',
             'iracing-ibt', 'motec', 'remote-collector', 'external-log', 'unknown'
           ) THEN source
           ELSE 'unknown'
         END,
        'participant', json_object(
          'kind', CASE WHEN ownership = 'others' THEN 'opponent' ELSE 'player' END,
          'sourceId', NULL,
          'stableId', CASE WHEN ownership = 'others' THEN NULL ELSE 'local-player' END,
          'identityState', CASE WHEN ownership = 'others' THEN 'unknown' ELSE 'stable' END
        ),
         'startTimestampMs', NULL,
         'endTimestampMs', NULL,
         'endReason', 'legacy-not-rebuilt',
         'archiveVerification', json_object(
           'state', 'unknown',
           'sourceGeneration', NULL
         ),
         'thresholds', json_object(
           'minorGapMaxMs', 250,
           'minorMissingFractionMax', 0.01,
           'degradedMissingFraction', 0.05,
           'lapComparisonCoverage', 0.95,
           'lapComparisonGapMaxMs', 1000,
           'cornerTraceCoverage', 0.98,
           'cornerTraceGapMaxMs', 250,
           'transientCoverage', 0.995,
           'transientGapFloorMs', 50,
           'transientIntervalMultiplier', 2
         ),
         'versionIdentity', json_object(
           'catalogVersion', 'legacy',
           'catalogHash', 'legacy',
           'catalogSchemaVersion', 'legacy',
           'parserVersion', 'legacy',
           'resolverVersion', 'legacy',
           'derivationVersion', 'legacy'
         ),
         'provenance', json_object(
           'schemaVersion', 'legacy',
           'policyVersion', 'legacy',
           'configurationVersion', 'legacy',
           'sourceGeneration', 'legacy',
           'outputGeneration', 'legacy'
         )
       ),
       quality_schema_version = 'legacy',
       quality_policy_version = 'legacy',
       quality_config_version = 'legacy',
       quality_generation = 'legacy'
       WHERE recording_quality IS NULL`,
      `UPDATE laps
       SET quality = json_object(
         'lifecycleState', 'unavailable',
         'complete', json(CASE WHEN lap_time > 0 THEN 'true' ELSE 'false' END),
         'structurallyValid', json(CASE
           WHEN is_valid = 1 OR invalid_reason IN ('inlap', 'outlap', 'pit lap') THEN 'true'
           ELSE 'false'
         END),
         'invalidReason', CASE
           WHEN invalid_reason IN ('inlap', 'outlap', 'pit lap') THEN NULL
           ELSE invalid_reason
         END,
         'timing', json_object(
           'source', CASE WHEN lap_time > 0 THEN 'simulator-history' ELSE 'estimated' END,
           'lapTimeMs', lap_time * 1000,
           'peakTelemetryLapTimeMs', NULL,
           'confirmed', json(CASE WHEN lap_time > 0 THEN 'true' ELSE 'false' END)
         ),
         'gapSummary', json_object(
           'expectedCount', 0,
           'observedCount', 0,
           'totalMissingCount', NULL,
           'totalMissingFraction', NULL,
           'largestContiguousGapMs', 0,
           'countMethod', 'unavailable'
         ),
         'trackDistanceCoverage', NULL,
         'worldPositionCoverage', NULL,
         'channelQuality', json_array(),
         'facts', json_array(
           json_object(
             'id', 'legacy:quality_not_rebuilt',
             'code', 'quality_not_rebuilt',
             'severity', 'warning',
             'timeRange', NULL,
             'distanceRange', NULL,
             'semanticIds', json_array(),
             'channelFamilies', json_array(),
             'provenance', json_object(
               'schemaVersion', 'legacy',
               'policyVersion', 'legacy',
               'configurationVersion', 'legacy',
               'sourceGeneration', 'legacy',
               'outputGeneration', 'legacy'
             ),
             'eventIds', json_array()
           ),
           json_object(
             'id', 'legacy:provenance_missing',
             'code', 'provenance_missing',
             'severity', 'error',
             'timeRange', NULL,
             'distanceRange', NULL,
             'semanticIds', json_array(),
             'channelFamilies', json_array(),
             'provenance', json_object(
               'schemaVersion', 'legacy',
               'policyVersion', 'legacy',
               'configurationVersion', 'legacy',
               'sourceGeneration', 'legacy',
               'outputGeneration', 'legacy'
             ),
             'eventIds', json_array()
           )
         ),
         'sourceKind', CASE (
           SELECT source FROM sessions WHERE sessions.id = laps.session_id
         )
           WHEN 'native-live' THEN 'native-live'
           WHEN 'raceiq-raw' THEN 'raceiq-raw'
           WHEN 'raceiq-archive' THEN 'raceiq-archive'
           WHEN 'canonical-archive' THEN 'canonical-archive'
           WHEN 'iracing-ibt' THEN 'iracing-ibt'
           WHEN 'motec' THEN 'motec'
           WHEN 'remote-collector' THEN 'remote-collector'
           WHEN 'external-log' THEN 'external-log'
           WHEN 'unknown' THEN 'unknown'
           ELSE 'unknown'
         END,
        'participant', json_object(
          'kind', CASE (SELECT ownership FROM sessions WHERE sessions.id = laps.session_id)
            WHEN 'others' THEN 'opponent' ELSE 'player' END,
          'sourceId', NULL,
          'stableId', CASE (SELECT ownership FROM sessions WHERE sessions.id = laps.session_id)
            WHEN 'others' THEN NULL ELSE 'local-player' END,
          'identityState', CASE (SELECT ownership FROM sessions WHERE sessions.id = laps.session_id)
            WHEN 'others' THEN 'unknown' ELSE 'stable' END
        ),
        'classification', json_object(
          'phase', CASE invalid_reason
            WHEN 'inlap' THEN 'in'
            WHEN 'outlap' THEN 'out'
            WHEN 'pit lap' THEN 'pit'
            ELSE 'flying'
          END,
          'conditions', json_array(),
          'paceEligibility', CASE
            WHEN invalid_reason IN ('inlap', 'outlap', 'pit lap') THEN 'excluded'
            ELSE 'eligible'
          END
        ),
         'thresholds', json_object(
           'minorGapMaxMs', 250,
           'minorMissingFractionMax', 0.01,
           'degradedMissingFraction', 0.05,
           'lapComparisonCoverage', 0.95,
           'lapComparisonGapMaxMs', 1000,
           'cornerTraceCoverage', 0.98,
           'cornerTraceGapMaxMs', 250,
           'transientCoverage', 0.995,
           'transientGapFloorMs', 50,
           'transientIntervalMultiplier', 2
         ),
         'versionIdentity', json_object(
           'catalogVersion', COALESCE(catalog_version, 'legacy'),
           'catalogHash', COALESCE(catalog_hash, 'legacy'),
           'catalogSchemaVersion', COALESCE(catalog_schema_version, 'legacy'),
           'parserVersion', COALESCE(parser_version, 'legacy'),
           'resolverVersion', COALESCE(resolver_version, 'legacy'),
           'derivationVersion', COALESCE(derivation_version, 'legacy')
         ),
         'provenance', json_object(
           'schemaVersion', 'legacy',
           'policyVersion', 'legacy',
           'configurationVersion', 'legacy',
           'sourceGeneration', 'legacy',
           'outputGeneration', 'legacy'
         )
       ),
       eligibility = json_object(
         'official-timing', json_object(
           'status', CASE WHEN lap_time > 0 THEN 'eligible_with_warning' ELSE 'ineligible' END,
           'policyId', 'official-timing',
           'policyVersion', 'legacy',
           'confidence', json_object('level', 'unknown', 'score', NULL),
           'reasons', json_array(json_object(
             'code', CASE WHEN lap_time > 0 THEN 'quality_not_rebuilt' ELSE 'lap_time_unconfirmed' END,
             'severity', CASE WHEN lap_time > 0 THEN 'warning' ELSE 'error' END,
             'evidenceIds', json_array('legacy:quality_not_rebuilt'),
             'timeRange', NULL,
             'distanceRange', NULL,
             'semanticIds', json_array()
           )),
           'evidenceIds', json_array('legacy:quality_not_rebuilt')
         ),
        'normal-pace', json_object(
          'status', CASE
            WHEN lap_time > 0
              AND (is_valid = 1 OR invalid_reason IN ('inlap', 'outlap', 'pit lap'))
              AND (invalid_reason IS NULL OR invalid_reason NOT IN ('inlap', 'outlap', 'pit lap'))
            THEN 'eligible_with_warning'
            ELSE 'ineligible'
          END,
          'policyId', 'normal-pace',
          'policyVersion', 'legacy',
          'confidence', json_object('level', 'unknown', 'score', NULL),
          'reasons', json_array(json_object(
            'code', CASE
              WHEN lap_time <= 0 THEN 'lap_time_unconfirmed'
              WHEN invalid_reason IN ('inlap', 'outlap', 'pit lap') THEN 'non_pace_classification'
              WHEN is_valid != 1 THEN 'structurally_invalid'
              ELSE 'quality_not_rebuilt'
            END,
            'severity', CASE
              WHEN lap_time > 0
                AND (is_valid = 1 OR invalid_reason IN ('inlap', 'outlap', 'pit lap'))
              THEN 'warning'
              ELSE 'error'
            END,
            'evidenceIds', json_array(CASE
              WHEN invalid_reason IN ('inlap', 'outlap', 'pit lap')
              THEN 'legacy:non_pace_classification'
              ELSE 'legacy:quality_not_rebuilt'
            END),
             'timeRange', NULL,
             'distanceRange', NULL,
             'semanticIds', json_array()
           )),
          'evidenceIds', json_array(CASE
            WHEN invalid_reason IN ('inlap', 'outlap', 'pit lap')
            THEN 'legacy:non_pace_classification'
            ELSE 'legacy:quality_not_rebuilt'
          END)
         ),
         'lap-comparison', json_object(
           'status', 'unknown', 'policyId', 'lap-comparison', 'policyVersion', 'legacy',
           'confidence', json_object('level', 'unknown', 'score', NULL),
           'reasons', json_array(json_object(
             'code', 'quality_not_rebuilt', 'severity', 'warning',
             'evidenceIds', json_array('legacy:quality_not_rebuilt'),
             'timeRange', NULL, 'distanceRange', NULL, 'semanticIds', json_array()
           )),
           'evidenceIds', json_array('legacy:quality_not_rebuilt')
         ),
         'corner-trace', json_object(
           'status', 'unknown', 'policyId', 'corner-trace', 'policyVersion', 'legacy',
           'confidence', json_object('level', 'unknown', 'score', NULL),
           'reasons', json_array(json_object(
             'code', 'quality_not_rebuilt', 'severity', 'warning',
             'evidenceIds', json_array('legacy:quality_not_rebuilt'),
             'timeRange', NULL, 'distanceRange', NULL, 'semanticIds', json_array()
           )),
           'evidenceIds', json_array('legacy:quality_not_rebuilt')
         ),
         'transient-event', json_object(
           'status', 'unknown', 'policyId', 'transient-event', 'policyVersion', 'legacy',
           'confidence', json_object('level', 'unknown', 'score', NULL),
           'reasons', json_array(json_object(
             'code', 'quality_not_rebuilt', 'severity', 'warning',
             'evidenceIds', json_array('legacy:quality_not_rebuilt'),
             'timeRange', NULL, 'distanceRange', NULL, 'semanticIds', json_array()
           )),
           'evidenceIds', json_array('legacy:quality_not_rebuilt')
         ),
         'fuel-burn', json_object(
           'status', 'unknown', 'policyId', 'fuel-burn', 'policyVersion', 'legacy',
           'confidence', json_object('level', 'unknown', 'score', NULL),
           'reasons', json_array(json_object(
             'code', 'quality_not_rebuilt', 'severity', 'warning',
             'evidenceIds', json_array('legacy:quality_not_rebuilt'),
             'timeRange', NULL, 'distanceRange', NULL, 'semanticIds', json_array()
           )),
           'evidenceIds', json_array('legacy:quality_not_rebuilt')
         ),
         'tire-analysis', json_object(
           'status', 'unknown', 'policyId', 'tire-analysis', 'policyVersion', 'legacy',
           'confidence', json_object('level', 'unknown', 'score', NULL),
           'reasons', json_array(json_object(
             'code', 'quality_not_rebuilt', 'severity', 'warning',
             'evidenceIds', json_array('legacy:quality_not_rebuilt'),
             'timeRange', NULL, 'distanceRange', NULL, 'semanticIds', json_array()
           )),
           'evidenceIds', json_array('legacy:quality_not_rebuilt')
         ),
         'stint-falloff', json_object(
           'status', 'unknown', 'policyId', 'stint-falloff', 'policyVersion', 'legacy',
           'confidence', json_object('level', 'unknown', 'score', NULL),
           'reasons', json_array(json_object(
             'code', 'quality_not_rebuilt', 'severity', 'warning',
             'evidenceIds', json_array('legacy:quality_not_rebuilt'),
             'timeRange', NULL, 'distanceRange', NULL, 'semanticIds', json_array()
           )),
           'evidenceIds', json_array('legacy:quality_not_rebuilt')
         ),
         'setup-analysis', json_object(
           'status', 'unknown', 'policyId', 'setup-analysis', 'policyVersion', 'legacy',
           'confidence', json_object('level', 'unknown', 'score', NULL),
           'reasons', json_array(json_object(
             'code', 'quality_not_rebuilt', 'severity', 'warning',
             'evidenceIds', json_array('legacy:quality_not_rebuilt'),
             'timeRange', NULL, 'distanceRange', NULL, 'semanticIds', json_array()
           )),
           'evidenceIds', json_array('legacy:quality_not_rebuilt')
         ),
         'driver-profile', json_object(
           'status', 'unknown', 'policyId', 'driver-profile', 'policyVersion', 'legacy',
           'confidence', json_object('level', 'unknown', 'score', NULL),
           'reasons', json_array(json_object(
             'code', 'quality_not_rebuilt', 'severity', 'warning',
             'evidenceIds', json_array('legacy:quality_not_rebuilt'),
             'timeRange', NULL, 'distanceRange', NULL, 'semanticIds', json_array()
           )),
           'evidenceIds', json_array('legacy:quality_not_rebuilt')
         ),
         'ml-training', json_object(
           'status', 'unknown', 'policyId', 'ml-training', 'policyVersion', 'legacy',
           'confidence', json_object('level', 'unknown', 'score', NULL),
           'reasons', json_array(json_object(
             'code', 'provenance_missing', 'severity', 'error',
             'evidenceIds', json_array('legacy:provenance_missing'),
             'timeRange', NULL, 'distanceRange', NULL, 'semanticIds', json_array()
           )),
           'evidenceIds', json_array('legacy:provenance_missing')
         )
       ),
       quality_schema_version = 'legacy',
       quality_policy_version = 'legacy',
       quality_config_version = 'legacy',
       quality_generation = 'legacy'
       WHERE quality IS NULL`,
      `UPDATE laps
       SET quality = json_insert(
         quality,
         '$.facts[#]',
         json_object(
           'id', 'legacy:non_pace_classification',
           'code', 'non_pace_classification',
           'severity', 'warning',
           'timeRange', NULL,
           'distanceRange', NULL,
           'semanticIds', json_array(),
           'channelFamilies', json_array(),
           'provenance', json_object(
             'schemaVersion', 'legacy',
             'policyVersion', 'legacy',
             'configurationVersion', 'legacy',
             'sourceGeneration', 'legacy',
             'outputGeneration', 'legacy'
           ),
           'eventIds', json_array()
         )
       )
       WHERE invalid_reason IN ('inlap', 'outlap', 'pit lap')`,
      `ALTER TABLE sessions ADD COLUMN source_channel_profile TEXT`,
      `ALTER TABLE lap_metrics ADD COLUMN quality_generation TEXT`,
      `CREATE TABLE IF NOT EXISTS pit_events (
         id                INTEGER PRIMARY KEY AUTOINCREMENT,
         result_id         INTEGER NOT NULL REFERENCES session_results(id) ON DELETE CASCADE,
         sequence          INTEGER NOT NULL,
         event_type        TEXT NOT NULL DEFAULT 'pit',
         position_before   INTEGER,
         position_after    INTEGER,
         lap_number        INTEGER,
         elapsed_seconds   REAL,
         duration_seconds  REAL,
         service           TEXT NOT NULL DEFAULT 'unknown',
         tyre_change       TEXT,
         fuel_added        REAL,
         fuel_before       REAL,
         fuel_after        REAL,
         linkage           TEXT NOT NULL DEFAULT 'unknown',
         source            TEXT,
         created_at        TEXT NOT NULL DEFAULT (datetime('now')),
         UNIQUE(result_id, sequence)
       )`,
      `CREATE INDEX IF NOT EXISTS idx_pit_events_result ON pit_events(result_id, sequence)`,
    ],
  },
  // v60: Replace the result-owned pit ledger with the canonical,
  // session-owned race-event timeline. Legacy event ids are deliberately
  // retained because lap-quality facts may already reference them.
  {
    version: 60,
    name: "add lap classification and canonical race event timeline",
    sql: [
      `ALTER TABLE laps ADD COLUMN phase TEXT NOT NULL DEFAULT 'flying'`,
      `ALTER TABLE laps ADD COLUMN conditions TEXT NOT NULL DEFAULT '[]'`,
      `ALTER TABLE laps ADD COLUMN pace_eligibility TEXT NOT NULL DEFAULT 'eligible'`,
      `UPDATE laps
       SET phase = CASE invalid_reason
         WHEN 'outlap' THEN 'out'
         WHEN 'inlap' THEN 'in'
         WHEN 'pit lap' THEN 'pit'
         ELSE phase
       END,
       pace_eligibility = 'excluded',
       is_valid = 1,
       invalid_reason = NULL
       WHERE invalid_reason IN ('outlap', 'inlap', 'pit lap')`,
      `ALTER TABLE session_results ADD COLUMN event_ids TEXT NOT NULL DEFAULT '[]'`,
      `CREATE TABLE race_events (
         event_id               TEXT PRIMARY KEY,
         event_type             TEXT NOT NULL,
         schema_version         TEXT NOT NULL,
         session_id             INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
         participant_id         TEXT,
         participant_kind       TEXT,
         driver_id              TEXT,
         team_id                TEXT,
         timeline_epoch         INTEGER NOT NULL CHECK (typeof(timeline_epoch) = 'integer' AND timeline_epoch >= 0 AND timeline_epoch <= 9007199254740991),
         sequence               INTEGER NOT NULL CHECK (typeof(sequence) = 'integer' AND sequence >= 0 AND sequence <= 9007199254740991),
         event_order            INTEGER NOT NULL CHECK (typeof(event_order) = 'integer' AND event_order >= 0 AND event_order <= 9007199254740991),
         source_time_ms          INTEGER CHECK (source_time_ms IS NULL OR (typeof(source_time_ms) = 'integer' AND source_time_ms >= -9007199254740991 AND source_time_ms <= 9007199254740991)),
         source_end_time_ms      INTEGER CHECK (source_end_time_ms IS NULL OR (typeof(source_end_time_ms) = 'integer' AND source_end_time_ms >= -9007199254740991 AND source_end_time_ms <= 9007199254740991)),
         source_sequence_family TEXT,
         source_sequence        INTEGER CHECK (source_sequence IS NULL OR (typeof(source_sequence) = 'integer' AND source_sequence >= -9007199254740991 AND source_sequence <= 9007199254740991)),
         received_at_ms         INTEGER NOT NULL CHECK (typeof(received_at_ms) = 'integer' AND received_at_ms >= 0 AND received_at_ms <= 9007199254740991),
         lap_number             INTEGER CHECK (lap_number IS NULL OR (typeof(lap_number) = 'integer' AND lap_number >= 0 AND lap_number <= 9007199254740991)),
         lap_id                 INTEGER REFERENCES laps(id) ON DELETE SET NULL,
         track_distance_m       REAL,
         track_distance_pct     REAL,
         world_position         TEXT,
         evidence_kind          TEXT NOT NULL CHECK (evidence_kind IN ('observed', 'derived', 'inferred')),
         confidence             TEXT NOT NULL CHECK (confidence IN ('high', 'medium', 'low', 'unknown')),
         quality_state          TEXT NOT NULL CHECK (quality_state IN ('available', 'degraded', 'ambiguous', 'unavailable')),
         source_kind            TEXT NOT NULL,
         payload                TEXT NOT NULL,
         lifecycle_id           TEXT,
         linked_event_id        TEXT REFERENCES race_events(event_id) ON DELETE SET NULL,
         detector_id            TEXT NOT NULL,
         detector_version       TEXT NOT NULL,
         source_generation      TEXT,
         analysis_generation_id TEXT,
         content_hash           TEXT,
         created_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
         CHECK (source_time_ms IS NULL OR source_end_time_ms IS NOT NULL),
         CHECK (source_end_time_ms IS NULL OR source_time_ms IS NOT NULL),
         CHECK (source_time_ms IS NULL OR source_end_time_ms >= source_time_ms),
         CHECK (track_distance_pct IS NULL OR (track_distance_pct >= 0 AND track_distance_pct <= 1))
       )`,
      `CREATE INDEX idx_race_events_session_order
       ON race_events(session_id, timeline_epoch, sequence, event_order, event_id)`,
      `CREATE INDEX idx_race_events_participant
       ON race_events(session_id, participant_id, timeline_epoch, sequence, event_order, event_id)`,
      `CREATE INDEX idx_race_events_lap
       ON race_events(lap_id, timeline_epoch, sequence, event_order, event_id)`,
      `CREATE INDEX idx_race_events_source_time
       ON race_events(session_id, source_time_ms, source_end_time_ms)`,
      `CREATE INDEX idx_race_events_lifecycle
       ON race_events(session_id, lifecycle_id, timeline_epoch, sequence, event_order, event_id)`,
      `CREATE INDEX idx_race_events_linked_event ON race_events(linked_event_id)`,
      `CREATE TABLE migration_v60_position_guard (
         is_valid INTEGER NOT NULL CHECK (is_valid = 1)
       )`,
      `INSERT INTO migration_v60_position_guard (is_valid)
       SELECT CASE WHEN EXISTS (
         SELECT 1
         FROM pit_events
         WHERE event_type = 'position-change'
           AND (
             position_after IS NULL
             OR typeof(position_after) != 'integer'
             OR position_after < 1
             OR position_after > 9007199254740991
           )
       ) THEN 0 ELSE 1 END`,
      `DROP TABLE migration_v60_position_guard`,
      `INSERT INTO race_events (
         event_id, event_type, schema_version, session_id,
         participant_id, participant_kind, timeline_epoch, sequence, event_order,
         source_time_ms, source_end_time_ms, received_at_ms,
         lap_number, lap_id, evidence_kind, confidence, quality_state, source_kind,
         payload, lifecycle_id, detector_id, detector_version,
         source_generation, content_hash, created_at
       )
       SELECT
         CASE WHEN pit_events.event_type = 'position-change'
           THEN 'position-event:' || pit_events.id
           ELSE 'pit-event:' || pit_events.id
         END,
         CASE WHEN pit_events.event_type = 'position-change'
           THEN 'position_changed'
           ELSE 'pit_entry'
         END,
         'race-event-v1',
         session_results.session_id,
         'local-player',
         'player',
         0,
         pit_events.sequence,
         CASE WHEN pit_events.event_type = 'position-change' THEN 20 ELSE 50 END,
         CASE WHEN typeof(pit_events.elapsed_seconds) NOT IN ('integer', 'real')
                    OR pit_events.elapsed_seconds < -9007199254740.991
                    OR pit_events.elapsed_seconds > 9007199254740.991
              THEN NULL ELSE CAST(ROUND(pit_events.elapsed_seconds * 1000) AS INTEGER) END,
         CASE WHEN typeof(pit_events.elapsed_seconds) NOT IN ('integer', 'real')
                    OR pit_events.elapsed_seconds < -9007199254740.991
                    OR pit_events.elapsed_seconds > 9007199254740.991
              THEN NULL ELSE CAST(ROUND(pit_events.elapsed_seconds * 1000) AS INTEGER) END,
         COALESCE(CAST(strftime('%s', pit_events.created_at) AS INTEGER) * 1000, 0),
         pit_events.lap_number,
         (SELECT laps.id
          FROM laps
          WHERE laps.session_id = session_results.session_id
            AND laps.lap_number = pit_events.lap_number
          ORDER BY laps.id
          LIMIT 1),
         'derived',
         'unknown',
         'ambiguous',
         CASE WHEN sessions.source IN (
           'native-live', 'raceiq-raw', 'raceiq-archive', 'canonical-archive',
           'iracing-ibt', 'motec', 'remote-collector', 'external-log'
         ) THEN sessions.source ELSE 'unknown' END,
         CASE WHEN pit_events.event_type = 'position-change'
           THEN json_object(
             'previousPosition', CASE
               WHEN typeof(pit_events.position_before) = 'integer'
                AND pit_events.position_before >= 1
                AND pit_events.position_before <= 9007199254740991
               THEN pit_events.position_before
               ELSE NULL
             END,
             'position', pit_events.position_after
           )
           ELSE json_object('previousState', 'unknown', 'state', 'pit-lane')
         END,
         CASE WHEN pit_events.event_type = 'position-change'
           THEN NULL
           ELSE 'legacy:pit-visit:' || pit_events.id
         END,
         'legacy-race-result',
         'legacy-v1',
         'legacy',
         NULL,
         COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', pit_events.created_at), '1970-01-01T00:00:00.000Z')
       FROM pit_events
       JOIN session_results ON session_results.id = pit_events.result_id
       JOIN sessions ON sessions.id = session_results.session_id`,
      `INSERT INTO race_events (
         event_id, event_type, schema_version, session_id,
         participant_id, participant_kind, timeline_epoch, sequence, event_order,
         source_time_ms, source_end_time_ms, received_at_ms,
         lap_number, lap_id, evidence_kind, confidence, quality_state, source_kind,
         payload, lifecycle_id, linked_event_id, detector_id, detector_version,
         source_generation, content_hash, created_at
       )
       SELECT
         'pit-event:' || pit_events.id || ':tire-service',
         'tire_service_observed',
         'race-event-v1',
         session_results.session_id,
         'local-player',
         'player',
         0,
         pit_events.sequence,
         60,
         CASE WHEN typeof(pit_events.elapsed_seconds) NOT IN ('integer', 'real')
                    OR pit_events.elapsed_seconds < -9007199254740.991
                    OR pit_events.elapsed_seconds > 9007199254740.991
              THEN NULL ELSE CAST(ROUND(pit_events.elapsed_seconds * 1000) AS INTEGER) END,
         CASE WHEN typeof(pit_events.elapsed_seconds) NOT IN ('integer', 'real')
                    OR pit_events.elapsed_seconds < -9007199254740.991
                    OR pit_events.elapsed_seconds > 9007199254740.991
              THEN NULL ELSE CAST(ROUND(pit_events.elapsed_seconds * 1000) AS INTEGER) END,
         COALESCE(CAST(strftime('%s', pit_events.created_at) AS INTEGER) * 1000, 0),
         pit_events.lap_number,
         (SELECT laps.id
          FROM laps
          WHERE laps.session_id = session_results.session_id
            AND laps.lap_number = pit_events.lap_number
          ORDER BY laps.id
          LIMIT 1),
         'derived',
         'unknown',
         'ambiguous',
         CASE WHEN sessions.source IN (
           'native-live', 'raceiq-raw', 'raceiq-archive', 'canonical-archive',
           'iracing-ibt', 'motec', 'remote-collector', 'external-log'
         ) THEN sessions.source ELSE 'unknown' END,
         json_object(
           'changedCorners', json_array(),
           'previousCompound', CASE
             WHEN json_valid(pit_events.tyre_change)
              AND json_type(pit_events.tyre_change, '$.from') = 'text'
             THEN json_extract(pit_events.tyre_change, '$.from')
             ELSE NULL
           END,
           'currentCompound', CASE
             WHEN json_valid(pit_events.tyre_change)
              AND json_type(pit_events.tyre_change, '$.to') = 'text'
             THEN json_extract(pit_events.tyre_change, '$.to')
             ELSE NULL
           END,
           'beforeWear', NULL,
           'afterWear', NULL
         ),
         'legacy:pit-visit:' || pit_events.id,
         'pit-event:' || pit_events.id,
         'legacy-race-result',
         'legacy-v1',
         'legacy',
         NULL,
         COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', pit_events.created_at), '1970-01-01T00:00:00.000Z')
       FROM pit_events
       JOIN session_results ON session_results.id = pit_events.result_id
       JOIN sessions ON sessions.id = session_results.session_id
       WHERE pit_events.event_type != 'position-change'
         AND pit_events.tyre_change IS NOT NULL
         AND (json_valid(pit_events.tyre_change) = 0 OR json_type(pit_events.tyre_change) != 'null')`,
      `INSERT INTO race_events (
         event_id, event_type, schema_version, session_id,
         participant_id, participant_kind, timeline_epoch, sequence, event_order,
         source_time_ms, source_end_time_ms, received_at_ms,
         lap_number, lap_id, evidence_kind, confidence, quality_state, source_kind,
         payload, lifecycle_id, linked_event_id, detector_id, detector_version,
         source_generation, content_hash, created_at
       )
       SELECT
         'pit-event:' || pit_events.id || ':fuel-service',
         'fuel_service_observed',
         'race-event-v1',
         session_results.session_id,
         'local-player',
         'player',
         0,
         pit_events.sequence,
         60,
         CASE WHEN typeof(pit_events.elapsed_seconds) NOT IN ('integer', 'real')
                    OR pit_events.elapsed_seconds < -9007199254740.991
                    OR pit_events.elapsed_seconds > 9007199254740.991
              THEN NULL ELSE CAST(ROUND(pit_events.elapsed_seconds * 1000) AS INTEGER) END,
         CASE WHEN typeof(pit_events.elapsed_seconds) NOT IN ('integer', 'real')
                    OR pit_events.elapsed_seconds < -9007199254740.991
                    OR pit_events.elapsed_seconds > 9007199254740.991
              THEN NULL ELSE CAST(ROUND(pit_events.elapsed_seconds * 1000) AS INTEGER) END,
         COALESCE(CAST(strftime('%s', pit_events.created_at) AS INTEGER) * 1000, 0),
         pit_events.lap_number,
         (SELECT laps.id
          FROM laps
          WHERE laps.session_id = session_results.session_id
            AND laps.lap_number = pit_events.lap_number
          ORDER BY laps.id
          LIMIT 1),
         'derived',
         'unknown',
         'ambiguous',
         CASE WHEN sessions.source IN (
           'native-live', 'raceiq-raw', 'raceiq-archive', 'canonical-archive',
           'iracing-ibt', 'motec', 'remote-collector', 'external-log'
         ) THEN sessions.source ELSE 'unknown' END,
         json_object(
           'beforeLitres', pit_events.fuel_before,
           'afterLitres', pit_events.fuel_after,
           'addedLitres', pit_events.fuel_added
         ),
         'legacy:pit-visit:' || pit_events.id,
         'pit-event:' || pit_events.id,
         'legacy-race-result',
         'legacy-v1',
         'legacy',
         NULL,
         COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', pit_events.created_at), '1970-01-01T00:00:00.000Z')
       FROM pit_events
       JOIN session_results ON session_results.id = pit_events.result_id
       JOIN sessions ON sessions.id = session_results.session_id
       WHERE pit_events.event_type != 'position-change'
         AND pit_events.fuel_added IS NOT NULL
         AND pit_events.fuel_before IS NOT NULL
         AND pit_events.fuel_after IS NOT NULL
         AND pit_events.fuel_added >= 0
         AND pit_events.fuel_before >= 0
         AND pit_events.fuel_after >= 0`,
      `INSERT INTO race_events (
         event_id, event_type, schema_version, session_id,
         participant_id, participant_kind, timeline_epoch, sequence, event_order,
         source_time_ms, source_end_time_ms, received_at_ms,
         lap_number, lap_id, evidence_kind, confidence, quality_state, source_kind,
         payload, lifecycle_id, linked_event_id, detector_id, detector_version,
         source_generation, content_hash, created_at
       )
       SELECT
         'pit-event:' || pit_events.id || ':service-completed',
         'pit_service_completed',
         'race-event-v1',
         session_results.session_id,
         'local-player',
         'player',
         0,
         pit_events.sequence,
         50,
         CASE
           WHEN typeof(pit_events.elapsed_seconds) NOT IN ('integer', 'real')
             OR pit_events.elapsed_seconds < -9007199254740.991
             OR pit_events.elapsed_seconds > 9007199254740.991
             OR pit_events.elapsed_seconds + pit_events.duration_seconds > 9007199254740.991
             OR pit_events.elapsed_seconds + pit_events.duration_seconds < -9007199254740.991
           THEN NULL
           ELSE CAST(ROUND(pit_events.elapsed_seconds * 1000) AS INTEGER)
         END,
         CASE
           WHEN typeof(pit_events.elapsed_seconds) NOT IN ('integer', 'real')
             OR pit_events.elapsed_seconds < -9007199254740.991
             OR pit_events.elapsed_seconds > 9007199254740.991
             OR pit_events.elapsed_seconds + pit_events.duration_seconds > 9007199254740.991
             OR pit_events.elapsed_seconds + pit_events.duration_seconds < -9007199254740.991
           THEN NULL
           ELSE CAST(ROUND((pit_events.elapsed_seconds + pit_events.duration_seconds) * 1000) AS INTEGER)
         END,
         COALESCE(CAST(strftime('%s', pit_events.created_at) AS INTEGER) * 1000, 0),
         pit_events.lap_number,
         (SELECT laps.id
          FROM laps
          WHERE laps.session_id = session_results.session_id
            AND laps.lap_number = pit_events.lap_number
          ORDER BY laps.id
          LIMIT 1),
         'derived',
         'unknown',
         'ambiguous',
         CASE WHEN sessions.source IN (
           'native-live', 'raceiq-raw', 'raceiq-archive', 'canonical-archive',
           'iracing-ibt', 'motec', 'remote-collector', 'external-log'
         ) THEN sessions.source ELSE 'unknown' END,
         json_object(
           'durationMs', CAST(ROUND(pit_events.duration_seconds * 1000) AS INTEGER),
           'observedActions', json_array(),
           'state', 'pit-stall'
         ),
         'legacy:pit-visit:' || pit_events.id,
         'pit-event:' || pit_events.id,
         'legacy-race-result',
         'legacy-v1',
         'legacy',
         NULL,
         COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', pit_events.created_at), '1970-01-01T00:00:00.000Z')
       FROM pit_events
       JOIN session_results ON session_results.id = pit_events.result_id
       JOIN sessions ON sessions.id = session_results.session_id
       WHERE pit_events.event_type != 'position-change'
         AND pit_events.duration_seconds IS NOT NULL
         AND typeof(pit_events.duration_seconds) IN ('integer', 'real')
         AND pit_events.duration_seconds >= 0
         AND pit_events.duration_seconds <= 9007199254740.991`,
      `UPDATE session_results
       SET event_ids = COALESCE(
         (SELECT json_group_array(ordered.event_id)
          FROM (
            SELECT event_id
            FROM race_events
            WHERE session_id = session_results.session_id
            ORDER BY timeline_epoch, sequence, event_order, event_id
          ) AS ordered),
         '[]'
       )`,
      `DROP TABLE pit_events`,
    ],
  },
  // v61: Align new result rows with the current processor contract without
  // repurposing v52, whose default has already shipped.
  {
    version: 61,
    name: "default new race results to processor v2",
    sql: [
      `CREATE TABLE session_results_v61 (
         id                  INTEGER PRIMARY KEY AUTOINCREMENT,
         session_id          INTEGER NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
         processor_version   TEXT NOT NULL DEFAULT 'race-result-v2',
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
         updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
         outcome_status      TEXT NOT NULL DEFAULT 'unavailable',
         evidence            TEXT,
         event_ids           TEXT NOT NULL DEFAULT '[]'
       )`,
      `INSERT INTO session_results_v61 (
         id, session_id, processor_version, session_type, classification,
         finishing_position, qualifying_position, is_podium, is_fastest_lap,
         pit_count, tyre_strategy, fuel_strategy, provenance, reasons,
         created_at, updated_at, outcome_status, evidence, event_ids
       )
       SELECT
         id, session_id, processor_version, session_type, classification,
         finishing_position, qualifying_position, is_podium, is_fastest_lap,
         pit_count, tyre_strategy, fuel_strategy, provenance, reasons,
         created_at, updated_at, outcome_status, evidence, event_ids
       FROM session_results`,
      `DROP TABLE session_results`,
      `ALTER TABLE session_results_v61 RENAME TO session_results`,
      `CREATE INDEX idx_session_results_session ON session_results(session_id)`,
    ],
  },
  // v62: Persist canonical participant runs, independent stint dimensions,
  // semantic lap membership, and boundary evidence.
  {
    version: 62,
    name: "add canonical session runs",
    sql: [
      `CREATE TABLE session_runs (
         run_id                    TEXT PRIMARY KEY,
         schema_version            TEXT NOT NULL,
         algorithm_version         TEXT NOT NULL,
         session_id                INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
         participant_id            TEXT,
         participant_kind          TEXT,
         driver_id                 TEXT,
         team_id                   TEXT,
         class_id                  TEXT,
         run_kind                  TEXT NOT NULL CHECK (run_kind IN ('participant', 'tire', 'driver', 'pace')),
         status                    TEXT NOT NULL CHECK (status IN ('complete', 'incomplete')),
         opening_phase             TEXT NOT NULL CHECK (opening_phase IN ('unknown', 'inactive', 'formation', 'green', 'caution', 'red', 'checkered', 'finished')),
         observed_phases           TEXT NOT NULL,
         timeline_epoch            INTEGER NOT NULL CHECK (timeline_epoch >= 0),
         opening_sequence          INTEGER NOT NULL CHECK (opening_sequence >= 0),
         opening_event_order       INTEGER NOT NULL CHECK (opening_event_order >= 0),
         opening_reason            TEXT NOT NULL,
         opening_event_id          TEXT NOT NULL REFERENCES race_events(event_id) ON DELETE CASCADE,
         opening_confidence        TEXT NOT NULL CHECK (opening_confidence IN ('high', 'medium', 'low', 'unknown')),
         opening_evidence_kind     TEXT NOT NULL CHECK (opening_evidence_kind IN ('observed', 'derived', 'inferred')),
         closing_reason            TEXT NOT NULL,
         closing_event_id          TEXT REFERENCES race_events(event_id) ON DELETE CASCADE,
         closing_confidence        TEXT NOT NULL CHECK (closing_confidence IN ('high', 'medium', 'low', 'unknown')),
         closing_evidence_kind     TEXT NOT NULL CHECK (closing_evidence_kind IN ('observed', 'derived', 'inferred')),
         start_lap_event_id        TEXT REFERENCES race_events(event_id) ON DELETE CASCADE,
         end_lap_event_id          TEXT REFERENCES race_events(event_id) ON DELETE CASCADE,
         start_lap_id              INTEGER REFERENCES laps(id) ON DELETE SET NULL,
         end_lap_id                INTEGER REFERENCES laps(id) ON DELETE SET NULL,
         start_source_time_ms      INTEGER,
         end_source_time_ms        INTEGER,
         start_track_distance_m    REAL,
         end_track_distance_m      REAL,
         start_track_distance_pct  REAL,
         end_track_distance_pct    REAL,
         tire_compound             TEXT,
         tire_set_id               TEXT,
         source_generation         TEXT,
         analysis_generation_id    TEXT,
         quality_flags             TEXT NOT NULL,
         summary                   TEXT NOT NULL,
         content_hash              TEXT NOT NULL,
         created_at                TEXT NOT NULL,
         CHECK (closing_event_id IS NOT NULL OR (status = 'incomplete' AND closing_reason = 'source_ended')),
         CHECK (start_source_time_ms IS NULL OR end_source_time_ms IS NULL OR end_source_time_ms >= start_source_time_ms),
         CHECK (start_track_distance_pct IS NULL OR (start_track_distance_pct >= 0 AND start_track_distance_pct <= 1)),
         CHECK (end_track_distance_pct IS NULL OR (end_track_distance_pct >= 0 AND end_track_distance_pct <= 1))
       )`,
      `CREATE UNIQUE INDEX uq_session_runs_known_participant_coordinate
       ON session_runs(session_id, participant_id, run_kind, timeline_epoch, opening_event_id)
       WHERE participant_id IS NOT NULL`,
      `CREATE UNIQUE INDEX uq_session_runs_unknown_participant_coordinate
       ON session_runs(session_id, run_kind, timeline_epoch, opening_event_id)
       WHERE participant_id IS NULL`,
      `CREATE INDEX idx_session_runs_session_kind_order
       ON session_runs(session_id, run_kind, timeline_epoch, opening_sequence, opening_event_order, run_id)`,
      `CREATE INDEX idx_session_runs_participant_kind_order
       ON session_runs(session_id, participant_id, run_kind, timeline_epoch, opening_sequence, opening_event_order, run_id)`,
      `CREATE INDEX idx_session_runs_driver_order
       ON session_runs(driver_id, timeline_epoch, opening_sequence, opening_event_order, run_id)`,
      `CREATE INDEX idx_session_runs_opening_event ON session_runs(opening_event_id)`,
      `CREATE INDEX idx_session_runs_closing_event ON session_runs(closing_event_id)`,
      `CREATE TABLE session_run_laps (
         run_id          TEXT NOT NULL REFERENCES session_runs(run_id) ON DELETE CASCADE,
         lap_event_id    TEXT NOT NULL REFERENCES race_events(event_id) ON DELETE CASCADE,
         lap_id          INTEGER REFERENCES laps(id) ON DELETE SET NULL,
         lap_number      INTEGER NOT NULL CHECK (lap_number >= 0),
         ordinal         INTEGER NOT NULL CHECK (ordinal >= 0),
         entry_event_id  TEXT REFERENCES race_events(event_id) ON DELETE CASCADE,
         exit_event_id   TEXT REFERENCES race_events(event_id) ON DELETE CASCADE,
         PRIMARY KEY (run_id, lap_event_id)
       )`,
      `CREATE INDEX idx_session_run_laps_run_order
       ON session_run_laps(run_id, ordinal, lap_event_id)`,
      `CREATE INDEX idx_session_run_laps_lap_lookup
       ON session_run_laps(lap_event_id, run_id)`,
      `CREATE INDEX idx_session_run_laps_numeric_lap
       ON session_run_laps(lap_id, run_id)`,
      `CREATE TABLE session_run_evidence (
         run_id    TEXT NOT NULL REFERENCES session_runs(run_id) ON DELETE CASCADE,
         event_id  TEXT NOT NULL REFERENCES race_events(event_id) ON DELETE CASCADE,
         role      TEXT NOT NULL CHECK (role IN ('opening', 'closing', 'service', 'supporting')),
         PRIMARY KEY (run_id, event_id, role)
       )`,
      `CREATE INDEX idx_session_run_evidence_event
       ON session_run_evidence(event_id, run_id, role)`,
    ],
  },
  // v63: Persist immutable provenance receipts and one active generation per
  // logical artifact set. Legacy artifacts remain intentionally unreceipted.
  {
    version: 63,
    name: "add analysis provenance receipts",
    sql: [
      `ALTER TABLE sessions ADD COLUMN analysis_generation_id TEXT`,
      `ALTER TABLE laps ADD COLUMN analysis_generation_id TEXT`,
      `ALTER TABLE session_results ADD COLUMN analysis_generation_id TEXT`,
      `CREATE TABLE analysis_receipts (
         generation_id          TEXT PRIMARY KEY,
         artifact_set_id        TEXT NOT NULL,
         session_id             INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
         participant_id         TEXT,
         artifact_set_type      TEXT NOT NULL CHECK (artifact_set_type IN (
           'canonical_archive', 'session_analysis', 'lap_analysis',
           'comparison_analysis', 'driver_profile', 'report'
         )),
         generation             INTEGER NOT NULL CHECK (generation > 0),
         receipt_schema_version TEXT NOT NULL,
         lifecycle              TEXT NOT NULL CHECK (lifecycle IN (
           'rebuild_in_progress', 'active', 'superseded', 'verification_failed'
         )),
         source_content_hash    TEXT,
         contract_hash          TEXT NOT NULL,
         configuration_hash     TEXT NOT NULL,
         receipt                TEXT,
         failure                TEXT,
         started_at             TEXT NOT NULL,
         completed_at           TEXT,
         activated_at           TEXT,
         CHECK (
           (lifecycle = 'rebuild_in_progress' AND receipt IS NULL AND failure IS NULL AND completed_at IS NULL)
           OR (lifecycle IN ('active', 'superseded') AND receipt IS NOT NULL AND failure IS NULL AND completed_at IS NOT NULL)
           OR (lifecycle = 'verification_failed' AND receipt IS NULL AND failure IS NOT NULL AND completed_at IS NOT NULL)
         )
       )`,
      `CREATE UNIQUE INDEX uq_analysis_receipts_artifact_generation
       ON analysis_receipts(artifact_set_id, generation)`,
      `CREATE UNIQUE INDEX uq_analysis_receipts_active
       ON analysis_receipts(artifact_set_id) WHERE lifecycle = 'active'`,
      `CREATE UNIQUE INDEX uq_analysis_receipts_in_progress
       ON analysis_receipts(artifact_set_id) WHERE lifecycle = 'rebuild_in_progress'`,
      `CREATE INDEX idx_analysis_receipts_session_type_lifecycle
       ON analysis_receipts(session_id, artifact_set_type, lifecycle)`,
      `CREATE INDEX idx_analysis_receipts_artifact_generation_desc
       ON analysis_receipts(artifact_set_id, generation DESC)`,
    ],
  },
  // v64: Durable canonical telemetry archive identity, hierarchy, and jobs.
  {
    version: 64,
    name: "add canonical telemetry archives",
    sql: [
      `CREATE TABLE canonical_archives (
         archive_id          TEXT PRIMARY KEY,
         session_id          INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
         generation_id       TEXT NOT NULL,
         status              TEXT NOT NULL CHECK (status IN ('pending', 'building', 'verified', 'partial', 'failed', 'superseded')),
         archive_path        TEXT NOT NULL,
         schema_version      TEXT NOT NULL,
         algorithm_version   TEXT NOT NULL,
         source_content_hash TEXT NOT NULL,
         output_content_hash TEXT,
         byte_size           INTEGER,
         sample_count        INTEGER NOT NULL DEFAULT 0 CHECK (sample_count >= 0),
         node_count          INTEGER NOT NULL DEFAULT 0 CHECK (node_count >= 0),
         semantic_ids        TEXT NOT NULL,
         context             TEXT NOT NULL,
         manifest            TEXT NOT NULL,
         completeness        TEXT NOT NULL CHECK (completeness IN ('complete', 'partial', 'empty', 'unavailable')),
         verification        TEXT,
         created_at          TEXT NOT NULL,
         verified_at         TEXT,
         failure             TEXT
       )`,
      `CREATE UNIQUE INDEX uq_canonical_archives_active_identity
       ON canonical_archives(session_id, source_content_hash)
       WHERE status IN ('pending', 'building', 'verified', 'partial')`,
      `CREATE INDEX idx_canonical_archives_session_status
       ON canonical_archives(session_id, status)`,
      `CREATE INDEX idx_canonical_archives_generation
       ON canonical_archives(session_id, generation_id)`,
      `CREATE TABLE canonical_archive_nodes (
         node_id                    TEXT PRIMARY KEY,
         archive_id                 TEXT NOT NULL REFERENCES canonical_archives(archive_id) ON DELETE CASCADE,
         parent_node_id             TEXT,
         level                      TEXT NOT NULL CHECK (level IN ('participant', 'stint', 'lap', 'corner', 'segment')),
         semantic_kind              TEXT NOT NULL,
         stable_key                 TEXT NOT NULL,
         ordinal                    INTEGER NOT NULL CHECK (ordinal >= 0),
         participant_id             TEXT,
         session_run_id             TEXT,
         lap_id                     INTEGER REFERENCES laps(id) ON DELETE SET NULL,
         start_row                  INTEGER NOT NULL CHECK (start_row >= 0),
         end_row                    INTEGER NOT NULL CHECK (end_row >= start_row),
         start_source_time_ms      INTEGER,
         end_source_time_ms        INTEGER,
         start_track_distance_m    REAL,
         end_track_distance_m      REAL,
         status                     TEXT NOT NULL,
         definition_hash            TEXT,
         boundary_algorithm_version TEXT NOT NULL
       )`,
      `CREATE INDEX idx_canonical_archive_nodes_parent
       ON canonical_archive_nodes(parent_node_id)`,
      `CREATE INDEX idx_canonical_archive_nodes_archive_level_order
       ON canonical_archive_nodes(archive_id, level, ordinal)`,
      `CREATE INDEX idx_canonical_archive_nodes_participant_order
       ON canonical_archive_nodes(archive_id, participant_id, level, ordinal)`,
      `CREATE INDEX idx_canonical_archive_nodes_source_ids
       ON canonical_archive_nodes(session_run_id, lap_id)`,
      `CREATE TABLE canonical_archive_jobs (
         job_id             TEXT PRIMARY KEY,
         session_id         INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
         source_content_hash TEXT NOT NULL,
         status              TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
         attempt_count      INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
         lease_expires_at   TEXT,
         next_attempt_at    TEXT NOT NULL,
         generation_id      TEXT,
         last_error         TEXT,
         created_at         TEXT NOT NULL,
         updated_at         TEXT NOT NULL
       )`,
      `CREATE UNIQUE INDEX uq_canonical_archive_jobs_source
       ON canonical_archive_jobs(session_id, source_content_hash)`,
      `CREATE INDEX idx_canonical_archive_jobs_claim
       ON canonical_archive_jobs(status, next_attempt_at, lease_expires_at)`,
    ],
  },
  // v65: Lease capabilities and stable raw-file identity for canonical archive
  // scheduling. Existing captures hash once after upgrade, then reuse identity
  // while file metadata remains unchanged.
  {
    version: 65,
    name: "harden canonical archive leases and raw identities",
    sql: [
      `ALTER TABLE canonical_archive_jobs ADD COLUMN lease_token TEXT`,
      `ALTER TABLE sessions ADD COLUMN raw_capture_file_size INTEGER`,
      `ALTER TABLE sessions ADD COLUMN raw_capture_file_mtime_ms INTEGER`,
      `ALTER TABLE sessions ADD COLUMN raw_capture_file_ctime_ms INTEGER`,
      `ALTER TABLE sessions ADD COLUMN raw_capture_content_hash TEXT`,
      `CREATE UNIQUE INDEX uq_canonical_archive_jobs_lease_token
       ON canonical_archive_jobs(lease_token)
       WHERE lease_token IS NOT NULL`,
    ],
  },
  {
    version: 66,
    name: "persist structured findings and cache fences",
    sql: [
      `CREATE TABLE finding_generations (
        id TEXT PRIMARY KEY NOT NULL,
        lap_id INTEGER REFERENCES laps(id) ON DELETE CASCADE,
        scope_key TEXT NOT NULL,
        scope TEXT NOT NULL,
        source_id TEXT NOT NULL,
        rule TEXT NOT NULL,
        config TEXT NOT NULL,
        schema_version TEXT NOT NULL,
        status TEXT NOT NULL,
        finding_count INTEGER NOT NULL DEFAULT 0,
        available_count INTEGER NOT NULL DEFAULT 0,
        unavailable_count INTEGER NOT NULL DEFAULT 0,
        indeterminate_count INTEGER NOT NULL DEFAULT 0,
        content_hash TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        verified_at TEXT,
        activated_at TEXT,
        stale_at TEXT,
        failure_reason TEXT
      )`,
      `CREATE INDEX finding_generations_scope_status_idx
        ON finding_generations (scope_key, status)`,
      `CREATE INDEX finding_generations_lap_idx
        ON finding_generations (lap_id)`,
      `CREATE INDEX finding_generations_scope_created_idx
        ON finding_generations (scope_key, created_at, id)`,
      `CREATE UNIQUE INDEX finding_generations_one_current_idx
        ON finding_generations (scope_key)
        WHERE status IN ('current', 'stale-rebuild-available', 'stale-source-missing')`,
      `CREATE TABLE finding_records (
        generation_id TEXT NOT NULL REFERENCES finding_generations(id) ON DELETE CASCADE,
        finding_id TEXT NOT NULL,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        structured TEXT NOT NULL,
        structured_hash TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (generation_id, finding_id)
      )`,
      `CREATE INDEX finding_records_finding_idx
        ON finding_records (finding_id)`,
      `CREATE INDEX finding_records_generation_idx
        ON finding_records (generation_id)`,
      `ALTER TABLE lap_analyses ADD COLUMN finding_generation_key TEXT`,
      `ALTER TABLE compare_analyses ADD COLUMN finding_generation_key TEXT`,
    ],
  },
];

