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
import { cars as acEvoCars, tracks as acEvoTracks } from "@raceiq/game-ac-evo-metadata/parser-data";

const dashboardProjectionRecoverySql = [
  `CREATE TEMP TABLE dashboard_projection_repair_needed (needed INTEGER NOT NULL)`,
  `INSERT INTO dashboard_projection_repair_needed
   SELECT 1 WHERE
     NOT EXISTS (SELECT 1 FROM sqlite_master WHERE type='table' AND name='dashboard_day_entities')
     OR NOT EXISTS (SELECT 1 FROM sqlite_master WHERE type='table' AND name='dashboard_time_buckets')
     OR NOT EXISTS (SELECT 1 FROM sqlite_master WHERE type='table' AND name='dashboard_session_time_buckets')
     OR NOT EXISTS (SELECT 1 FROM pragma_table_info('dashboard_session_summaries') WHERE name='podium_position')
     OR NOT EXISTS (SELECT 1 FROM pragma_table_info('dashboard_session_summaries') WHERE name='capture_revision')
     OR NOT EXISTS (SELECT 1 FROM pragma_table_info('dashboard_session_summaries') WHERE name='weather_revision')
     OR NOT EXISTS (SELECT 1 FROM pragma_table_info('dashboard_session_summaries') WHERE name='valid_mean_seconds')
     OR NOT EXISTS (SELECT 1 FROM pragma_table_info('dashboard_session_summaries') WHERE name='valid_m2_seconds')
     OR NOT EXISTS (SELECT 1 FROM pragma_table_info('dashboard_session_summaries') WHERE name='first_lap_at_ms')
     OR NOT EXISTS (SELECT 1 FROM pragma_table_info('dashboard_session_summaries') WHERE name='last_lap_at_ms')
     OR NOT EXISTS (SELECT 1 FROM pragma_table_info('dashboard_session_summaries') WHERE name='favourite_laps')
     OR NOT EXISTS (SELECT 1 FROM pragma_table_info('dashboard_session_summaries') WHERE name='favourite_seconds')
     OR NOT EXISTS (SELECT 1 FROM pragma_table_info('dashboard_session_summaries') WHERE name='distance_laps')
     OR NOT EXISTS (SELECT 1 FROM pragma_table_info('dashboard_session_summaries') WHERE name='distance_meters')
     OR NOT EXISTS (SELECT 1 FROM pragma_table_info('dashboard_session_summaries') WHERE name='duration_status')
     OR NOT EXISTS (SELECT 1 FROM pragma_table_info('dashboard_session_summaries') WHERE name='sector_status')
     OR NOT EXISTS (SELECT 1 FROM pragma_table_info('dashboard_session_summaries') WHERE name='weather_status')
     OR NOT EXISTS (SELECT 1 FROM pragma_table_info('dashboard_session_summaries') WHERE name='evidence_version')
     OR NOT EXISTS (SELECT 1 FROM pragma_table_info('dashboard_session_summaries') WHERE name='track_length_meters')
     OR NOT EXISTS (SELECT 1 FROM pragma_table_info('dashboard_session_summaries') WHERE name='podium_status')
     OR NOT EXISTS (SELECT 1 FROM pragma_table_info('dashboard_session_summaries') WHERE name='source_sector_starts_json')
     OR NOT EXISTS (SELECT 1 FROM pragma_table_info('dashboard_session_summaries') WHERE name='weather_conditions_json')
     OR NOT EXISTS (SELECT 1 FROM pragma_table_info('dashboard_session_days') WHERE name='favourite_laps')
     OR NOT EXISTS (SELECT 1 FROM pragma_table_info('dashboard_session_days') WHERE name='favourite_seconds')
     OR NOT EXISTS (SELECT 1 FROM pragma_table_info('dashboard_session_days') WHERE name='distance_laps')
     OR NOT EXISTS (SELECT 1 FROM pragma_table_info('dashboard_session_days') WHERE name='distance_meters')
     OR NOT EXISTS (SELECT 1 FROM pragma_table_info('dashboard_session_time_buckets') WHERE name='valid_seconds')
     OR NOT EXISTS (SELECT 1 FROM sqlite_master WHERE type='table' AND name='dashboard_session_index')
     OR NOT EXISTS (SELECT 1 FROM sqlite_master WHERE type='table' AND name='dashboard_lap_index')
     OR NOT EXISTS (SELECT 1 FROM sqlite_master WHERE type='index' AND name='dashboard_session_time_idx')
     OR NOT EXISTS (SELECT 1 FROM sqlite_master WHERE type='index' AND name='dashboard_session_game_time_idx')
     OR NOT EXISTS (SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='dashboard_session_index_insert')
     OR NOT EXISTS (SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='dashboard_session_index_update')
     OR NOT EXISTS (SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='dashboard_session_index_delete')
     OR NOT EXISTS (SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='dashboard_laps_insert')
     OR NOT EXISTS (SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='dashboard_laps_update')
     OR NOT EXISTS (SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='dashboard_laps_delete')`,
  `CREATE TABLE IF NOT EXISTS dashboard_session_time_buckets (
    session_id INTEGER NOT NULL, bucket_start_ms INTEGER NOT NULL, game_id TEXT NOT NULL,
    valid_laps INTEGER NOT NULL, positive_laps INTEGER NOT NULL, driven_seconds REAL NOT NULL,
    podium_first INTEGER NOT NULL DEFAULT 0, valid_seconds REAL NOT NULL DEFAULT 0,
    podium_second INTEGER NOT NULL DEFAULT 0, podium_third INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(session_id,bucket_start_ms,game_id)
  )`,
  `ALTER TABLE dashboard_session_summaries ADD COLUMN podium_position INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE dashboard_session_summaries ADD COLUMN capture_revision TEXT`,
  `ALTER TABLE dashboard_session_summaries ADD COLUMN weather_revision TEXT`,
  `ALTER TABLE dashboard_session_summaries ADD COLUMN valid_mean_seconds REAL`,
  `ALTER TABLE dashboard_session_summaries ADD COLUMN valid_m2_seconds REAL`,
  `ALTER TABLE dashboard_session_summaries ADD COLUMN first_lap_at_ms INTEGER`,
  `ALTER TABLE dashboard_session_summaries ADD COLUMN last_lap_at_ms INTEGER`,
  `ALTER TABLE dashboard_session_summaries ADD COLUMN favourite_laps INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE dashboard_session_summaries ADD COLUMN favourite_seconds REAL NOT NULL DEFAULT 0`,
  `ALTER TABLE dashboard_session_summaries ADD COLUMN distance_laps INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE dashboard_session_summaries ADD COLUMN distance_meters REAL`,
  `ALTER TABLE dashboard_session_summaries ADD COLUMN duration_status TEXT NOT NULL DEFAULT 'pending'`,
  `ALTER TABLE dashboard_session_summaries ADD COLUMN sector_status TEXT NOT NULL DEFAULT 'pending'`,
  `ALTER TABLE dashboard_session_summaries ADD COLUMN weather_status TEXT NOT NULL DEFAULT 'pending'`,
  `ALTER TABLE dashboard_session_summaries ADD COLUMN evidence_version INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE dashboard_session_summaries ADD COLUMN track_length_meters REAL`,
  `ALTER TABLE dashboard_session_summaries ADD COLUMN podium_status TEXT NOT NULL DEFAULT 'unavailable'`,
  `ALTER TABLE dashboard_session_summaries ADD COLUMN source_sector_starts_json TEXT`,
  `ALTER TABLE dashboard_session_summaries ADD COLUMN weather_conditions_json TEXT`,
  `ALTER TABLE dashboard_session_days ADD COLUMN favourite_laps INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE dashboard_session_days ADD COLUMN favourite_seconds REAL NOT NULL DEFAULT 0`,
  `ALTER TABLE dashboard_session_days ADD COLUMN distance_laps INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE dashboard_session_days ADD COLUMN distance_meters REAL`,
  `ALTER TABLE dashboard_session_time_buckets ADD COLUMN valid_seconds REAL NOT NULL DEFAULT 0`,
  `CREATE TABLE IF NOT EXISTS dashboard_day_entities (
    utc_day TEXT NOT NULL, game_id TEXT NOT NULL, car_key TEXT NOT NULL, track_key TEXT NOT NULL,
    lap_count INTEGER NOT NULL, positive_laps INTEGER NOT NULL, valid_laps INTEGER NOT NULL,
    driven_seconds REAL NOT NULL, valid_seconds REAL NOT NULL, valid_mean_seconds REAL, valid_m2_seconds REAL,
    favourite_laps INTEGER NOT NULL, favourite_seconds REAL NOT NULL, distance_laps INTEGER NOT NULL,
    distance_meters REAL NOT NULL, podium_first INTEGER NOT NULL, podium_second INTEGER NOT NULL,
    podium_third INTEGER NOT NULL, PRIMARY KEY(utc_day,game_id,car_key,track_key)
  )`,
  `CREATE TABLE IF NOT EXISTS dashboard_time_buckets (
    bucket_start_ms INTEGER NOT NULL, game_id TEXT NOT NULL, valid_laps INTEGER NOT NULL,
    positive_laps INTEGER NOT NULL, driven_seconds REAL NOT NULL, valid_seconds REAL NOT NULL,
    podium_first INTEGER NOT NULL, podium_second INTEGER NOT NULL, podium_third INTEGER NOT NULL,
    PRIMARY KEY(bucket_start_ms,game_id)
  )`,
  `CREATE TABLE IF NOT EXISTS dashboard_month_entities (
    utc_month TEXT NOT NULL, game_id TEXT NOT NULL, car_key TEXT NOT NULL, track_key TEXT NOT NULL,
    lap_count INTEGER NOT NULL, positive_laps INTEGER NOT NULL, valid_laps INTEGER NOT NULL,
    driven_seconds REAL NOT NULL, valid_seconds REAL NOT NULL, valid_mean_seconds REAL, valid_m2_seconds REAL,
    favourite_laps INTEGER NOT NULL, favourite_seconds REAL NOT NULL, distance_laps INTEGER NOT NULL,
    distance_meters REAL NOT NULL, podium_first INTEGER NOT NULL, podium_second INTEGER NOT NULL, podium_third INTEGER NOT NULL,
    PRIMARY KEY(utc_month,game_id,car_key,track_key)
  )`,
  `CREATE INDEX IF NOT EXISTS dashboard_day_entities_scope_idx ON dashboard_day_entities(game_id,utc_day)`,
  `CREATE INDEX IF NOT EXISTS dashboard_day_entities_track_idx ON dashboard_day_entities(game_id,track_key,utc_day)`,
  `CREATE INDEX IF NOT EXISTS dashboard_day_entities_car_idx ON dashboard_day_entities(game_id,car_key,utc_day)`,
  `CREATE INDEX IF NOT EXISTS dashboard_time_buckets_game_time_idx ON dashboard_time_buckets(game_id,bucket_start_ms)`,
  `CREATE INDEX IF NOT EXISTS dashboard_month_entities_scope_idx ON dashboard_month_entities(game_id,utc_month)`,
  `CREATE INDEX IF NOT EXISTS dashboard_month_entities_track_idx ON dashboard_month_entities(game_id,track_key,utc_month)`,
  `CREATE INDEX IF NOT EXISTS dashboard_month_entities_car_idx ON dashboard_month_entities(game_id,car_key,utc_month)`,
  `CREATE TABLE IF NOT EXISTS dashboard_session_index (
    session_id INTEGER PRIMARY KEY, created_at_ms INTEGER NOT NULL, game_id TEXT NOT NULL, ownership TEXT NOT NULL,
    car_id TEXT, track_id TEXT, session_type TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS dashboard_session_time_idx ON dashboard_session_index(created_at_ms,session_id)`,
  `CREATE INDEX IF NOT EXISTS dashboard_session_game_time_idx ON dashboard_session_index(game_id,created_at_ms,session_id)`,
  `CREATE TABLE IF NOT EXISTS dashboard_lap_index (
    lap_id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL, created_at_ms INTEGER NOT NULL,
    lap_time REAL NOT NULL, is_valid INTEGER NOT NULL, invalid_reason TEXT, sector_times TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS dashboard_lap_session_time_idx ON dashboard_lap_index(session_id,lap_time,lap_id)`,
  `CREATE INDEX IF NOT EXISTS dashboard_lap_session_created_idx ON dashboard_lap_index(session_id,created_at_ms,lap_id)`,
  `CREATE INDEX IF NOT EXISTS dashboard_lap_created_idx ON dashboard_lap_index(created_at_ms,session_id,lap_id)`,
  `DELETE FROM dashboard_session_index WHERE EXISTS (SELECT 1 FROM dashboard_projection_repair_needed)`,
  `DELETE FROM dashboard_lap_index WHERE EXISTS (SELECT 1 FROM dashboard_projection_repair_needed)`,
  `INSERT OR IGNORE INTO dashboard_session_index(session_id,created_at_ms,game_id,ownership,car_id,track_id,session_type)
   SELECT id,CAST(strftime('%s',created_at) AS INTEGER)*1000+CAST(substr(strftime('%f',created_at),4,3) AS INTEGER),
     game_id,ownership,car_id,track_id,session_type FROM sessions`,
  `CREATE TRIGGER IF NOT EXISTS dashboard_session_index_insert AFTER INSERT ON sessions BEGIN
    INSERT INTO dashboard_session_index(session_id,created_at_ms,game_id,ownership,car_id,track_id,session_type)
    VALUES (NEW.id,CAST(strftime('%s',NEW.created_at) AS INTEGER)*1000+CAST(substr(strftime('%f',NEW.created_at),4,3) AS INTEGER),
      NEW.game_id,NEW.ownership,NEW.car_id,NEW.track_id,NEW.session_type);
  END`,
  `CREATE TRIGGER IF NOT EXISTS dashboard_session_index_update AFTER UPDATE OF created_at,game_id,ownership,car_id,track_id,session_type ON sessions BEGIN
    UPDATE dashboard_session_index SET created_at_ms=CAST(strftime('%s',NEW.created_at) AS INTEGER)*1000+CAST(substr(strftime('%f',NEW.created_at),4,3) AS INTEGER),
      game_id=NEW.game_id,ownership=NEW.ownership,car_id=NEW.car_id,track_id=NEW.track_id,session_type=NEW.session_type WHERE session_id=NEW.id;
  END`,
  `CREATE TRIGGER IF NOT EXISTS dashboard_session_index_delete AFTER DELETE ON sessions BEGIN
    DELETE FROM dashboard_session_index WHERE session_id=OLD.id;
  END`,
  `INSERT OR IGNORE INTO dashboard_lap_index(lap_id,session_id,created_at_ms,lap_time,is_valid,invalid_reason,sector_times)
   SELECT id,session_id,CAST(strftime('%s',created_at) AS INTEGER)*1000+CAST(substr(strftime('%f',created_at),4,3) AS INTEGER),
     lap_time,is_valid,invalid_reason,sector_times FROM laps`,
  `DELETE FROM dashboard_session_summaries WHERE EXISTS (SELECT 1 FROM dashboard_projection_repair_needed)`,
  `CREATE TRIGGER IF NOT EXISTS dashboard_laps_insert AFTER INSERT ON laps BEGIN
    INSERT INTO dashboard_lap_index(lap_id,session_id,created_at_ms,lap_time,is_valid,invalid_reason,sector_times)
    VALUES (NEW.id,NEW.session_id,CAST(strftime('%s',NEW.created_at) AS INTEGER)*1000+CAST(substr(strftime('%f',NEW.created_at),4,3) AS INTEGER),
      NEW.lap_time,NEW.is_valid,NEW.invalid_reason,NEW.sector_times);
    INSERT INTO dashboard_summary_state(session_id,source_revision,metadata_dirty)
    SELECT NEW.session_id,1,1 WHERE EXISTS (SELECT 1 FROM sessions WHERE id=NEW.session_id AND ownership='mine')
      OR EXISTS (SELECT 1 FROM dashboard_summary_state WHERE session_id=NEW.session_id)
      OR EXISTS (SELECT 1 FROM dashboard_session_summaries WHERE session_id=NEW.session_id)
    ON CONFLICT(session_id) DO UPDATE SET source_revision=source_revision+1,metadata_dirty=1,updated_at=datetime('now');
  END`,
  `CREATE TRIGGER IF NOT EXISTS dashboard_laps_update AFTER UPDATE OF session_id,lap_time,is_valid,invalid_reason,created_at,sector_times ON laps
   WHEN OLD.session_id IS NOT NEW.session_id OR OLD.lap_time IS NOT NEW.lap_time OR OLD.is_valid IS NOT NEW.is_valid
     OR OLD.invalid_reason IS NOT NEW.invalid_reason OR OLD.created_at IS NOT NEW.created_at OR OLD.sector_times IS NOT NEW.sector_times
   BEGIN
     DELETE FROM dashboard_lap_index WHERE lap_id=OLD.id;
     INSERT INTO dashboard_lap_index(lap_id,session_id,created_at_ms,lap_time,is_valid,invalid_reason,sector_times)
     VALUES (NEW.id,NEW.session_id,CAST(strftime('%s',NEW.created_at) AS INTEGER)*1000+CAST(substr(strftime('%f',NEW.created_at),4,3) AS INTEGER),
       NEW.lap_time,NEW.is_valid,NEW.invalid_reason,NEW.sector_times);
     INSERT INTO dashboard_summary_state(session_id,source_revision,metadata_dirty)
     SELECT OLD.session_id,1,1 WHERE EXISTS (SELECT 1 FROM sessions WHERE id=OLD.session_id AND ownership='mine')
       OR EXISTS (SELECT 1 FROM dashboard_summary_state WHERE session_id=OLD.session_id)
       OR EXISTS (SELECT 1 FROM dashboard_session_summaries WHERE session_id=OLD.session_id)
     ON CONFLICT(session_id) DO UPDATE SET source_revision=source_revision+1,metadata_dirty=1,updated_at=datetime('now');
     INSERT INTO dashboard_summary_state(session_id,source_revision,metadata_dirty)
     SELECT NEW.session_id,1,1 WHERE NEW.session_id!=OLD.session_id AND
       (EXISTS (SELECT 1 FROM sessions WHERE id=NEW.session_id AND ownership='mine')
        OR EXISTS (SELECT 1 FROM dashboard_summary_state WHERE session_id=NEW.session_id)
        OR EXISTS (SELECT 1 FROM dashboard_session_summaries WHERE session_id=NEW.session_id))
     ON CONFLICT(session_id) DO UPDATE SET source_revision=source_revision+1,metadata_dirty=1,updated_at=datetime('now');
   END`,
  `CREATE TRIGGER IF NOT EXISTS dashboard_laps_delete AFTER DELETE ON laps BEGIN
     DELETE FROM dashboard_lap_index WHERE lap_id=OLD.id;
     INSERT INTO dashboard_summary_state(session_id,source_revision,metadata_dirty)
     SELECT OLD.session_id,1,1 WHERE EXISTS (SELECT 1 FROM sessions WHERE id=OLD.session_id AND ownership='mine')
       OR EXISTS (SELECT 1 FROM dashboard_summary_state WHERE session_id=OLD.session_id)
       OR EXISTS (SELECT 1 FROM dashboard_session_summaries WHERE session_id=OLD.session_id)
     ON CONFLICT(session_id) DO UPDATE SET source_revision=source_revision+1,metadata_dirty=1,updated_at=datetime('now');
   END`,
  `DELETE FROM dashboard_session_days WHERE EXISTS (SELECT 1 FROM dashboard_projection_repair_needed)`,
  `DELETE FROM dashboard_session_sectors WHERE EXISTS (SELECT 1 FROM dashboard_projection_repair_needed)`,
  `DELETE FROM dashboard_session_time_buckets WHERE EXISTS (SELECT 1 FROM dashboard_projection_repair_needed)`,
  `DELETE FROM dashboard_day_entities WHERE EXISTS (SELECT 1 FROM dashboard_projection_repair_needed)`,
  `DELETE FROM dashboard_time_buckets WHERE EXISTS (SELECT 1 FROM dashboard_projection_repair_needed)`,
  `DELETE FROM dashboard_month_entities WHERE EXISTS (SELECT 1 FROM dashboard_projection_repair_needed)`,
  `UPDATE dashboard_summary_state SET metadata_dirty=1,capture_dirty=1,processor_version=0,published_revision=0
   WHERE EXISTS (SELECT 1 FROM dashboard_projection_repair_needed)
     AND EXISTS (SELECT 1 FROM sessions WHERE sessions.id=dashboard_summary_state.session_id AND ownership='mine')`,
  `INSERT INTO dashboard_summary_state(session_id,source_revision,published_revision,processor_version,
     metadata_dirty,capture_dirty,deleted,capture_ready)
   SELECT id,1,0,0,1,1,0,1 FROM sessions WHERE ownership='mine'
     AND EXISTS (SELECT 1 FROM dashboard_projection_repair_needed)
   ON CONFLICT(session_id) DO NOTHING`,
  `DROP TABLE dashboard_projection_repair_needed`,
];
const dashboardMonthlyRollupSql = [
  `INSERT OR REPLACE INTO dashboard_month_entities
    (utc_month,game_id,car_key,track_key,lap_count,positive_laps,valid_laps,driven_seconds,valid_seconds,
     valid_mean_seconds,valid_m2_seconds,favourite_laps,favourite_seconds,distance_laps,distance_meters,podium_first,podium_second,podium_third)
   WITH day_means AS (
     SELECT substr(utc_day,1,7) utc_month,game_id,car_key,track_key,valid_laps,valid_mean_seconds,valid_m2_seconds,
       SUM(valid_laps) OVER (PARTITION BY substr(utc_day,1,7),game_id,car_key,track_key) total_n,
       SUM(valid_laps*COALESCE(valid_mean_seconds,0)) OVER (PARTITION BY substr(utc_day,1,7),game_id,car_key,track_key) total_sum
     FROM dashboard_day_entities
   ), month_means AS (
     SELECT utc_month,game_id,car_key,track_key,total_n,total_sum,total_sum/NULLIF(total_n,0) mean
     FROM day_means GROUP BY utc_month,game_id,car_key,track_key
   ), month_variance AS (
     SELECT d.utc_month,d.game_id,d.car_key,d.track_key,
       SUM(COALESCE(d.valid_m2_seconds,0)+d.valid_laps*(COALESCE(d.valid_mean_seconds,0)-m.mean)*(COALESCE(d.valid_mean_seconds,0)-m.mean)) m2
     FROM day_means d JOIN month_means m USING(utc_month,game_id,car_key,track_key)
     GROUP BY d.utc_month,d.game_id,d.car_key,d.track_key
   )
   SELECT substr(d.utc_day,1,7),d.game_id,d.car_key,d.track_key,SUM(d.lap_count),SUM(d.positive_laps),SUM(d.valid_laps),
     SUM(d.driven_seconds),SUM(d.valid_seconds),m.mean,v.m2,
     SUM(d.favourite_laps),SUM(d.favourite_seconds),SUM(d.distance_laps),SUM(d.distance_meters),
     SUM(d.podium_first),SUM(d.podium_second),SUM(d.podium_third)
   FROM dashboard_day_entities d JOIN month_means m ON m.utc_month=substr(d.utc_day,1,7)
     AND m.game_id=d.game_id AND m.car_key=d.car_key AND m.track_key=d.track_key
   JOIN month_variance v ON v.utc_month=m.utc_month AND v.game_id=m.game_id AND v.car_key=m.car_key AND v.track_key=m.track_key
   GROUP BY substr(d.utc_day,1,7),d.game_id,d.car_key,d.track_key`,
];


