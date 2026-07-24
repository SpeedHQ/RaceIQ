import {
	sqliteTable,
	text,
	integer,
	real,
	blob,
	index,
	unique,
	primaryKey,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const profiles = sqliteTable("profiles", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	name: text("name").notNull(),
	createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

export const tunes = sqliteTable(
	"tunes",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		gameId: text("game_id").notNull(),
		name: text("name").notNull(),
		author: text("author").notNull(),
		carOrdinal: integer("car_ordinal").notNull(),
		category: text("category").notNull(),
		trackOrdinal: integer("track_ordinal"),
		description: text("description").notNull().default(""),
		strengths: text("strengths"),
		weaknesses: text("weaknesses"),
		bestTracks: text("best_tracks"),
		strategies: text("strategies"),
		settings: text("settings").notNull(),
		unitSystem: text("unit_system").notNull().default("metric"), // 'metric' | 'imperial'
		source: text("source").notNull().default("user"),
		catalogId: text("catalog_id"),
		createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
		updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
	},
	(table) => ({
		carIdx: index("idx_tunes_car").on(table.carOrdinal),
		gameCarIdx: index("idx_tunes_game_car").on(table.gameId, table.carOrdinal),
	}),
);

/**
 * Cars seen in telemetry that aren't in the per-game CSV data. AC Evo keys
 * cars by name (no stable ordinal), so unknown names get a generated ordinal
 * (>= 100000) here instead of importing as -1/"Unknown Car". Rows are
 * promoted to canonical CSV ids on startup once the name exists in cars.csv
 * (see reconcileDiscoveredCars).
 */
export const discoveredCars = sqliteTable(
	"discovered_cars",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		gameId: text("game_id").notNull(),
		ordinal: integer("ordinal").notNull(),
		name: text("name").notNull(),
		model: text("model").notNull().default(""),
		createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
	},
	(table) => [
		unique().on(table.gameId, table.ordinal),
		unique().on(table.gameId, table.name),
	],
);

export const sessions = sqliteTable("sessions", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	carOrdinal: integer("car_ordinal").notNull(),
	trackOrdinal: integer("track_ordinal").notNull(),
	gameId: text("game_id").notNull(),
	sessionType: text("session_type"),
	notes: text("notes"),
	rawFile: text("raw_file"),
	lapDetectorVersion: text("lap_detector_version"),
	createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

export const laps = sqliteTable(
	"laps",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		sessionId: integer("session_id")
			.notNull()
			.references(() => sessions.id, { onDelete: "cascade" }),
		lapNumber: integer("lap_number").notNull(),
		lapTime: real("lap_time").notNull(),
		isValid: integer("is_valid", { mode: "boolean" }).notNull().default(true),
		invalidReason: text("invalid_reason"),
		notes: text("notes"),
		profileId: integer("profile_id").references(() => profiles.id),
		pi: integer("pi"),
		carSetup: text("car_setup"), // JSON snapshot of F1CarSetup
		tuneId: integer("tune_id").references(() => tunes.id, {
			onDelete: "set null",
		}),
		s1Time: real("s1_time"),
		s2Time: real("s2_time"),
		s3Time: real("s3_time"),
		rawByteOffset: integer("raw_byte_offset"),
		rawFrameCount: integer("raw_frame_count"),
		// Explicit tuning-session link (migration v25). Stamped at insert from the
		// in-memory active tuning session (server/tuning-active.ts) so a tuning
		// session can span many race sessions. The `.references()` here is
		// type-level intent only — migration v25 adds a plain nullable column with
		// NO runtime FK (SQLite can't ALTER-ADD a column with inline REFERENCES),
		// so there is no ON DELETE SET NULL cascade in the actual DB.
		tuningSessionId: integer("tuning_session_id").references(
			() => tuningSessions.id,
			{ onDelete: "set null" },
		),
		tuningTestId: integer("tuning_test_id"),
		// User flag (migration v30): 1 = manually excluded from the tuning
		// aggregate (beyond the auto-outlier rule). Nullable; null/0 = included.
		tuningExcluded: integer("tuning_excluded"),
		// Persisted per-lap metrics (migration v32), derived once from the lap's
		// telemetry and cached here so the tuning workspace / lap-metrics endpoint
		// never re-decode every lap's frames on each read. Null = not yet computed
		// (lazily filled on first read) or no usable telemetry channel.
		fuelPerLap: real("fuel_per_lap"),
		tyreWear: real("tyre_wear"),
		createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
	},
	(table) => ({
		sessionIdx: index("idx_laps_session").on(table.sessionId),
		tuningSessionIdx: index("idx_laps_tuning_session").on(table.tuningSessionId),
	}),
);

