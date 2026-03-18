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

export const sessions = sqliteTable("sessions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  carOrdinal: integer("car_ordinal").notNull(),
  trackOrdinal: integer("track_ordinal").notNull(),
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
    telemetry: blob("telemetry", { mode: "buffer" }).notNull(),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => ({
    sessionIdx: index("idx_laps_session").on(table.sessionId),
  })
);

export const trackOutlines = sqliteTable(
  "track_outlines",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    trackOrdinal: integer("track_ordinal").notNull().unique(),
    outline: blob("outline", { mode: "buffer" }).notNull(), // gzip'd JSON array of {x,z,speed}
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => ({
    trackIdx: index("idx_outlines_track").on(table.trackOrdinal),
  })
);

export const trackCorners = sqliteTable(
  "track_corners",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    trackOrdinal: integer("track_ordinal").notNull(),
    cornerIndex: integer("corner_index").notNull(),
    label: text("label").notNull(),
    distanceStart: real("distance_start").notNull(),
    distanceEnd: real("distance_end").notNull(),
    isAuto: integer("is_auto", { mode: "boolean" }).notNull().default(true),
  },
  (table) => ({
    trackIdx: index("idx_corners_track").on(table.trackOrdinal),
    trackCornerUnique: unique().on(table.trackOrdinal, table.cornerIndex),
  })
);