const sqlText = (value: string): string => `'${value.replaceAll("'", "''")}'`;
const sourceName = (value: string): string => value.trim().normalize("NFC").toLowerCase();
const acEvoCatalogSeedSql = [
  `INSERT OR IGNORE INTO discovered_cars (game_id, ordinal, name, model, source_key) VALUES ${
    acEvoCars.map((car) =>
      `('ac-evo', ${car.id}, ${sqlText(car.name)}, ${sqlText(car.model)}, ${sqlText(JSON.stringify([sourceName(car.name)]))})`
    ).join(",\n")
  }`,
  `INSERT OR IGNORE INTO discovered_tracks (game_id, ordinal, name, source_key, track_name, track_configuration) VALUES ${
    acEvoTracks.map((track) =>
      `('ac-evo', ${track.id}, ${sqlText(track.name)}, ${sqlText(JSON.stringify([sourceName(track.name), sourceName(track.variant)]))}, ${sqlText(track.name)}, ${sqlText(track.variant)})`
    ).join(",\n")
  }`,
  `INSERT OR IGNORE INTO discovered_tracks (game_id, ordinal, name, source_key, track_name, track_configuration)
   SELECT 'ac-evo', MAX(100000, COALESCE(MAX(ordinal), 99999) + 1), 'Nurburgring - Touristenfahrten',
     json_array('nurburgring', 'touristenfahrten'), 'Nurburgring', 'Touristenfahrten'
   FROM discovered_tracks WHERE game_id = 'ac-evo'`,
  `UPDATE discovered_tracks SET track_name = 'Nurburgring', track_configuration = 'Touristenfahrten'
   WHERE game_id = 'ac-evo' AND source_key = json_array('nurburgring', 'touristenfahrten')
     AND track_name IS NULL`,
];



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
  {
    version: 21,
    name: "add game_id to tunes",
    sql: [
      `ALTER TABLE tunes ADD COLUMN game_id TEXT NOT NULL DEFAULT 'fm-2023'`,
      `CREATE INDEX IF NOT EXISTS idx_tunes_game_car ON tunes(game_id, car_ordinal)`,
    ],
  },
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
  {
    version: 26,
    name: "explicit lap to tuning-session link",
    sql: [
      `ALTER TABLE laps ADD COLUMN tuning_session_id INTEGER`,
      `CREATE INDEX IF NOT EXISTS idx_laps_tuning_session ON laps(tuning_session_id)`,
    ],
  },
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
  {
    version: 28,
    name: "tuning-session head test id",
    sql: [
      `ALTER TABLE tuning_sessions ADD COLUMN head_test_id INTEGER`,
    ],
  },
  {
    version: 29,
    name: "explicit lap to tuning-test link",
    sql: [
      `ALTER TABLE laps ADD COLUMN tuning_test_id INTEGER`,
      `CREATE INDEX IF NOT EXISTS idx_laps_tuning_test ON laps(tuning_test_id)`,
    ],
  },
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
  {
    version: 31,
    name: "engineer notes on version nodes",
    sql: [`ALTER TABLE tuning_tests ADD COLUMN notes TEXT`],
  },
  {
    version: 32,
    name: "persisted per-lap fuel/tyre metrics",
    sql: [
      `ALTER TABLE laps ADD COLUMN fuel_per_lap REAL`,
      `ALTER TABLE laps ADD COLUMN tyre_wear REAL`,
    ],
  },
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
  {
    version: 34,
    name: "auto-exclude source tracking for fastest-5 curation",
    sql: [
      `ALTER TABLE laps ADD COLUMN tuning_excluded_source TEXT`,
      `UPDATE laps SET tuning_excluded_source = 'manual' WHERE tuning_excluded = 1`,
    ],
  },
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
  {
    version: 46,
    name: "dynamic source-defined sector times",
    sql: [
      // Version 15 introduced these source columns on every supported history.
      // Keep them while converting to the authoritative ordered-array representation.
      `ALTER TABLE laps ADD COLUMN sector_times TEXT`,
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
  {
    version: 49,
    name: "version race result processor",
    sql: [
      `ALTER TABLE session_results ADD COLUMN processor_version TEXT NOT NULL DEFAULT 'race-result-v1'`,
    ],
  },
  {
    version: 50,
    name: "persist race timeline positions",
    sql: [
      `ALTER TABLE pit_events ADD COLUMN event_type TEXT NOT NULL DEFAULT 'pit'`,
      `ALTER TABLE pit_events ADD COLUMN position_before INTEGER`,
      `ALTER TABLE pit_events ADD COLUMN position_after INTEGER`,
    ],
  },
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
  {
    version: 52,
    name: "version race result processor",
    sql: [
      `ALTER TABLE session_results ADD COLUMN processor_version TEXT NOT NULL DEFAULT 'legacy-race-result-v0'`,
    ],
  },
  {
    version: 53,
    name: "persist race timeline positions",
    sql: [
      `ALTER TABLE pit_events ADD COLUMN event_type TEXT NOT NULL DEFAULT 'pit'`,
      `ALTER TABLE pit_events ADD COLUMN position_before INTEGER`,
      `ALTER TABLE pit_events ADD COLUMN position_after INTEGER`,
    ],
  },
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
  {
    version: 56,
    name: "persist race result outcome status",
    sql: [
      `ALTER TABLE session_results ADD COLUMN outcome_status TEXT NOT NULL DEFAULT 'unavailable'`,
    ],
  },
  {
    version: 57,
    name: "persist race result evidence",
    sql: [
      `ALTER TABLE session_results ADD COLUMN evidence TEXT`,
    ],
  },
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
  {
    version: 59,
    name: "persist LMU session string identity",
    sql: [
      `ALTER TABLE sessions ADD COLUMN car_id TEXT`,
      `ALTER TABLE sessions ADD COLUMN track_id TEXT`,
      `CREATE INDEX IF NOT EXISTS idx_sessions_game_car_id
       ON sessions(game_id, car_id)`,
      `CREATE INDEX IF NOT EXISTS idx_sessions_game_track_id
       ON sessions(game_id, track_id)`,
    ],
  },
  {
    version: 60,
    name: "persist session/lap favorites",
    sql: [
      `ALTER TABLE sessions ADD COLUMN is_favorite INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE laps ADD COLUMN is_favorite INTEGER NOT NULL DEFAULT 0`,
    ],
  },
  {
    version: 61,
    name: "version static lap analysis",
    sql: [
      `ALTER TABLE lap_metrics ADD COLUMN insight_version INTEGER NOT NULL DEFAULT 0`,
    ],
  },
  {
    version: 62,
    name: "version session capture storage",
    sql: [
      `ALTER TABLE sessions ADD COLUMN capture_format_version INTEGER`,
    ],
  },
  {
    version: 63,
    name: "persist discovered source identities",
    sql: [
      `ALTER TABLE discovered_cars ADD COLUMN source_key TEXT`,
      `ALTER TABLE discovered_tracks ADD COLUMN source_key TEXT`,
      `ALTER TABLE discovered_tracks ADD COLUMN track_name TEXT`,
      `ALTER TABLE discovered_tracks ADD COLUMN track_configuration TEXT`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_discovered_cars_game_source
       ON discovered_cars(game_id, source_key)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_discovered_tracks_game_source
       ON discovered_tracks(game_id, source_key)`,
      `UPDATE discovered_cars AS current SET source_key = json_array(lower(trim(current.name)))
       WHERE current.game_id = 'ac-evo' AND current.source_key IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM discovered_cars AS prior
           WHERE prior.game_id = current.game_id
             AND json_array(lower(trim(prior.name))) = json_array(lower(trim(current.name)))
             AND prior.id < current.id
         )`,
      `UPDATE discovered_tracks AS current SET track_name = current.name, track_configuration = '',
         source_key = json_array(lower(trim(current.name)), '')
       WHERE current.game_id = 'ac-evo' AND current.source_key IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM discovered_tracks AS prior
           WHERE prior.game_id = current.game_id
             AND json_array(lower(trim(prior.name)), '') = json_array(lower(trim(current.name)), '')
             AND prior.id < current.id
         )`,
      ...acEvoCatalogSeedSql,
    ],
  },
  {
    version: 64,
    name: "use native AC Evo car and layout identities",
    sql: [
      `ALTER TABLE tunes ADD COLUMN car_id TEXT`,
      `ALTER TABLE tunes ADD COLUMN track_id TEXT`,
      `ALTER TABLE experiments ADD COLUMN car_id TEXT`,
      `ALTER TABLE experiments ADD COLUMN track_id TEXT`,
      `ALTER TABLE community_tunes ADD COLUMN car_id TEXT`,
      `ALTER TABLE community_tunes ADD COLUMN track_id TEXT`,
      ...["driver_profiles", "driver_profile_runs"].flatMap((table) => [
        `ALTER TABLE ${table} ADD COLUMN car_id TEXT`,
        `ALTER TABLE ${table} ADD COLUMN track_id TEXT`,
      ]),
      `CREATE TABLE tune_assignments_native (
        id INTEGER PRIMARY KEY AUTOINCREMENT, game_id TEXT NOT NULL,
        car_ordinal INTEGER NOT NULL, track_ordinal INTEGER NOT NULL,
        car_id TEXT, track_id TEXT,
        tune_id INTEGER NOT NULL REFERENCES tunes(id) ON DELETE CASCADE
      )`,
      `INSERT INTO tune_assignments_native (id,game_id,car_ordinal,track_ordinal,tune_id)
       SELECT id,game_id,car_ordinal,track_ordinal,tune_id FROM tune_assignments`,
      `DROP TABLE tune_assignments`,
      `ALTER TABLE tune_assignments_native RENAME TO tune_assignments`,
      `CREATE INDEX idx_assignments_tune ON tune_assignments(tune_id)`,
      `CREATE TABLE track_outlines_native (
        id INTEGER PRIMARY KEY AUTOINCREMENT, track_ordinal INTEGER NOT NULL,
        game_id TEXT NOT NULL, track_id TEXT, outline BLOB NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
      `INSERT INTO track_outlines_native (id,track_ordinal,game_id,outline,created_at)
       SELECT id,track_ordinal,game_id,outline,created_at FROM track_outlines`,
      `DROP TABLE track_outlines`,
      `ALTER TABLE track_outlines_native RENAME TO track_outlines`,
      `CREATE INDEX idx_outlines_track ON track_outlines(track_ordinal)`,
      `CREATE TABLE track_corners_native (
        id INTEGER PRIMARY KEY AUTOINCREMENT, track_ordinal INTEGER NOT NULL,
        game_id TEXT NOT NULL, track_id TEXT, corner_index INTEGER NOT NULL,
        label TEXT NOT NULL, distance_start REAL NOT NULL, distance_end REAL NOT NULL,
        is_auto INTEGER NOT NULL DEFAULT 1
      )`,
      `INSERT INTO track_corners_native (id,track_ordinal,game_id,corner_index,label,distance_start,distance_end,is_auto)
       SELECT id,track_ordinal,game_id,corner_index,label,distance_start,distance_end,is_auto FROM track_corners`,
      `DROP TABLE track_corners`,
      `ALTER TABLE track_corners_native RENAME TO track_corners`,
      `CREATE INDEX idx_corners_track ON track_corners(track_ordinal)`,
      ...["sessions", "tunes", "tune_assignments", "experiments", "community_tunes", "driver_profiles", "driver_profile_runs"].map((table) =>
        `UPDATE ${table} SET car_id = COALESCE(car_id, (
          SELECT trim(name) FROM discovered_cars
          WHERE game_id = 'ac-evo' AND ordinal = ${table}.car_ordinal
        )) WHERE game_id = 'ac-evo'`),
      ...["sessions", "tunes", "tune_assignments", "track_outlines", "track_corners", "experiments", "community_tunes", "driver_profiles", "driver_profile_runs"].map((table) =>
        `UPDATE ${table} SET track_id = COALESCE(track_id, (
          SELECT json_array(trim(track_name), trim(COALESCE(track_configuration, '')))
          FROM discovered_tracks
          WHERE game_id = 'ac-evo' AND ordinal = ${table}.track_ordinal
            AND track_name IS NOT NULL
        )) WHERE game_id = 'ac-evo'`),
      `CREATE UNIQUE INDEX idx_assignments_ordinal ON tune_assignments(game_id,car_ordinal,track_ordinal)
       WHERE car_id IS NULL AND track_id IS NULL`,
      `CREATE INDEX idx_assignments_native ON tune_assignments(game_id,car_id,track_id)
       WHERE car_id IS NOT NULL AND track_id IS NOT NULL`,
      `CREATE UNIQUE INDEX idx_outlines_ordinal ON track_outlines(track_ordinal,game_id) WHERE track_id IS NULL`,
      `CREATE INDEX idx_outlines_native ON track_outlines(track_id,game_id) WHERE track_id IS NOT NULL`,
      `CREATE UNIQUE INDEX idx_corners_ordinal ON track_corners(track_ordinal,game_id,corner_index) WHERE track_id IS NULL`,
      `CREATE INDEX idx_corners_native ON track_corners(track_id,game_id,corner_index) WHERE track_id IS NOT NULL`,
    ],
  },
  {
    version: 65,
    name: "stop allocating AC Evo discovery ordinals",
    sql: [
      `CREATE TABLE discovered_cars_native (
        id INTEGER PRIMARY KEY AUTOINCREMENT, game_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
        name TEXT NOT NULL, model TEXT NOT NULL DEFAULT '', source_key TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(game_id,source_key)
      )`,
      `INSERT INTO discovered_cars_native SELECT id,game_id,
        CASE WHEN game_id = 'ac-evo' THEN -1 ELSE ordinal END,name,model,
        CASE WHEN game_id = 'ac-evo' THEN
          CASE WHEN EXISTS (SELECT 1 FROM discovered_cars prior WHERE prior.game_id = 'ac-evo'
            AND prior.id < current.id AND trim(prior.name) = trim(current.name))
          THEN NULL ELSE trim(name) END
        ELSE source_key END,created_at FROM discovered_cars current`,
      `DROP TABLE discovered_cars`,
      `ALTER TABLE discovered_cars_native RENAME TO discovered_cars`,
      `CREATE UNIQUE INDEX idx_discovered_cars_ordinal ON discovered_cars(game_id,ordinal) WHERE ordinal >= 0`,
      `CREATE TABLE discovered_tracks_native (
        id INTEGER PRIMARY KEY AUTOINCREMENT, game_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
        name TEXT NOT NULL, source_key TEXT, track_name TEXT, track_configuration TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(game_id,source_key)
      )`,
      `INSERT INTO discovered_tracks_native SELECT id,game_id,
        CASE WHEN game_id = 'ac-evo' THEN -1 ELSE ordinal END,name,
        CASE WHEN game_id = 'ac-evo' THEN
          CASE WHEN EXISTS (SELECT 1 FROM discovered_tracks prior WHERE prior.game_id = 'ac-evo'
            AND prior.id < current.id
            AND trim(COALESCE(prior.track_name,prior.name)) = trim(COALESCE(current.track_name,current.name))
            AND trim(COALESCE(prior.track_configuration,'')) = trim(COALESCE(current.track_configuration,'')))
          THEN NULL ELSE json_array(trim(COALESCE(track_name,name)),trim(COALESCE(track_configuration,''))) END
        ELSE source_key END,
        track_name,track_configuration,created_at FROM discovered_tracks current`,
      `DROP TABLE discovered_tracks`,
      `ALTER TABLE discovered_tracks_native RENAME TO discovered_tracks`,
      `CREATE UNIQUE INDEX idx_discovered_tracks_ordinal ON discovered_tracks(game_id,ordinal) WHERE ordinal >= 0`,
    ],
  },
  {
    version: 66,
    name: "consolidate game identities into string IDs",
    sql: [
      ...["sessions", "tunes", "tune_assignments", "experiments", "community_tunes", "driver_profiles", "driver_profile_runs"].map((table) =>
        `UPDATE ${table} SET car_id = COALESCE(car_id,
          CASE WHEN car_ordinal IS NULL THEN NULL
            WHEN game_id = 'ac-evo' THEN '' ELSE CAST(car_ordinal AS TEXT) END)`),
      ...["sessions", "tunes", "tune_assignments", "track_outlines", "track_corners", "experiments", "community_tunes", "driver_profiles", "driver_profile_runs"].map((table) =>
        `UPDATE ${table} SET track_id = COALESCE(track_id,
          CASE WHEN track_ordinal IS NULL THEN NULL
            WHEN game_id = 'ac-evo' THEN '' ELSE CAST(track_ordinal AS TEXT) END)`),
      `DELETE FROM driver_profiles AS current WHERE EXISTS (
        SELECT 1 FROM driver_profiles newer WHERE newer.game_id = current.game_id
          AND newer.car_id IS current.car_id AND newer.track_id IS current.track_id
          AND newer.id > current.id)`,
      ...["driver_profiles", "driver_profile_runs"].map((table) =>
        `UPDATE ${table} SET scope_key = json_array(game_id, car_id, track_id)`),
      `DROP INDEX IF EXISTS idx_tunes_car`,
      `DROP INDEX IF EXISTS idx_tunes_game_car`,
      `DROP INDEX IF EXISTS idx_assignments_ordinal`,
      `DROP INDEX IF EXISTS idx_assignments_native`,
      `DROP INDEX IF EXISTS idx_outlines_ordinal`,
      `DROP INDEX IF EXISTS idx_outlines_native`,
      `DROP INDEX IF EXISTS idx_corners_ordinal`,
      `DROP INDEX IF EXISTS idx_corners_native`,
      `DROP INDEX IF EXISTS idx_outlines_track`,
      `DROP INDEX IF EXISTS idx_corners_track`,
      ...["sessions", "tunes", "tune_assignments", "experiments", "community_tunes", "driver_profiles", "driver_profile_runs"].map((table) =>
        `ALTER TABLE ${table} DROP COLUMN car_ordinal`),
      ...["sessions", "tunes", "tune_assignments", "track_outlines", "track_corners", "experiments", "community_tunes", "driver_profiles", "driver_profile_runs"].map((table) =>
        `ALTER TABLE ${table} DROP COLUMN track_ordinal`),
      `DELETE FROM tune_assignments AS current WHERE car_id != '' AND track_id != ''
        AND EXISTS (SELECT 1 FROM tune_assignments newer WHERE newer.game_id = current.game_id
          AND newer.car_id = current.car_id AND newer.track_id = current.track_id AND newer.id > current.id)`,
      `DELETE FROM track_outlines AS current WHERE track_id != ''
        AND EXISTS (SELECT 1 FROM track_outlines newer WHERE newer.game_id = current.game_id
          AND newer.track_id = current.track_id AND newer.id > current.id)`,
      `DELETE FROM track_corners AS current WHERE track_id != ''
        AND EXISTS (SELECT 1 FROM track_corners newer WHERE newer.game_id = current.game_id
          AND newer.track_id = current.track_id AND newer.corner_index = current.corner_index AND newer.id > current.id)`,
      `CREATE INDEX idx_tunes_car ON tunes(car_id)`,
      `CREATE INDEX idx_tunes_game_car ON tunes(game_id,car_id)`,
      `CREATE UNIQUE INDEX idx_assignments_identity ON tune_assignments(game_id,car_id,track_id)
        WHERE car_id != '' AND track_id != ''`,
      `CREATE UNIQUE INDEX idx_outlines_identity ON track_outlines(track_id,game_id) WHERE track_id != ''`,
      `CREATE UNIQUE INDEX idx_corners_identity ON track_corners(track_id,game_id,corner_index) WHERE track_id != ''`,
      `CREATE INDEX idx_outlines_track ON track_outlines(track_id)`,
      `CREATE INDEX idx_corners_track ON track_corners(track_id)`,
      `CREATE TABLE discovered_cars_identity (
        id INTEGER PRIMARY KEY AUTOINCREMENT, game_id TEXT NOT NULL, car_id TEXT NOT NULL,
        name TEXT NOT NULL, model TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(game_id,car_id)
      )`,
      `INSERT OR IGNORE INTO discovered_cars_identity
        SELECT id,game_id,CASE WHEN game_id = 'ac-evo' THEN trim(name) ELSE CAST(ordinal AS TEXT) END,
          name,model,created_at FROM discovered_cars ORDER BY id`,
      `DROP TABLE discovered_cars`,
      `ALTER TABLE discovered_cars_identity RENAME TO discovered_cars`,
      `CREATE TABLE discovered_tracks_identity (
        id INTEGER PRIMARY KEY AUTOINCREMENT, game_id TEXT NOT NULL, track_id TEXT NOT NULL,
        name TEXT NOT NULL, track_name TEXT, track_configuration TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(game_id,track_id)
      )`,
      `INSERT OR IGNORE INTO discovered_tracks_identity
        SELECT id,game_id,CASE WHEN game_id = 'ac-evo'
          THEN json_array(trim(COALESCE(track_name,name)),trim(COALESCE(track_configuration,'')))
          ELSE CAST(ordinal AS TEXT) END,name,track_name,track_configuration,created_at
        FROM discovered_tracks ORDER BY id`,
      `DROP TABLE discovered_tracks`,
      `ALTER TABLE discovered_tracks_identity RENAME TO discovered_tracks`,
    ],
  },
  {
    version: 67,
    name: "reconcile historical sessions with current lap detectors",
    sql: [
      `UPDATE sessions SET lap_detector_version = NULL`,
    ],
  },
  {
    version: 68,
    name: "add dashboard read model",
    sql: [
      `CREATE TABLE dashboard_summary_state (
        session_id INTEGER PRIMARY KEY,
        source_revision INTEGER NOT NULL DEFAULT 1,
        published_revision INTEGER NOT NULL DEFAULT 0,
        processor_version INTEGER NOT NULL DEFAULT 0,
        metadata_dirty INTEGER NOT NULL DEFAULT 1,
        capture_dirty INTEGER NOT NULL DEFAULT 1,
        deleted INTEGER NOT NULL DEFAULT 0,
        last_error_code TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
      `CREATE TABLE dashboard_session_summaries (
        session_id INTEGER PRIMARY KEY,
        source_revision INTEGER NOT NULL,
        processor_version INTEGER NOT NULL,
        game_id TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        car_key TEXT,
        track_key TEXT,
        car_id TEXT,
        track_id TEXT,
        session_type TEXT,
        lap_count INTEGER NOT NULL,
        positive_laps INTEGER NOT NULL,
        valid_laps INTEGER NOT NULL,
        driven_seconds REAL NOT NULL,
        valid_seconds REAL NOT NULL,
        best_lap_seconds REAL,
        elapsed_seconds REAL,
        sector_layout_key TEXT,
        sector_count INTEGER,
        podium_position INTEGER NOT NULL DEFAULT 0,
        capture_revision TEXT,
        weather_revision TEXT
      )`,
      `CREATE TABLE dashboard_session_days (
        session_id INTEGER NOT NULL,
        utc_day TEXT NOT NULL,
        game_id TEXT NOT NULL,
        car_key TEXT NOT NULL DEFAULT '',
        track_key TEXT NOT NULL DEFAULT '',
        lap_count INTEGER NOT NULL,
        positive_laps INTEGER NOT NULL,
        valid_laps INTEGER NOT NULL,
        driven_seconds REAL NOT NULL,
        valid_seconds REAL NOT NULL,
        best_lap_seconds REAL,
        mean_lap_seconds REAL,
        m2_lap_seconds REAL,
        podium_first INTEGER NOT NULL DEFAULT 0,
        podium_second INTEGER NOT NULL DEFAULT 0,
        podium_third INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(session_id, utc_day, game_id, car_key, track_key)
      )`,
      `CREATE TABLE dashboard_session_sectors (
        session_id INTEGER NOT NULL,
        layout_key TEXT NOT NULL,
        sector_index INTEGER NOT NULL,
        best_seconds REAL NOT NULL,
        PRIMARY KEY(session_id, layout_key, sector_index)
      )`,
      `CREATE TABLE dashboard_session_time_buckets (
        session_id INTEGER NOT NULL,
        bucket_start_ms INTEGER NOT NULL,
        game_id TEXT NOT NULL,
        valid_laps INTEGER NOT NULL,
        positive_laps INTEGER NOT NULL,
        driven_seconds REAL NOT NULL,
        podium_first INTEGER NOT NULL DEFAULT 0,
        valid_seconds REAL NOT NULL DEFAULT 0,
        podium_second INTEGER NOT NULL DEFAULT 0,
        podium_third INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(session_id, bucket_start_ms, game_id)
      )`,
      `CREATE TABLE dashboard_lap_index (
        lap_id INTEGER PRIMARY KEY,
        session_id INTEGER NOT NULL,
        created_at_ms INTEGER NOT NULL,
        lap_time REAL NOT NULL,
        is_valid INTEGER NOT NULL,
        invalid_reason TEXT,
        sector_times TEXT
      )`,
      `CREATE INDEX dashboard_state_work_idx
        ON dashboard_summary_state(metadata_dirty, source_revision, session_id)`,
      `CREATE INDEX dashboard_summary_game_time_idx
        ON dashboard_session_summaries(game_id, created_at_ms DESC, session_id DESC)`,
      `CREATE INDEX dashboard_summary_time_idx
        ON dashboard_session_summaries(created_at_ms DESC, session_id DESC)`,
      `CREATE INDEX dashboard_days_game_day_idx
        ON dashboard_session_days(game_id, utc_day, session_id)`,
      `CREATE INDEX dashboard_days_track_idx
        ON dashboard_session_days(game_id, track_key, utc_day)`,
      `CREATE INDEX dashboard_days_car_idx
        ON dashboard_session_days(game_id, car_key, utc_day)`,
      `CREATE INDEX dashboard_lap_session_time_idx
        ON dashboard_lap_index(session_id, lap_time, lap_id)`,
      `CREATE INDEX dashboard_lap_session_created_idx
        ON dashboard_lap_index(session_id, created_at_ms, lap_id)`,
      `CREATE INDEX dashboard_lap_created_idx
        ON dashboard_lap_index(created_at_ms, session_id, lap_id)`,
      `INSERT INTO dashboard_summary_state(session_id, source_revision, metadata_dirty, capture_dirty)
        SELECT id, 1, 1, 1 FROM sessions WHERE ownership='mine'`,
      `INSERT INTO dashboard_lap_index(lap_id, session_id, created_at_ms, lap_time, is_valid, invalid_reason, sector_times)
        SELECT id, session_id,
          CAST(strftime('%s', created_at) AS INTEGER) * 1000 + CAST(substr(strftime('%f', created_at), 4, 3) AS INTEGER),
          lap_time, is_valid, invalid_reason, sector_times FROM laps`,
      `CREATE TRIGGER dashboard_sessions_insert AFTER INSERT ON sessions
        WHEN NEW.ownership='mine'
      BEGIN
        INSERT INTO dashboard_summary_state(session_id, source_revision, metadata_dirty, capture_dirty, deleted)
        VALUES (NEW.id, 1, 1, 1, 0)
        ON CONFLICT(session_id) DO UPDATE SET source_revision=source_revision+1,
          metadata_dirty=1, capture_dirty=1, deleted=0, updated_at=datetime('now');
      END`,
      `CREATE TRIGGER dashboard_sessions_update AFTER UPDATE OF
        ownership, game_id, created_at, car_id, track_id,
        session_type, raw_file, source, capture_format_version ON sessions
        WHEN OLD.ownership IS NOT NEW.ownership OR OLD.game_id IS NOT NEW.game_id
          OR OLD.created_at IS NOT NEW.created_at OR OLD.car_id IS NOT NEW.car_id
          OR OLD.track_id IS NOT NEW.track_id OR OLD.session_type IS NOT NEW.session_type
          OR OLD.raw_file IS NOT NEW.raw_file OR OLD.source IS NOT NEW.source
          OR OLD.capture_format_version IS NOT NEW.capture_format_version
      BEGIN
        INSERT INTO dashboard_summary_state(session_id, source_revision, metadata_dirty, capture_dirty)
        SELECT NEW.id, 1, 1, CASE WHEN OLD.raw_file IS NOT NEW.raw_file
          OR OLD.source IS NOT NEW.source OR OLD.capture_format_version IS NOT NEW.capture_format_version THEN 1 ELSE 0 END
        WHERE NEW.ownership='mine' OR OLD.ownership='mine'
          OR EXISTS (SELECT 1 FROM dashboard_summary_state WHERE session_id=OLD.id)
          OR EXISTS (SELECT 1 FROM dashboard_session_summaries WHERE session_id=OLD.id)
        ON CONFLICT(session_id) DO UPDATE SET source_revision=source_revision+1, metadata_dirty=1,
          capture_dirty=CASE WHEN OLD.raw_file IS NOT NEW.raw_file OR OLD.source IS NOT NEW.source
            OR OLD.capture_format_version IS NOT NEW.capture_format_version THEN 1 ELSE dashboard_summary_state.capture_dirty END,
          updated_at=datetime('now');
      END`,
      `CREATE TRIGGER dashboard_sessions_delete BEFORE DELETE ON sessions
        WHEN OLD.ownership='mine'
          OR EXISTS (SELECT 1 FROM dashboard_summary_state WHERE session_id=OLD.id)
          OR EXISTS (SELECT 1 FROM dashboard_session_summaries WHERE session_id=OLD.id)
      BEGIN
        INSERT INTO dashboard_summary_state(session_id, source_revision, metadata_dirty, capture_dirty, deleted)
        VALUES (OLD.id, 1, 1, 1, 1)
        ON CONFLICT(session_id) DO UPDATE SET source_revision=source_revision+1,
          metadata_dirty=1, capture_dirty=1, deleted=1, updated_at=datetime('now');
      END`,
      `CREATE TRIGGER dashboard_laps_insert AFTER INSERT ON laps BEGIN
        INSERT INTO dashboard_lap_index(lap_id, session_id, created_at_ms, lap_time, is_valid, invalid_reason, sector_times)
        VALUES (NEW.id, NEW.session_id, CAST(strftime('%s', NEW.created_at) AS INTEGER) * 1000 + CAST(substr(strftime('%f', NEW.created_at), 4, 3) AS INTEGER),
          NEW.lap_time, NEW.is_valid, NEW.invalid_reason, NEW.sector_times);
        INSERT INTO dashboard_summary_state(session_id, source_revision, metadata_dirty, capture_dirty)
        SELECT NEW.session_id, 1, 1, 1 WHERE EXISTS (SELECT 1 FROM sessions WHERE id=NEW.session_id AND ownership='mine')
          OR EXISTS (SELECT 1 FROM dashboard_summary_state WHERE session_id=NEW.session_id)
          OR EXISTS (SELECT 1 FROM dashboard_session_summaries WHERE session_id=NEW.session_id)
        ON CONFLICT(session_id) DO UPDATE SET source_revision=source_revision+1,
          metadata_dirty=1, capture_dirty=1, updated_at=datetime('now');
      END`,
      `CREATE TRIGGER dashboard_laps_update AFTER UPDATE OF session_id, lap_time, is_valid, invalid_reason, created_at, sector_times ON laps
        WHEN OLD.session_id IS NOT NEW.session_id OR OLD.lap_time IS NOT NEW.lap_time
          OR OLD.is_valid IS NOT NEW.is_valid OR OLD.invalid_reason IS NOT NEW.invalid_reason
          OR OLD.created_at IS NOT NEW.created_at OR OLD.sector_times IS NOT NEW.sector_times
      BEGIN
        DELETE FROM dashboard_lap_index WHERE lap_id=OLD.id;
        INSERT INTO dashboard_lap_index(lap_id, session_id, created_at_ms, lap_time, is_valid, invalid_reason, sector_times)
        VALUES (NEW.id, NEW.session_id, CAST(strftime('%s', NEW.created_at) AS INTEGER) * 1000 + CAST(substr(strftime('%f', NEW.created_at), 4, 3) AS INTEGER),
          NEW.lap_time, NEW.is_valid, NEW.invalid_reason, NEW.sector_times);
        INSERT INTO dashboard_summary_state(session_id, source_revision, metadata_dirty, capture_dirty)
        SELECT OLD.session_id, 1, 1, 1 WHERE EXISTS (SELECT 1 FROM sessions WHERE id=OLD.session_id AND ownership='mine')
          OR EXISTS (SELECT 1 FROM dashboard_summary_state WHERE session_id=OLD.session_id)
          OR EXISTS (SELECT 1 FROM dashboard_session_summaries WHERE session_id=OLD.session_id)
        ON CONFLICT(session_id) DO UPDATE SET source_revision=source_revision+1, metadata_dirty=1,
          capture_dirty=1, updated_at=datetime('now');
        INSERT INTO dashboard_summary_state(session_id, source_revision, metadata_dirty, capture_dirty)
        SELECT NEW.session_id, 1, 1, 1 WHERE NEW.session_id != OLD.session_id AND (
          EXISTS (SELECT 1 FROM sessions WHERE id=NEW.session_id AND ownership='mine')
          OR EXISTS (SELECT 1 FROM dashboard_summary_state WHERE session_id=NEW.session_id)
          OR EXISTS (SELECT 1 FROM dashboard_session_summaries WHERE session_id=NEW.session_id))
        ON CONFLICT(session_id) DO UPDATE SET source_revision=source_revision+1, metadata_dirty=1,
          capture_dirty=1, updated_at=datetime('now');
      END`,
      `CREATE TRIGGER dashboard_laps_delete AFTER DELETE ON laps BEGIN
        DELETE FROM dashboard_lap_index WHERE lap_id=OLD.id;
        INSERT INTO dashboard_summary_state(session_id, source_revision, metadata_dirty, capture_dirty)
        SELECT OLD.session_id, 1, 1, 1 WHERE EXISTS (SELECT 1 FROM sessions WHERE id=OLD.session_id AND ownership='mine')
          OR EXISTS (SELECT 1 FROM dashboard_summary_state WHERE session_id=OLD.session_id)
          OR EXISTS (SELECT 1 FROM dashboard_session_summaries WHERE session_id=OLD.session_id)
        ON CONFLICT(session_id) DO UPDATE SET source_revision=source_revision+1,
          metadata_dirty=1, capture_dirty=1, updated_at=datetime('now');
      END`,
      `CREATE TRIGGER dashboard_results_insert AFTER INSERT ON session_results BEGIN
        INSERT INTO dashboard_summary_state(session_id, source_revision, metadata_dirty)
        SELECT NEW.session_id, 1, 1 WHERE EXISTS (SELECT 1 FROM sessions WHERE id=NEW.session_id AND ownership='mine')
          OR EXISTS (SELECT 1 FROM dashboard_summary_state WHERE session_id=NEW.session_id)
          OR EXISTS (SELECT 1 FROM dashboard_session_summaries WHERE session_id=NEW.session_id)
        ON CONFLICT(session_id) DO UPDATE SET source_revision=source_revision+1, metadata_dirty=1, updated_at=datetime('now');
      END`,
      `CREATE TRIGGER dashboard_results_update AFTER UPDATE OF session_id, outcome_status, classification, finishing_position ON session_results
        WHEN OLD.session_id IS NOT NEW.session_id OR OLD.outcome_status IS NOT NEW.outcome_status
          OR OLD.classification IS NOT NEW.classification OR OLD.finishing_position IS NOT NEW.finishing_position
      BEGIN
        INSERT INTO dashboard_summary_state(session_id, source_revision, metadata_dirty)
        SELECT OLD.session_id, 1, 1 WHERE EXISTS (SELECT 1 FROM sessions WHERE id=OLD.session_id AND ownership='mine')
          OR EXISTS (SELECT 1 FROM dashboard_summary_state WHERE session_id=OLD.session_id)
          OR EXISTS (SELECT 1 FROM dashboard_session_summaries WHERE session_id=OLD.session_id)
        ON CONFLICT(session_id) DO UPDATE SET source_revision=source_revision+1, metadata_dirty=1, updated_at=datetime('now');
        INSERT INTO dashboard_summary_state(session_id, source_revision, metadata_dirty)
        SELECT NEW.session_id, 1, 1 WHERE NEW.session_id != OLD.session_id AND (
          EXISTS (SELECT 1 FROM sessions WHERE id=NEW.session_id AND ownership='mine')
          OR EXISTS (SELECT 1 FROM dashboard_summary_state WHERE session_id=NEW.session_id)
          OR EXISTS (SELECT 1 FROM dashboard_session_summaries WHERE session_id=NEW.session_id))
        ON CONFLICT(session_id) DO UPDATE SET source_revision=source_revision+1, metadata_dirty=1, updated_at=datetime('now');
      END`,
      `CREATE TRIGGER dashboard_results_delete AFTER DELETE ON session_results BEGIN
        INSERT INTO dashboard_summary_state(session_id, source_revision, metadata_dirty)
        SELECT OLD.session_id, 1, 1 WHERE EXISTS (SELECT 1 FROM sessions WHERE id=OLD.session_id AND ownership='mine')
          OR EXISTS (SELECT 1 FROM dashboard_summary_state WHERE session_id=OLD.session_id)
          OR EXISTS (SELECT 1 FROM dashboard_session_summaries WHERE session_id=OLD.session_id)
        ON CONFLICT(session_id) DO UPDATE SET source_revision=source_revision+1, metadata_dirty=1, updated_at=datetime('now');
      END`,
      `CREATE TRIGGER dashboard_pit_update AFTER UPDATE OF result_id, service, duration_seconds ON pit_events
        WHEN OLD.result_id IS NOT NEW.result_id OR OLD.service IS NOT NEW.service OR OLD.duration_seconds IS NOT NEW.duration_seconds
      BEGIN
        INSERT INTO dashboard_summary_state(session_id, source_revision, metadata_dirty)
        SELECT session_id, 1, 1 FROM session_results WHERE id=OLD.result_id
        ON CONFLICT(session_id) DO UPDATE SET source_revision=source_revision+1, metadata_dirty=1, updated_at=datetime('now');
        INSERT INTO dashboard_summary_state(session_id, source_revision, metadata_dirty)
        SELECT session_id, 1, 1 FROM session_results WHERE id=NEW.result_id
        ON CONFLICT(session_id) DO UPDATE SET source_revision=source_revision+1, metadata_dirty=1, updated_at=datetime('now');
      END`,
      `CREATE TRIGGER dashboard_pit_delete AFTER DELETE ON pit_events BEGIN
        INSERT INTO dashboard_summary_state(session_id, source_revision, metadata_dirty)
        SELECT session_id, 1, 1 FROM session_results WHERE id=OLD.result_id
        ON CONFLICT(session_id) DO UPDATE SET source_revision=source_revision+1, metadata_dirty=1, updated_at=datetime('now');
      END`,
      `ALTER TABLE dashboard_summary_state ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE dashboard_summary_state ADD COLUMN next_retry_at TEXT`,
      `ALTER TABLE dashboard_summary_state ADD COLUMN last_success_at TEXT`,
      `CREATE INDEX dashboard_state_retry_idx ON dashboard_summary_state(next_retry_at, session_id)`,
      `ALTER TABLE dashboard_session_summaries ADD COLUMN valid_mean_seconds REAL`,
      `ALTER TABLE dashboard_session_summaries ADD COLUMN valid_m2_seconds REAL`,
      `ALTER TABLE dashboard_session_summaries ADD COLUMN first_lap_at_ms INTEGER`,
      `ALTER TABLE dashboard_session_summaries ADD COLUMN last_lap_at_ms INTEGER`,
      `ALTER TABLE dashboard_session_summaries ADD COLUMN favourite_laps INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE dashboard_session_summaries ADD COLUMN favourite_seconds REAL NOT NULL DEFAULT 0`,
      `ALTER TABLE dashboard_session_summaries ADD COLUMN distance_laps INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE dashboard_session_summaries ADD COLUMN distance_meters REAL`,
      `ALTER TABLE dashboard_session_summaries ADD COLUMN duration_status TEXT NOT NULL DEFAULT 'pending'`,
      `ALTER TABLE dashboard_session_summaries ADD COLUMN sector_status TEXT NOT NULL DEFAULT 'pending'`,
      `ALTER TABLE dashboard_session_summaries ADD COLUMN weather_status TEXT NOT NULL DEFAULT 'pending'`,
      `ALTER TABLE dashboard_session_summaries ADD COLUMN evidence_version INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE dashboard_session_days ADD COLUMN favourite_laps INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE dashboard_session_days ADD COLUMN favourite_seconds REAL NOT NULL DEFAULT 0`,
      `ALTER TABLE dashboard_session_days ADD COLUMN distance_laps INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE dashboard_session_days ADD COLUMN distance_meters REAL`,
      `CREATE TABLE dashboard_day_entities (
        utc_day TEXT NOT NULL, game_id TEXT NOT NULL, car_key TEXT NOT NULL, track_key TEXT NOT NULL,
        lap_count INTEGER NOT NULL, positive_laps INTEGER NOT NULL, valid_laps INTEGER NOT NULL,
        driven_seconds REAL NOT NULL, valid_seconds REAL NOT NULL, valid_mean_seconds REAL, valid_m2_seconds REAL,
        favourite_laps INTEGER NOT NULL, favourite_seconds REAL NOT NULL, distance_laps INTEGER NOT NULL,
        distance_meters REAL NOT NULL, podium_first INTEGER NOT NULL, podium_second INTEGER NOT NULL,
        podium_third INTEGER NOT NULL, PRIMARY KEY(utc_day, game_id, car_key, track_key)
      )`,
      `CREATE INDEX dashboard_day_entities_scope_idx ON dashboard_day_entities(game_id, utc_day)`,
      `CREATE INDEX dashboard_day_entities_track_idx ON dashboard_day_entities(game_id, track_key, utc_day)`,
      `CREATE INDEX dashboard_day_entities_car_idx ON dashboard_day_entities(game_id, car_key, utc_day)`,
      `CREATE TABLE dashboard_time_buckets (
        bucket_start_ms INTEGER NOT NULL, game_id TEXT NOT NULL, valid_laps INTEGER NOT NULL,
        positive_laps INTEGER NOT NULL, driven_seconds REAL NOT NULL, valid_seconds REAL NOT NULL,
        podium_first INTEGER NOT NULL, podium_second INTEGER NOT NULL, podium_third INTEGER NOT NULL,
        PRIMARY KEY(bucket_start_ms, game_id)
      )`,
      `CREATE INDEX dashboard_time_buckets_game_time_idx ON dashboard_time_buckets(game_id, bucket_start_ms)`,
      `CREATE TABLE dashboard_backfill_cursor (
        id INTEGER PRIMARY KEY CHECK(id = 1), last_session_id INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
      `INSERT INTO dashboard_backfill_cursor(id, last_session_id) VALUES (1, 0)`,
      `DROP TRIGGER dashboard_sessions_update`,
      `CREATE TRIGGER dashboard_sessions_update AFTER UPDATE OF
        ownership, game_id, created_at, car_id, track_id,
        session_type, raw_file, source, capture_format_version ON sessions
        WHEN OLD.ownership IS NOT NEW.ownership OR OLD.game_id IS NOT NEW.game_id
          OR OLD.created_at IS NOT NEW.created_at OR OLD.car_id IS NOT NEW.car_id
          OR OLD.track_id IS NOT NEW.track_id OR OLD.session_type IS NOT NEW.session_type
          OR OLD.raw_file IS NOT NEW.raw_file OR OLD.source IS NOT NEW.source
          OR OLD.capture_format_version IS NOT NEW.capture_format_version
      BEGIN
        INSERT INTO dashboard_summary_state(session_id, source_revision, metadata_dirty, capture_dirty)
        SELECT NEW.id, 1, 1, CASE WHEN OLD.raw_file IS NOT NEW.raw_file
          OR OLD.source IS NOT NEW.source OR OLD.capture_format_version IS NOT NEW.capture_format_version THEN 1 ELSE 0 END
        WHERE NEW.ownership='mine' OR OLD.ownership='mine'
          OR EXISTS (SELECT 1 FROM dashboard_summary_state WHERE session_id=OLD.id)
          OR EXISTS (SELECT 1 FROM dashboard_session_summaries WHERE session_id=OLD.id)
        ON CONFLICT(session_id) DO UPDATE SET source_revision=source_revision+1, metadata_dirty=1,
          capture_dirty=CASE WHEN OLD.raw_file IS NOT NEW.raw_file OR OLD.source IS NOT NEW.source
            OR OLD.capture_format_version IS NOT NEW.capture_format_version THEN 1 ELSE dashboard_summary_state.capture_dirty END,
          updated_at=datetime('now');
      END`,
      `DROP TRIGGER dashboard_laps_insert`,
      `CREATE TRIGGER dashboard_laps_insert AFTER INSERT ON laps BEGIN
        INSERT INTO dashboard_lap_index(lap_id, session_id, created_at_ms, lap_time, is_valid, invalid_reason, sector_times)
        VALUES (NEW.id, NEW.session_id, CAST(strftime('%s', NEW.created_at) AS INTEGER) * 1000 + CAST(substr(strftime('%f', NEW.created_at), 4, 3) AS INTEGER),
          NEW.lap_time, NEW.is_valid, NEW.invalid_reason, NEW.sector_times);
        INSERT INTO dashboard_summary_state(session_id, source_revision, metadata_dirty)
        SELECT NEW.session_id, 1, 1 WHERE EXISTS (SELECT 1 FROM sessions WHERE id=NEW.session_id AND ownership='mine')
          OR EXISTS (SELECT 1 FROM dashboard_summary_state WHERE session_id=NEW.session_id)
          OR EXISTS (SELECT 1 FROM dashboard_session_summaries WHERE session_id=NEW.session_id)
        ON CONFLICT(session_id) DO UPDATE SET source_revision=source_revision+1,
          metadata_dirty=1, updated_at=datetime('now');
      END`,
      `DROP TRIGGER dashboard_laps_update`,
      `CREATE TRIGGER dashboard_laps_update AFTER UPDATE OF session_id, lap_time, is_valid, invalid_reason, created_at, sector_times ON laps
        WHEN OLD.session_id IS NOT NEW.session_id OR OLD.lap_time IS NOT NEW.lap_time
          OR OLD.is_valid IS NOT NEW.is_valid OR OLD.invalid_reason IS NOT NEW.invalid_reason
          OR OLD.created_at IS NOT NEW.created_at OR OLD.sector_times IS NOT NEW.sector_times
      BEGIN
        DELETE FROM dashboard_lap_index WHERE lap_id=OLD.id;
        INSERT INTO dashboard_lap_index(lap_id, session_id, created_at_ms, lap_time, is_valid, invalid_reason, sector_times)
        VALUES (NEW.id, NEW.session_id, CAST(strftime('%s', NEW.created_at) AS INTEGER) * 1000 + CAST(substr(strftime('%f', NEW.created_at), 4, 3) AS INTEGER),
          NEW.lap_time, NEW.is_valid, NEW.invalid_reason, NEW.sector_times);
        INSERT INTO dashboard_summary_state(session_id, source_revision, metadata_dirty)
        SELECT OLD.session_id, 1, 1 WHERE EXISTS (SELECT 1 FROM sessions WHERE id=OLD.session_id AND ownership='mine')
          OR EXISTS (SELECT 1 FROM dashboard_summary_state WHERE session_id=OLD.session_id)
          OR EXISTS (SELECT 1 FROM dashboard_session_summaries WHERE session_id=OLD.session_id)
        ON CONFLICT(session_id) DO UPDATE SET source_revision=source_revision+1, metadata_dirty=1, updated_at=datetime('now');
        INSERT INTO dashboard_summary_state(session_id, source_revision, metadata_dirty)
        SELECT NEW.session_id, 1, 1 WHERE NEW.session_id != OLD.session_id AND (
          EXISTS (SELECT 1 FROM sessions WHERE id=NEW.session_id AND ownership='mine')
          OR EXISTS (SELECT 1 FROM dashboard_summary_state WHERE session_id=NEW.session_id)
          OR EXISTS (SELECT 1 FROM dashboard_session_summaries WHERE session_id=NEW.session_id))
        ON CONFLICT(session_id) DO UPDATE SET source_revision=source_revision+1, metadata_dirty=1, updated_at=datetime('now');
      END`,
      `DROP TRIGGER dashboard_laps_delete`,
      `CREATE TRIGGER dashboard_laps_delete AFTER DELETE ON laps BEGIN
        DELETE FROM dashboard_lap_index WHERE lap_id=OLD.id;
        INSERT INTO dashboard_summary_state(session_id, source_revision, metadata_dirty)
        SELECT OLD.session_id, 1, 1 WHERE EXISTS (SELECT 1 FROM sessions WHERE id=OLD.session_id AND ownership='mine')
          OR EXISTS (SELECT 1 FROM dashboard_summary_state WHERE session_id=OLD.session_id)
          OR EXISTS (SELECT 1 FROM dashboard_session_summaries WHERE session_id=OLD.session_id)
        ON CONFLICT(session_id) DO UPDATE SET source_revision=source_revision+1, metadata_dirty=1, updated_at=datetime('now');
      END`,
      `ALTER TABLE dashboard_session_summaries ADD COLUMN track_length_meters REAL`,
      `ALTER TABLE dashboard_session_summaries ADD COLUMN podium_status TEXT NOT NULL DEFAULT 'unavailable'`,
      `CREATE TABLE dashboard_session_index (
        session_id INTEGER PRIMARY KEY, created_at_ms INTEGER NOT NULL, game_id TEXT NOT NULL, ownership TEXT NOT NULL,
        car_id TEXT, track_id TEXT, session_type TEXT
      )`,
      `CREATE INDEX dashboard_session_time_idx ON dashboard_session_index(created_at_ms, session_id)`,
      `CREATE INDEX dashboard_session_game_time_idx ON dashboard_session_index(game_id, created_at_ms, session_id)`,
      `INSERT INTO dashboard_session_index(session_id,created_at_ms,game_id,ownership,car_id,track_id,session_type)
        SELECT id,CAST(strftime('%s',created_at) AS INTEGER)*1000+CAST(substr(strftime('%f',created_at),4,3) AS INTEGER),game_id,ownership,car_id,track_id,session_type
        FROM sessions`,
      `CREATE TRIGGER dashboard_session_index_insert AFTER INSERT ON sessions BEGIN
        INSERT INTO dashboard_session_index(session_id,created_at_ms,game_id,ownership,car_id,track_id,session_type)
        VALUES (NEW.id,CAST(strftime('%s',NEW.created_at) AS INTEGER)*1000+CAST(substr(strftime('%f',NEW.created_at),4,3) AS INTEGER),NEW.game_id,NEW.ownership,NEW.car_id,NEW.track_id,NEW.session_type);
      END`,
      `CREATE TRIGGER dashboard_session_index_update AFTER UPDATE OF created_at,game_id,ownership,car_id,track_id,session_type ON sessions BEGIN
        UPDATE dashboard_session_index SET created_at_ms=CAST(strftime('%s',NEW.created_at) AS INTEGER)*1000+CAST(substr(strftime('%f',NEW.created_at),4,3) AS INTEGER),
          game_id=NEW.game_id,ownership=NEW.ownership,car_id=NEW.car_id,
          track_id=NEW.track_id,session_type=NEW.session_type
        WHERE session_id=NEW.id;
      END`,
      `CREATE TRIGGER dashboard_session_index_delete AFTER DELETE ON sessions BEGIN
        DELETE FROM dashboard_session_index WHERE session_id=OLD.id;
      END`,
      `CREATE TRIGGER dashboard_pit_insert AFTER INSERT ON pit_events BEGIN
        INSERT INTO dashboard_summary_state(session_id, source_revision, metadata_dirty)
        SELECT r.session_id, 1, 1 FROM session_results r JOIN sessions s ON s.id=r.session_id
        WHERE r.id=NEW.result_id AND (s.ownership='mine'
          OR EXISTS (SELECT 1 FROM dashboard_summary_state WHERE session_id=r.session_id)
          OR EXISTS (SELECT 1 FROM dashboard_session_summaries WHERE session_id=r.session_id))
        ON CONFLICT(session_id) DO UPDATE SET source_revision=source_revision+1, metadata_dirty=1, updated_at=datetime('now');
      END`,
      `DROP TRIGGER dashboard_pit_update`,
      `CREATE TRIGGER dashboard_pit_update AFTER UPDATE OF result_id, service, duration_seconds ON pit_events
        WHEN OLD.result_id IS NOT NEW.result_id OR OLD.service IS NOT NEW.service OR OLD.duration_seconds IS NOT NEW.duration_seconds
      BEGIN
        INSERT INTO dashboard_summary_state(session_id, source_revision, metadata_dirty)
        SELECT r.session_id, 1, 1 FROM session_results r JOIN sessions s ON s.id=r.session_id
        WHERE r.id=OLD.result_id AND (s.ownership='mine'
          OR EXISTS (SELECT 1 FROM dashboard_summary_state WHERE session_id=r.session_id)
          OR EXISTS (SELECT 1 FROM dashboard_session_summaries WHERE session_id=r.session_id))
        ON CONFLICT(session_id) DO UPDATE SET source_revision=source_revision+1, metadata_dirty=1, updated_at=datetime('now');
        INSERT INTO dashboard_summary_state(session_id, source_revision, metadata_dirty)
        SELECT r.session_id, 1, 1 FROM session_results r JOIN sessions s ON s.id=r.session_id
        WHERE r.id=NEW.result_id
          AND r.session_id IS NOT (SELECT session_id FROM session_results WHERE id=OLD.result_id)
          AND (s.ownership='mine'
            OR EXISTS (SELECT 1 FROM dashboard_summary_state WHERE session_id=r.session_id)
            OR EXISTS (SELECT 1 FROM dashboard_session_summaries WHERE session_id=r.session_id))
        ON CONFLICT(session_id) DO UPDATE SET source_revision=source_revision+1, metadata_dirty=1, updated_at=datetime('now');
      END`,
      `DROP TRIGGER dashboard_pit_delete`,
      `CREATE TRIGGER dashboard_pit_delete AFTER DELETE ON pit_events BEGIN
        INSERT INTO dashboard_summary_state(session_id, source_revision, metadata_dirty)
        SELECT r.session_id, 1, 1 FROM session_results r JOIN sessions s ON s.id=r.session_id
        WHERE r.id=OLD.result_id AND (s.ownership='mine'
          OR EXISTS (SELECT 1 FROM dashboard_summary_state WHERE session_id=r.session_id)
          OR EXISTS (SELECT 1 FROM dashboard_session_summaries WHERE session_id=r.session_id))
        ON CONFLICT(session_id) DO UPDATE SET source_revision=source_revision+1, metadata_dirty=1, updated_at=datetime('now');
      END`,
    ],
  },
  {
    version: 69,
    name: "persist dashboard recap capture facts and readiness",
    sql: [
      `ALTER TABLE dashboard_session_summaries ADD COLUMN source_sector_starts_json TEXT`,
      `ALTER TABLE dashboard_session_summaries ADD COLUMN weather_conditions_json TEXT`,
      `ALTER TABLE dashboard_summary_state ADD COLUMN capture_ready INTEGER NOT NULL DEFAULT 1`,
      `UPDATE dashboard_summary_state SET capture_dirty=1, capture_ready=1, metadata_dirty=1, processor_version=0`,
    ],
  },
  {
    version: 70,
    name: "repair missing dashboard backfill cursor",
    sql: [
      `CREATE TABLE IF NOT EXISTS dashboard_backfill_cursor (
        id INTEGER PRIMARY KEY CHECK(id = 1), last_session_id INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
      `INSERT OR IGNORE INTO dashboard_backfill_cursor(id, last_session_id) VALUES (1, 0)`,
    ],
  },
  {
    version: 71,
    name: "repair missing dashboard processor retry columns",
    sql: [
      `ALTER TABLE dashboard_summary_state ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE dashboard_summary_state ADD COLUMN next_retry_at TEXT`,
      `ALTER TABLE dashboard_summary_state ADD COLUMN last_success_at TEXT`,
      `CREATE INDEX IF NOT EXISTS dashboard_state_retry_idx ON dashboard_summary_state(next_retry_at, session_id)`,
    ],
  },
  {
    version: 72,
    name: "maintain monthly dashboard entity rollups",
    sql: [
      ...dashboardProjectionRecoverySql,
      `CREATE INDEX IF NOT EXISTS dashboard_month_entities_scope_idx ON dashboard_month_entities(game_id,utc_month)`,
      `CREATE INDEX IF NOT EXISTS dashboard_month_entities_track_idx ON dashboard_month_entities(game_id,track_key,utc_month)`,
      `CREATE INDEX IF NOT EXISTS dashboard_month_entities_car_idx ON dashboard_month_entities(game_id,car_key,utc_month)`,
      ...dashboardMonthlyRollupSql,
    ],
  },
  {
    version: 73,
    name: "recover incomplete dashboard projections after monthly rollups",
    sql: [
      ...dashboardProjectionRecoverySql,
      ...dashboardMonthlyRollupSql,
    ],
  },
  {
    version: 74,
    name: "restore dashboard source projection indexes",
    sql: [
      ...dashboardProjectionRecoverySql,
      ...dashboardMonthlyRollupSql,
    ],
  },
  {
    version: 75,
    name: "persist dashboard access and login sessions",
    sql: [
      `CREATE TABLE IF NOT EXISTS dashboard_access (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        mode TEXT NOT NULL CHECK (mode IN ('pending', 'enabled', 'disabled')),
        password_hash TEXT,
        revision INTEGER NOT NULL DEFAULT 0,
        network_json TEXT,
        upgrade INTEGER
      )`,
      `INSERT INTO dashboard_access (id, mode)
       SELECT 1, 'pending'
       WHERE NOT EXISTS (SELECT 1 FROM dashboard_access WHERE id = 1)
         AND NOT EXISTS (
           SELECT 1 FROM schema_migrations
           WHERE version IN (63, 64, 68, 75) AND name = 'persist dashboard access and login sessions'
         )`,
      `CREATE TABLE IF NOT EXISTS dashboard_sessions (
        token_hash TEXT PRIMARY KEY,
        csrf TEXT NOT NULL,
        generation TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      )`,
    ],
  },
  {
    version: 76,
    name: "add lossless lap capture bundle references",
    sql: [
      `ALTER TABLE sessions ADD COLUMN capture_layout_version INTEGER`,
      `ALTER TABLE sessions ADD COLUMN capture_manifest_file TEXT`,
      `ALTER TABLE laps ADD COLUMN capture_chunk_id TEXT`,
      `ALTER TABLE laps ADD COLUMN source_frame_start INTEGER`,
      `ALTER TABLE laps ADD COLUMN source_frame_count INTEGER`,
      `CREATE TABLE IF NOT EXISTS session_capture_split_jobs (
        session_id INTEGER PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        job_id TEXT NOT NULL UNIQUE,
        attempt_id INTEGER NOT NULL DEFAULT 1,
        pending_source_revision TEXT NOT NULL,
        source_path TEXT NOT NULL,
        staging_path TEXT,
        status TEXT NOT NULL CHECK (status IN ('queued', 'splitting', 'verifying', 'publishing', 'ready', 'failed')),
        error_code TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
    ],
  },
  {
    version: 77,
    name: "persist capture split progress counters",
    sql: [
      `ALTER TABLE session_capture_split_jobs ADD COLUMN sequence INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE session_capture_split_jobs ADD COLUMN processed_source_frames INTEGER`,
      `ALTER TABLE session_capture_split_jobs ADD COLUMN total_source_frames INTEGER`,
      `ALTER TABLE session_capture_split_jobs ADD COLUMN completed_lap_artifacts INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE session_capture_split_jobs ADD COLUMN total_lap_artifacts INTEGER NOT NULL DEFAULT 0`,
    ],
  },
  {
    version: 78,
    name: "reconcile all AC Evo recordings to discover Tourist layouts",
    sql: [
      // Stored track IDs can predate native layout identity; discover layouts from captures.
      `UPDATE sessions SET lap_detector_version = NULL WHERE game_id = 'ac-evo'`,
    ],
  },
  {
    version: 79,
    name: "add indexed gzip capture archive reference",
    sql: [
      `ALTER TABLE sessions ADD COLUMN capture_archive_file TEXT`,
    ],
  },
  {
    version: 80,
    name: "persist incremental live capture publication and recovery journal",
    sql: [
      `CREATE TABLE live_captures (
        session_id INTEGER PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        capture_epoch TEXT NOT NULL UNIQUE, attempt TEXT NOT NULL,
        source_path TEXT NOT NULL, archive_path TEXT NOT NULL,
        source_device TEXT, source_inode TEXT,
        generation INTEGER NOT NULL DEFAULT 0,
        committed_archive_length INTEGER NOT NULL DEFAULT 0,
        source_byte_length INTEGER NOT NULL DEFAULT 0,
        source_record_count INTEGER NOT NULL DEFAULT 0,
        source_durable_watermark INTEGER NOT NULL DEFAULT 0,
        metadata_durable_watermark INTEGER NOT NULL DEFAULT 0,
        durable_sequence INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL CHECK (status IN ('recording','finalizing','sealed','failed','recovering')),
        error TEXT
      )`,
      `CREATE TABLE live_capture_members (
        capture_epoch TEXT NOT NULL REFERENCES live_captures(capture_epoch) ON DELETE CASCADE,
        generation INTEGER NOT NULL,
        lap_id INTEGER REFERENCES laps(id) ON DELETE SET NULL,
        ownership_revision INTEGER NOT NULL, descriptor TEXT NOT NULL, verification TEXT NOT NULL,
        PRIMARY KEY(capture_epoch,generation)
      )`,
      `CREATE UNIQUE INDEX live_capture_member_lap_idx ON live_capture_members(lap_id)`,
      `CREATE TABLE live_capture_journal (
        capture_epoch TEXT NOT NULL REFERENCES live_captures(capture_epoch) ON DELETE CASCADE,
        sequence INTEGER NOT NULL, source_byte_end INTEGER NOT NULL, payload TEXT NOT NULL,
        PRIMARY KEY(capture_epoch,sequence)
      )`,
      `CREATE INDEX live_capture_journal_effective_idx ON live_capture_journal(
        capture_epoch, coalesce(cast(json_extract(payload, '$.startByteOffset') as integer), source_byte_end), sequence
      )`,
      `CREATE INDEX live_capture_journal_lap_idx ON live_capture_journal(
        capture_epoch, cast(json_extract(payload, '$.lapId') as integer), sequence
      )`,
    ],
  },
  {
    version: 81,
    name: "classify historical non-pace laps",
    sql: [
      `ALTER TABLE laps ADD COLUMN classification TEXT`,
      `ALTER TABLE dashboard_lap_index ADD COLUMN classification TEXT`,
      `UPDATE laps SET classification = CASE invalid_reason
        WHEN 'inlap' THEN 'in_lap'
        WHEN 'outlap' THEN 'out_lap'
        WHEN 'pit lap' THEN 'pit_lap'
        ELSE classification END
       WHERE invalid_reason IN ('inlap','outlap','pit lap')`,
      `UPDATE dashboard_lap_index SET classification=(SELECT classification FROM laps WHERE laps.id=dashboard_lap_index.lap_id)`,
      `ALTER TABLE dashboard_session_summaries ADD COLUMN pace_laps INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE dashboard_session_summaries ADD COLUMN pace_seconds REAL NOT NULL DEFAULT 0`,
      `ALTER TABLE dashboard_session_days ADD COLUMN pace_laps INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE dashboard_session_days ADD COLUMN pace_seconds REAL NOT NULL DEFAULT 0`,
      `ALTER TABLE dashboard_day_entities ADD COLUMN pace_laps INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE dashboard_day_entities ADD COLUMN pace_seconds REAL NOT NULL DEFAULT 0`,
      `ALTER TABLE dashboard_month_entities ADD COLUMN pace_laps INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE dashboard_month_entities ADD COLUMN pace_seconds REAL NOT NULL DEFAULT 0`,
      `ALTER TABLE dashboard_session_time_buckets ADD COLUMN pace_laps INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE dashboard_session_time_buckets ADD COLUMN pace_seconds REAL NOT NULL DEFAULT 0`,
      `ALTER TABLE dashboard_time_buckets ADD COLUMN pace_laps INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE dashboard_time_buckets ADD COLUMN pace_seconds REAL NOT NULL DEFAULT 0`,
      `CREATE TABLE classification_migration_recordings (
        recording_id TEXT PRIMARY KEY,
        source_key TEXT NOT NULL,
        version INTEGER NOT NULL,
        source_revision INTEGER NOT NULL DEFAULT 1,
        result_revision INTEGER NOT NULL DEFAULT 0,
        attempt INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL CHECK(state IN ('pending','running','completed','limited','failed')),
        source_signature TEXT,
        reason TEXT,
        UNIQUE(source_key)
      )`,
      `CREATE TABLE classification_migration_meta (
        id INTEGER PRIMARY KEY CHECK(id=1),
        version INTEGER NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0,
        cutoff_session_id INTEGER NOT NULL DEFAULT 0
      )`,
      `INSERT INTO classification_migration_meta(id,version,revision,cutoff_session_id)
       SELECT 1,1,0,COALESCE(MAX(id),0) FROM sessions`,
      `DROP TRIGGER dashboard_laps_update`,
      `CREATE TRIGGER dashboard_laps_update AFTER UPDATE OF session_id,lap_time,is_valid,invalid_reason,created_at,sector_times,classification ON laps
       WHEN OLD.session_id IS NOT NEW.session_id OR OLD.lap_time IS NOT NEW.lap_time
         OR OLD.is_valid IS NOT NEW.is_valid OR OLD.invalid_reason IS NOT NEW.invalid_reason
         OR OLD.created_at IS NOT NEW.created_at OR OLD.sector_times IS NOT NEW.sector_times
         OR OLD.classification IS NOT NEW.classification
       BEGIN
         DELETE FROM dashboard_lap_index WHERE lap_id=OLD.id;
         INSERT INTO dashboard_lap_index(lap_id,session_id,created_at_ms,lap_time,is_valid,invalid_reason,classification,sector_times)
         VALUES(NEW.id,NEW.session_id,CAST(strftime('%s',NEW.created_at) AS INTEGER)*1000+CAST(substr(strftime('%f',NEW.created_at),4,3) AS INTEGER),
           NEW.lap_time,NEW.is_valid,NEW.invalid_reason,NEW.classification,NEW.sector_times);
         INSERT INTO dashboard_summary_state(session_id,source_revision,metadata_dirty)
         SELECT OLD.session_id,1,1 WHERE EXISTS(SELECT 1 FROM sessions WHERE id=OLD.session_id AND ownership='mine')
           OR EXISTS(SELECT 1 FROM dashboard_summary_state WHERE session_id=OLD.session_id)
           OR EXISTS(SELECT 1 FROM dashboard_session_summaries WHERE session_id=OLD.session_id)
         ON CONFLICT(session_id) DO UPDATE SET source_revision=source_revision+1,metadata_dirty=1,updated_at=datetime('now');
         INSERT INTO dashboard_summary_state(session_id,source_revision,metadata_dirty)
         SELECT NEW.session_id,1,1 WHERE NEW.session_id!=OLD.session_id AND (
           EXISTS(SELECT 1 FROM sessions WHERE id=NEW.session_id AND ownership='mine')
           OR EXISTS(SELECT 1 FROM dashboard_summary_state WHERE session_id=NEW.session_id)
           OR EXISTS(SELECT 1 FROM dashboard_session_summaries WHERE session_id=NEW.session_id))
         ON CONFLICT(session_id) DO UPDATE SET source_revision=source_revision+1,metadata_dirty=1,updated_at=datetime('now');
       END`,
      `DROP TRIGGER dashboard_laps_insert`,
      `CREATE TRIGGER dashboard_laps_insert AFTER INSERT ON laps BEGIN
        INSERT INTO dashboard_lap_index(lap_id, session_id, created_at_ms, lap_time, is_valid, invalid_reason, classification, sector_times)
        VALUES (NEW.id, NEW.session_id, CAST(strftime('%s', NEW.created_at) AS INTEGER) * 1000 + CAST(substr(strftime('%f', NEW.created_at), 4, 3) AS INTEGER),
          NEW.lap_time, NEW.is_valid, NEW.invalid_reason, NEW.classification, NEW.sector_times);
        INSERT INTO dashboard_summary_state(session_id, source_revision, metadata_dirty, capture_dirty)
        SELECT NEW.session_id, 1, 1, 1 WHERE EXISTS (SELECT 1 FROM sessions WHERE id=NEW.session_id AND ownership='mine')
          OR EXISTS (SELECT 1 FROM dashboard_summary_state WHERE session_id=NEW.session_id)
          OR EXISTS (SELECT 1 FROM dashboard_session_summaries WHERE session_id=NEW.session_id)
        ON CONFLICT(session_id) DO UPDATE SET source_revision=source_revision+1,
          metadata_dirty=1, capture_dirty=1, updated_at=datetime('now');
      END`,
      `CREATE TRIGGER classification_sessions_source_update AFTER UPDATE OF raw_file ON sessions
       WHEN OLD.raw_file IS NOT NEW.raw_file
         AND OLD.id<=(SELECT cutoff_session_id FROM classification_migration_meta WHERE id=1)
       BEGIN
         UPDATE classification_migration_recordings
         SET source_revision=source_revision+1,source_signature=NULL,
             state=CASE WHEN state='running' THEN 'running' ELSE 'pending' END,
             reason='source_changed'
         WHERE source_key IN ('file:' || OLD.raw_file,'file:' || NEW.raw_file);
         UPDATE classification_migration_meta SET revision=revision+1 WHERE id=1
           AND EXISTS(SELECT 1 FROM classification_migration_recordings WHERE source_key IN ('file:' || OLD.raw_file,'file:' || NEW.raw_file));
       END`,
      `CREATE TRIGGER classification_laps_insert AFTER INSERT ON laps
       WHEN NEW.session_id<=(SELECT cutoff_session_id FROM classification_migration_meta WHERE id=1)
       BEGIN
         UPDATE classification_migration_recordings
         SET source_revision=source_revision+1,source_signature=NULL,
             state=CASE WHEN state='running' THEN 'running' ELSE 'pending' END,
             reason='source_changed'
         WHERE source_key=(SELECT 'file:' || raw_file FROM sessions WHERE id=NEW.session_id);
         UPDATE classification_migration_meta SET revision=revision+1 WHERE id=1
           AND EXISTS(SELECT 1 FROM classification_migration_recordings
             WHERE source_key=(SELECT 'file:' || raw_file FROM sessions WHERE id=NEW.session_id));
       END`,
      `CREATE TRIGGER classification_laps_delete AFTER DELETE ON laps
       WHEN OLD.session_id<=(SELECT cutoff_session_id FROM classification_migration_meta WHERE id=1)
       BEGIN
         UPDATE classification_migration_recordings
         SET source_revision=source_revision+1,source_signature=NULL,
             state=CASE WHEN state='running' THEN 'running' ELSE 'pending' END,
             reason='source_changed'
         WHERE source_key=(SELECT 'file:' || raw_file FROM sessions WHERE id=OLD.session_id);
         UPDATE classification_migration_meta SET revision=revision+1 WHERE id=1
           AND EXISTS(SELECT 1 FROM classification_migration_recordings
             WHERE source_key=(SELECT 'file:' || raw_file FROM sessions WHERE id=OLD.session_id));
       END`,
      `CREATE TRIGGER classification_laps_source_update AFTER UPDATE OF session_id,raw_byte_offset,raw_frame_count ON laps
       WHEN (OLD.session_id IS NOT NEW.session_id OR OLD.raw_byte_offset IS NOT NEW.raw_byte_offset OR OLD.raw_frame_count IS NOT NEW.raw_frame_count)
         AND (OLD.session_id<=(SELECT cutoff_session_id FROM classification_migration_meta WHERE id=1)
           OR NEW.session_id<=(SELECT cutoff_session_id FROM classification_migration_meta WHERE id=1))
       BEGIN
         UPDATE classification_migration_recordings
         SET source_revision=source_revision+1,source_signature=NULL,
             state=CASE WHEN state='running' THEN 'running' ELSE 'pending' END,
             reason='source_changed'
         WHERE source_key IN (
           SELECT 'file:' || raw_file FROM sessions WHERE id IN (OLD.session_id,NEW.session_id)
         );
         UPDATE classification_migration_meta SET revision=revision+1 WHERE id=1
           AND EXISTS(SELECT 1 FROM classification_migration_recordings WHERE source_key IN (
             SELECT 'file:' || raw_file FROM sessions WHERE id IN (OLD.session_id,NEW.session_id)
           ));
       END`,
      `CREATE TRIGGER classification_dashboard_dirty_insert AFTER INSERT ON dashboard_summary_state
       WHEN NEW.metadata_dirty=1 OR NEW.capture_dirty=1
       BEGIN
         UPDATE classification_migration_meta SET revision=revision+1 WHERE id=1;
       END`,
      `CREATE TRIGGER classification_dashboard_dirty_update AFTER UPDATE OF metadata_dirty,capture_dirty ON dashboard_summary_state
       WHEN OLD.metadata_dirty IS NOT NEW.metadata_dirty OR OLD.capture_dirty IS NOT NEW.capture_dirty
       BEGIN
         UPDATE classification_migration_meta SET revision=revision+1 WHERE id=1;
       END`,
      `UPDATE dashboard_summary_state
       SET processor_version=0,metadata_dirty=1
       WHERE session_id IN (SELECT id FROM sessions WHERE ownership='mine')`,
    ],
  },
];
const dashboardCanonicalTriggers = (() => {
  const readModel = migrations.find((migration) => migration.version === 68);
  const latestByName = new Map<string, string>();
  for (const sql of readModel?.sql ?? []) {
    const match = sql.match(/^\s*CREATE TRIGGER\s+([A-Za-z0-9_]+)/i);
    if (match?.[1].startsWith("dashboard_")) latestByName.set(match[1], sql);
  }
  return [...latestByName].flatMap(([name, sql]) => [`DROP TRIGGER IF EXISTS ${name}`, sql]);
})();

migrations.find((migration) => migration.version === 74)?.sql.push(...dashboardCanonicalTriggers);

