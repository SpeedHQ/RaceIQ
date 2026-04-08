import {
  sqliteTable,
  text,
  integer,
  real,
  blob,
  index,
  unique,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const profiles = sqliteTable("profiles", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const tunes = sqliteTable(
  "tunes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
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
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => ({
    carIdx: index("idx_tunes_car").on(table.carOrdinal),
  })
);

export const sessions = sqliteTable("sessions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  carOrdinal: integer("car_ordinal").notNull(),
  trackOrdinal: integer("track_ordinal").notNull(),
  gameId: text("game_id").notNull().default("fm-2023"),
  sessionType: text("session_type"),
  notes: text("notes"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
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
    carSetup: text("car_setup"),  // JSON snapshot of F1CarSetup
    tuneId: integer("tune_id").references(() => tunes.id, { onDelete: "set null" }),
    telemetry: blob("telemetry", { mode: "buffer" }).notNull(),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => ({
    sessionIdx: index("idx_laps_session").on(table.sessionId),
  })
);

export const tuneAssignments = sqliteTable(
  "tune_assignments",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    carOrdinal: integer("car_ordinal").notNull(),
    trackOrdinal: integer("track_ordinal").notNull(),
    tuneId: integer("tune_id")
      .notNull()
      .references(() => tunes.id, { onDelete: "cascade" }),
  },
  (table) => ({
    carTrackUnique: unique().on(table.carOrdinal, table.trackOrdinal),
    tuneIdx: index("idx_assignments_tune").on(table.tuneId),
  })
);

export const trackOutlines = sqliteTable(
  "track_outlines",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    trackOrdinal: integer("track_ordinal").notNull(),
    gameId: text("game_id").notNull().default("fm-2023"),
    outline: blob("outline", { mode: "buffer" }).notNull(), // gzip'd JSON array of {x,z,speed}
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
    sectors: text("sectors"), // JSON string of TrackSectors {s1End, s2End} or null
  },
  (table) => ({
    trackIdx: index("idx_outlines_track").on(table.trackOrdinal),
    trackGameUnique: unique().on(table.trackOrdinal, table.gameId),
  })
);

export const trackCorners = sqliteTable(
  "track_corners",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    trackOrdinal: integer("track_ordinal").notNull(),
    gameId: text("game_id").notNull().default("fm-2023"),
    cornerIndex: integer("corner_index").notNull(),
    label: text("label").notNull(),
    distanceStart: real("distance_start").notNull(),
    distanceEnd: real("distance_end").notNull(),
    isAuto: integer("is_auto", { mode: "boolean" }).notNull().default(true),
  },
  (table) => ({
    trackIdx: index("idx_corners_track").on(table.trackOrdinal),
    trackCornerUnique: unique().on(table.trackOrdinal, table.gameId, table.cornerIndex),
  })
);

export const lapAnalyses = sqliteTable("lap_analyses", {
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
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
}, (table) => [
  unique().on(table.lapId),
]);