export const tuneAssignments = sqliteTable(
	"tune_assignments",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		gameId: text("game_id").notNull(),
		carOrdinal: integer("car_ordinal").notNull(),
		trackOrdinal: integer("track_ordinal").notNull(),
		tuneId: integer("tune_id")
			.notNull()
			.references(() => tunes.id, { onDelete: "cascade" }),
	},
	(table) => ({
		gameCarTrackUnique: unique().on(table.gameId, table.carOrdinal, table.trackOrdinal),
		tuneIdx: index("idx_assignments_tune").on(table.tuneId),
	}),
);

export const trackOutlines = sqliteTable(
	"track_outlines",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		trackOrdinal: integer("track_ordinal").notNull(),
		gameId: text("game_id").notNull(),
		outline: blob("outline", { mode: "buffer" }).notNull(), // gzip'd JSON array of {x,z,speed}
		createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
	},
	(table) => ({
		trackIdx: index("idx_outlines_track").on(table.trackOrdinal),
		trackGameUnique: unique().on(table.trackOrdinal, table.gameId),
	}),
);

export const trackCorners = sqliteTable(
	"track_corners",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		trackOrdinal: integer("track_ordinal").notNull(),
		gameId: text("game_id").notNull(),
		cornerIndex: integer("corner_index").notNull(),
		label: text("label").notNull(),
		distanceStart: real("distance_start").notNull(),
		distanceEnd: real("distance_end").notNull(),
		isAuto: integer("is_auto", { mode: "boolean" }).notNull().default(true),
	},
	(table) => ({
		trackIdx: index("idx_corners_track").on(table.trackOrdinal),
		trackCornerUnique: unique().on(
			table.trackOrdinal,
			table.gameId,
			table.cornerIndex,
		),
	}),
);

export const lapAnalyses = sqliteTable(
	"lap_analyses",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		lapId: integer("lap_id")
			.notNull()
			.references(() => laps.id, { onDelete: "cascade" }),
		analysis: text("analysis").notNull(),
		inputTokens: integer("input_tokens").notNull().default(0),
		outputTokens: integer("output_tokens").notNull().default(0),
		costUsd: real("cost_usd").notNull().default(0),
		durationMs: integer("duration_ms").notNull().default(0),
		model: text("model").notNull().default(""),
		createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
	},
	(table) => [unique().on(table.lapId)],
);

/**
 * Cached racing-line spread trace for a tuning session's clean lap pool. The
 * /line-spread endpoint decodes every clean lap and runs computeLineSpreadTrace
 * over all of them — expensive at 50 laps. The result is deterministic per
 * (session, clean-lap set), so cache the computed trace JSON keyed by the
 * tuning session id + a hash of the sorted clean lap ids (+ an algo version, so
 * a computeLineSpreadTrace change invalidates old rows). A changed lap set (a
 * lap excluded/added) yields a new hash and recomputes.
 */
export const lineSpreadCache = sqliteTable(
	"line_spread_cache",
	{
		tuningSessionId: integer("tuning_session_id").notNull(),
		lapSetHash: text("lap_set_hash").notNull(),
		trace: text("trace").notNull(),
		createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
	},
	(table) => [primaryKey({ columns: [table.tuningSessionId, table.lapSetHash] })],
);

/**
 * Community tunes synced from the SpeedHQ CDN (Cloudflare Pages).
 * Populated by a replace-all sync per game_id — see server/community-tunes-sync.ts.
 * The catalog endpoint merges these rows with the built-in JSON catalog.
 * strengths/weaknesses/bestTracks/strategies are intentionally not persisted;
 * community cards render from name/author/category/description/settings only.
 */
export const communityTunes = sqliteTable(
	"community_tunes",
	{
		id: text("id").primaryKey(),
		gameId: text("game_id").notNull(),
		carOrdinal: integer("car_ordinal").notNull(),
		trackOrdinal: integer("track_ordinal"),
		name: text("name").notNull(),
		author: text("author").notNull(),
		category: text("category").notNull(),
		description: text("description").notNull().default(""),
		sourceName: text("source_name").notNull().default(""),
		settings: text("settings").notNull(),
		syncedAt: text("synced_at").notNull().default(sql`(datetime('now'))`),
	},
	(table) => [index("idx_community_tunes_game").on(table.gameId)],
);

/**
 * Tuning sessions — the Setup Engineer "front door" (plan §6a). A tuning
 * session is the parent container for the Setup IQ loop: it owns the base
 * setup, the stints driven, and (later phases) the setup versions v1..vN.
 *
 * Car/track are stored two ways because the two seed paths supply different
 * identifiers: seeding from an ACC/AC-Evo saved setup file gives the car/track
 * folder *names* (carName/trackName + baseSetupPath), while seeding from a live
 * or recorded telemetry session gives numeric ordinals. Both are nullable; a
 * session uses whichever its origin provided.
 */
export const tuningSessions = sqliteTable(
	"tuning_sessions",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		// Per-game display number, counted from 1 and independent of the raw
		// autoincrement id (which churns) and of race/telemetry sessions.
		seq: integer("seq").notNull().default(1),
		gameId: text("game_id").notNull(),
		name: text("name").notNull(),
		carOrdinal: integer("car_ordinal"),
		trackOrdinal: integer("track_ordinal"),
		carName: text("car_name"),
		trackName: text("track_name"),
		baseSetupPath: text("base_setup_path"),
		// The checked-out tuning-test the Setup Engineer chat works from.
		// null → fall back to the mainline tip. Not a hard FK so a test can be
		// archived independently (mirrors tuning_tests.parentTestId).
		headTestId: integer("head_test_id"),
		status: text("status").notNull().default("active"), // 'active' | 'archived'
		notes: text("notes"),
		createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
		updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
	},
	(table) => ({
		gameIdx: index("idx_tuning_sessions_game").on(table.gameId),
	}),
);

/**
 * Tuning tests — the setup versions under evaluation inside a tuning session
 * (plan §2). One row per setup being tested: v1 "base" is seeded from the
 * session's baseSetupPath on session create, and each Save & recommend appends
 * v(N+1) with the applied diff + the newly written setup file.
 *
 * `appliedChanges` is a JSON blob of the AppliedChange[] returned by the
 * autotune engine. `parentTestId` links a version to the one it was derived
 * from (self-referential; not a hard FK so a parent can be archived independently).
 */
export const tuningTests = sqliteTable(
	"tuning_tests",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		tuningSessionId: integer("tuning_session_id")
			.notNull()
			.references(() => tuningSessions.id, { onDelete: "cascade" }),
		version: integer("version").notNull(),
		label: text("label").notNull(),
		setupPath: text("setup_path"),
		parentTestId: integer("parent_test_id"),
		appliedChanges: text("applied_changes"), // JSON: AppliedChange[]
		driverComment: text("driver_comment"),
		// Engineer/AI free-text annotation on this node — distinct from the
		// driver's subjective feel comment. The setup-engineer agent writes here
		// to persist per-version reasoning that must survive chat compaction
		// (migration v31).
		notes: text("notes"),
		engine: text("engine"),
		// F1's captured base / target F1CarSetup JSON (migration v30). Null for
		// file-based ACC/AC-Evo nodes, which keep using setupPath.
		setupSnapshot: text("setup_snapshot"),
		status: text("status").notNull().default("active"), // 'active' | 'archived' | 'deleted'
		createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
	},
	(table) => ({
		sessionIdx: index("idx_tuning_tests_session").on(table.tuningSessionId),
	}),
);

/**
 * Tuning actions — append-only action log backing session-scoped undo
 * (migration v30, docs/setup-engineer-flow-design.md §Phase 9). Every mutating
 * op (apply/branch/add-base/import/set-head/delete/restore/rename/exclude)
 * records its inverse here. `inversePayload` holds only small JSON refs (created
 * testId, prior head, prior lap stamps) — no blobs — so full-session depth is
 * cheap. `tuningSessionId` is a soft ref (no FK; SQLite can't ALTER-ADD one,
 * matching the laps.tuning_session_id precedent).
 */
export const tuningActions = sqliteTable(
	"tuning_actions",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		tuningSessionId: integer("tuning_session_id").notNull(),
		kind: text("kind").notNull(),
		inversePayload: text("inverse_payload"), // JSON
		undone: integer("undone", { mode: "boolean" }).notNull().default(false),
		createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
	},
	(table) => ({
		sessionIdx: index("idx_tuning_actions_session").on(table.tuningSessionId),
	}),
);

/**
 * Cached AI comparison analyses keyed on a lap pair.
 * lapAId/lapBId are stored in canonical order (min, max).
 * `kind` discriminates the analysis type — currently only "inputs" but kept
 * generic so additional comparison analyses can share the table.
 */
export const compareAnalyses = sqliteTable(
	"compare_analyses",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		lapAId: integer("lap_a_id").notNull(),
		lapBId: integer("lap_b_id").notNull(),
		kind: text("kind").notNull().default("inputs"),
		analysis: text("analysis").notNull(),
		inputTokens: integer("input_tokens").notNull().default(0),
		outputTokens: integer("output_tokens").notNull().default(0),
		costUsd: real("cost_usd").notNull().default(0),
		durationMs: integer("duration_ms").notNull().default(0),
		model: text("model").notNull().default(""),
		createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
	},
	(table) => [unique().on(table.lapAId, table.lapBId, table.kind)],
);
