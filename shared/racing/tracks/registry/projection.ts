import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { GameId } from "../../../games/ids";
import { TRACK_REGISTRY_VERSION, writeGeneratedTrackRegistry } from "../registry";
import { renderTrackRegistryReport } from "./report";
import {
  TRACK_GAME_ORDER,
  TRACK_REGISTRY_SOURCE_VERSION,
  deriveLayoutSlug,
  deriveLayoutVenuePath,
  deriveVenueParent,
  deriveVenueSlug,
  removeIfExists,
  renderTrackRegistrySource,
  resolveTrackRegistryLocations,
  sha256OverSourceFiles,
  validateTrackConfigurationSource,
  writeAtomicFile,
  writeFile,
  type TrackRegistryLocationsInput,
  type TrackRegistrySource,
} from "./source";
/** Deterministic readback of generated SQLite schema and every registry row. */
export interface TrackRegistryProjectionSnapshot {
  userVersion: number;
  schema: Array<{
    type: "index" | "table";
    name: string;
    tbl_name: string;
    sql: string;
  }>;
  sourceVersion: number;
  sourceHash: string;
  venueNodes: Array<{
    path: string;
    parent_path: string | null;
    slug: string;
    name: string;
    depth: number;
  }>;
  layouts: Array<{
    canonical_id: string;
    venue_path: string;
    slug: string;
    name: string;
    facts_slug: string | null;
  }>;
  assignments: Array<{
    game_id: GameId;
    track_ordinal: number;
    layout_id: string;
    confirmed_at: string | null;
    confirmed_by: string | null;
    commit_id: string | null;
  }>;
  facts: Array<{
    slug: string;
    track_slug: string;
    layout_slug: string;
    layout_name: string;
    name: string;
    source: string | null;
  }>;
  corners: Array<{
    facts_slug: string;
    sequence: number;
    turn_number: number;
    name: string;
    direction: "left" | "right" | null;
    group_name: string | null;
  }>;
  covers: Array<{
    facts_slug: string;
    corner_sequence: number;
    turn_number: number;
  }>;
  straights: Array<{
    facts_slug: string;
    after_turn: number;
    name: string;
    group_name: string | null;
  }>;
  geometry: Array<{
    facts_slug: string;
    game_id: GameId;
    sector_1_end: number | null;
    sector_2_end: number | null;
    sector_source: string | null;
  }>;
  segments: Array<{
    facts_slug: string;
    game_id: GameId;
    sequence: number;
    segment_key: string;
    start_fraction: number;
    end_fraction: number;
  }>;
  verification: Array<{
    kind: "meta" | "segments";
    facts_slug: string;
    game_id: string;
    data_hash: string;
    verified_date: string;
    verified_by: string | null;
    note: string | null;
  }>;
}
/** @internal Remove existing generated rows while preserving schema. */
export function clearTrackRegistryProjection(database: Database): void {
  database.query("DELETE FROM registry_metadata").run();
  database.query("DELETE FROM curation_verification").run();
  database.query("DELETE FROM game_geometry_segments").run();
  database.query("DELETE FROM game_geometry").run();
  database.query("DELETE FROM track_corner_covers").run();
  database.query("DELETE FROM track_straights").run();
  database.query("DELETE FROM track_corners").run();
  database.query("DELETE FROM game_tracks").run();
  database.query("DELETE FROM layouts").run();
  const venues = database.query("SELECT path FROM venue_nodes ORDER BY depth DESC, path DESC").all() as Array<{ path: string }>;
  const deleteVenue = database.prepare("DELETE FROM venue_nodes WHERE path = ?");
  for (const venue of venues) deleteVenue.run(venue.path);
  database.query("DELETE FROM track_facts").run();
}

/** @internal Insert canonical source into initialized registry schema. */
export function insertTrackRegistryProjection(database: Database, source: TrackRegistrySource, sourceHash: string): void {
  const insertVenue = database.prepare("INSERT INTO venue_nodes (path, parent_path, slug, name, depth) VALUES (?, ?, ?, ?, ?)");
  const insertLayout = database.prepare("INSERT INTO layouts (canonical_id, venue_path, slug, name, facts_slug) VALUES (?, ?, ?, ?, ?)");
  const insertAssignment = database.prepare("INSERT INTO game_tracks (game_id, track_ordinal, layout_id, confirmed_at, confirmed_by, commit_id) VALUES (?, ?, ?, ?, ?, ?)");
  const insertFact = database.prepare("INSERT INTO track_facts (slug, track_slug, layout_slug, layout_name, name, source) VALUES (?, ?, ?, ?, ?, ?)");
  const insertCorner = database.prepare("INSERT INTO track_corners (facts_slug, sequence, turn_number, name, direction, group_name) VALUES (?, ?, ?, ?, ?, ?)");
  const insertCover = database.prepare("INSERT INTO track_corner_covers (facts_slug, corner_sequence, turn_number) VALUES (?, ?, ?)");
  const insertStraight = database.prepare("INSERT INTO track_straights (facts_slug, after_turn, name, group_name) VALUES (?, ?, ?, ?)");
  const insertGeometry = database.prepare("INSERT INTO game_geometry (facts_slug, game_id, sector_1_end, sector_2_end, sector_source) VALUES (?, ?, ?, ?, ?)");
  const insertSegment = database.prepare("INSERT INTO game_geometry_segments (facts_slug, game_id, sequence, segment_key, start_fraction, end_fraction) VALUES (?, ?, ?, ?, ?, ?)");
  const insertVerification = database.prepare("INSERT INTO curation_verification (kind, facts_slug, game_id, data_hash, verified_date, verified_by, note) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const insertMetadata = database.prepare("INSERT INTO registry_metadata (key, value) VALUES (?, ?)");

  for (const fact of source.facts.facts) {
    insertFact.run(fact.slug, fact.track, fact.layout, fact.layoutName, fact.name, fact.source ?? null);
  }

  const venues = source.configurations.venues
    .map((venue) => {
      const parentPath = deriveVenueParent(venue.id);
      return {
        path: venue.id,
        parentPath,
        slug: deriveVenueSlug(venue.id),
        name: venue.name,
        depth: parentPath ? parentPath.split("/").length : 0,
      };
    })
    .sort((a, b) => a.depth - b.depth || a.path.localeCompare(b.path));
  for (const venue of venues) {
    insertVenue.run(venue.path, venue.parentPath, venue.slug, venue.name, venue.depth);
  }

  for (const layout of source.configurations.layouts) {
    insertLayout.run(layout.id, deriveLayoutVenuePath(layout.id), deriveLayoutSlug(layout.id), layout.name, layout.factsSlug ?? null);
  }
  for (const assignment of source.configurations.assignments) {
    insertAssignment.run(
      assignment.gameId,
      assignment.trackOrdinal,
      assignment.layoutId,
      assignment.confirmation?.confirmedAt ?? null,
      assignment.confirmation?.confirmedBy ?? null,
      assignment.confirmation?.commitId ?? null,
    );
  }

  for (const fact of source.facts.facts) {
    fact.corners.forEach((corner, sequence) => {
      insertCorner.run(fact.slug, sequence, corner.number, corner.name, corner.direction ?? null, corner.group ?? null);
    });
  }
  for (const fact of source.facts.facts) {
    fact.corners.forEach((corner, sequence) => {
      for (const covered of corner.covers ?? []) insertCover.run(fact.slug, sequence, covered);
    });
    for (const straight of fact.straights ?? []) {
      insertStraight.run(fact.slug, straight.after, straight.name, straight.group ?? null);
    }
  }

  for (const row of source.geometry.geometry) {
    insertGeometry.run(row.factsSlug, row.gameId, row.sectors?.s1End ?? null, row.sectors?.s2End ?? null, row.sectors?.source ?? null);
  }
  for (const row of source.geometry.geometry) {
    row.segments.forEach((segment, sequence) => {
      insertSegment.run(row.factsSlug, row.gameId, sequence, segment.key, segment.startFrac, segment.endFrac);
    });
  }

  for (const [key, entry] of Object.entries(source.verification.entries)) {
    const meta = /^meta:(.+)$/.exec(key);
    const segments = /^segments:([^/]+)\/(.+)$/.exec(key);
    if (!meta && !segments) throw new Error(`Invalid verification key ${key}`);
    insertVerification.run(meta ? "meta" : "segments", meta?.[1] ?? segments![2], segments?.[1] ?? "", entry.hash, entry.date, entry.by ?? null, entry.note ?? null);
  }
  insertMetadata.run("sourceVersion", String(TRACK_REGISTRY_SOURCE_VERSION));
  insertMetadata.run("sourceHash", sourceHash);
}
/** @internal Build isolated SQLite projection and verify database integrity. */
export function compileTrackRegistryProjection(source: TrackRegistrySource, targetDatabasePath: string): TrackRegistryProjectionSnapshot {
  const canonical = validateTrackConfigurationSource(source);

  const sourceHash = sha256OverSourceFiles(renderTrackRegistrySource(canonical));

  mkdirSync(dirname(targetDatabasePath), { recursive: true });
  const database = new Database(targetDatabasePath);

  try {
    database.exec("PRAGMA foreign_keys = ON");
    database.exec(`
      CREATE TABLE venue_nodes (
        path TEXT PRIMARY KEY,
        parent_path TEXT REFERENCES venue_nodes(path) ON UPDATE CASCADE ON DELETE RESTRICT,
        slug TEXT NOT NULL,
        name TEXT NOT NULL,
        depth INTEGER NOT NULL CHECK (depth >= 0),
        UNIQUE (parent_path, slug)
      ) WITHOUT ROWID;

      CREATE TABLE layouts (
        canonical_id TEXT PRIMARY KEY,
        venue_path TEXT NOT NULL REFERENCES venue_nodes(path) ON UPDATE CASCADE ON DELETE RESTRICT,
        slug TEXT NOT NULL,
        name TEXT NOT NULL,
        facts_slug TEXT REFERENCES track_facts(slug) ON UPDATE CASCADE ON DELETE SET NULL,
        UNIQUE (venue_path, slug)
      ) WITHOUT ROWID;

      CREATE TABLE game_tracks (
        game_id TEXT NOT NULL,
        track_ordinal INTEGER NOT NULL CHECK (track_ordinal >= 0),
        layout_id TEXT NOT NULL REFERENCES layouts(canonical_id) ON UPDATE CASCADE ON DELETE RESTRICT,
        confirmed_at TEXT,
        confirmed_by TEXT,
        commit_id TEXT,
        PRIMARY KEY (game_id, track_ordinal),
        CHECK ((confirmed_at IS NULL AND confirmed_by IS NULL AND commit_id IS NULL) OR (confirmed_at IS NOT NULL AND confirmed_by IS NOT NULL))
      ) WITHOUT ROWID;

      CREATE TABLE track_facts (
        slug TEXT PRIMARY KEY,
        track_slug TEXT NOT NULL,
        layout_slug TEXT NOT NULL,
        layout_name TEXT NOT NULL,
        name TEXT NOT NULL,
        source TEXT
      ) WITHOUT ROWID;

      CREATE TABLE track_corners (
        facts_slug TEXT NOT NULL REFERENCES track_facts(slug) ON UPDATE CASCADE ON DELETE CASCADE,
        sequence INTEGER NOT NULL CHECK (sequence >= 0),
        turn_number INTEGER NOT NULL CHECK (turn_number > 0),
        name TEXT NOT NULL,
        direction TEXT CHECK (direction IN ('left', 'right')),
        group_name TEXT,
        PRIMARY KEY (facts_slug, sequence),
        UNIQUE (facts_slug, turn_number)
      ) WITHOUT ROWID;

      CREATE TABLE track_corner_covers (
        facts_slug TEXT NOT NULL,
        corner_sequence INTEGER NOT NULL,
        turn_number INTEGER NOT NULL CHECK (turn_number > 0),
        PRIMARY KEY (facts_slug, corner_sequence, turn_number),
        UNIQUE (facts_slug, turn_number),
        FOREIGN KEY (facts_slug, corner_sequence) REFERENCES track_corners(facts_slug, sequence) ON UPDATE CASCADE ON DELETE CASCADE
      ) WITHOUT ROWID;

      CREATE TABLE track_straights (
        facts_slug TEXT NOT NULL REFERENCES track_facts(slug) ON UPDATE CASCADE ON DELETE CASCADE,
        after_turn INTEGER NOT NULL CHECK (after_turn > 0),
        name TEXT NOT NULL,
        group_name TEXT,
        PRIMARY KEY (facts_slug, after_turn)
      ) WITHOUT ROWID;

      CREATE TABLE game_geometry (
        facts_slug TEXT NOT NULL REFERENCES track_facts(slug) ON UPDATE CASCADE ON DELETE CASCADE,
        game_id TEXT NOT NULL,
        sector_1_end REAL,
        sector_2_end REAL,
        sector_source TEXT,
        PRIMARY KEY (facts_slug, game_id),
        CHECK ((sector_1_end IS NULL AND sector_2_end IS NULL) OR (sector_1_end > 0 AND sector_1_end < sector_2_end AND sector_2_end < 1))
      ) WITHOUT ROWID;

      CREATE TABLE game_geometry_segments (
        facts_slug TEXT NOT NULL,
        game_id TEXT NOT NULL,
        sequence INTEGER NOT NULL CHECK (sequence >= 0),
        segment_key TEXT NOT NULL,
        start_fraction REAL NOT NULL CHECK (start_fraction >= 0 AND start_fraction <= 1),
        end_fraction REAL NOT NULL CHECK (end_fraction >= 0 AND end_fraction <= 1),
        PRIMARY KEY (facts_slug, game_id, sequence),
        FOREIGN KEY (facts_slug, game_id) REFERENCES game_geometry(facts_slug, game_id) ON UPDATE CASCADE ON DELETE CASCADE
      ) WITHOUT ROWID;

      CREATE TABLE curation_verification (
        kind TEXT NOT NULL CHECK (kind IN ('meta', 'segments')),
        facts_slug TEXT NOT NULL REFERENCES track_facts(slug) ON UPDATE CASCADE ON DELETE CASCADE,
        game_id TEXT NOT NULL DEFAULT '',
        data_hash TEXT NOT NULL,
        verified_date TEXT NOT NULL,
        verified_by TEXT,
        note TEXT,
        PRIMARY KEY (kind, facts_slug, game_id),
        CHECK ((kind = 'meta' AND game_id = '') OR (kind = 'segments' AND game_id <> ''))
      ) WITHOUT ROWID;

      CREATE INDEX game_tracks_layout_idx ON game_tracks(layout_id);
      CREATE INDEX layouts_facts_idx ON layouts(facts_slug);

      CREATE TABLE registry_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        CHECK (key IN ('sourceVersion', 'sourceHash'))
      ) WITHOUT ROWID;
    `);

    database.exec(`PRAGMA user_version = ${TRACK_REGISTRY_VERSION}`);

    database.transaction(() => insertTrackRegistryProjection(database, canonical, sourceHash))();

    const keyCheck = database.query("PRAGMA foreign_key_check").all() as Array<{ table: string; rowid: number; parent: string; fkid: string }>;
    if (keyCheck.length > 0) {
      throw new Error(`Track registry foreign key check failed: ${JSON.stringify(keyCheck)}`);
    }

    const [integrity] = database.query("PRAGMA integrity_check").all() as Array<{ integrity_check: string }>;
    if (!integrity || integrity.integrity_check !== "ok") {
      throw new Error(`Track registry integrity check failed: ${integrity?.integrity_check ?? "unknown"}`);
    }
  } finally {
    database.close();
  }
  return readTrackRegistryProjection(targetDatabasePath);
}

/** Build source-bound SQLite and JSON report artifacts with atomic replacement. */
export function buildTrackRegistryArtifacts(
  source: TrackRegistrySource,
  locations: TrackRegistryLocationsInput = {},
): { sourceHash: string; projection: TrackRegistryProjectionSnapshot; report: string } {
  const resolved = resolveTrackRegistryLocations(locations);
  const canonical = validateTrackConfigurationSource(source);
  const rendered = renderTrackRegistrySource(canonical);
  const sourceHash = sha256OverSourceFiles(rendered);
  const nonce = randomBytes(8).toString("hex");
  const stagedDatabase = `${resolved.databasePath}.build.${nonce}.tmp`;
  const stagedReport = `${resolved.reportPath}.build.${nonce}.tmp`;
  const databaseBackup = `${resolved.databasePath}.build.${nonce}.backup`;
  const reportBackup = `${resolved.reportPath}.build.${nonce}.backup`;

  try {
    const projection = compileTrackRegistryProjection(canonical, stagedDatabase);
    Bun.gc(true);
    const report = renderTrackRegistryReport(projection);
    writeFile(stagedReport, report);
    if (resolve(resolved.databasePath) === resolve(resolveTrackRegistryLocations().databasePath)) {
      writeGeneratedTrackRegistry((database) => {
        clearTrackRegistryProjection(database);
        insertTrackRegistryProjection(database, canonical, sourceHash);
      });
      const committedProjection = readTrackRegistryProjection(resolved.databasePath);
      writeAtomicFile(resolved.reportPath, renderTrackRegistryReport(committedProjection));
      return {
        sourceHash,
        projection: committedProjection,
        report: renderTrackRegistryReport(committedProjection),
      };
    }
    if (existsSync(resolved.databasePath)) copyFileSync(resolved.databasePath, databaseBackup);
    if (existsSync(resolved.reportPath)) copyFileSync(resolved.reportPath, reportBackup);
    try {
      removeIfExists(resolved.databasePath);
      removeIfExists(resolved.reportPath);
      renameSync(stagedDatabase, resolved.databasePath);
      renameSync(stagedReport, resolved.reportPath);
    } catch (error) {
      if (existsSync(databaseBackup)) copyFileSync(databaseBackup, resolved.databasePath);
      else removeIfExists(resolved.databasePath);
      if (existsSync(reportBackup)) copyFileSync(reportBackup, resolved.reportPath);
      else removeIfExists(resolved.reportPath);
      throw error;
    }
    return { sourceHash, projection, report };
  } finally {
    removeIfExists(stagedDatabase);
    removeIfExists(stagedReport);
    removeIfExists(databaseBackup);
    removeIfExists(reportBackup);
  }
}
/** Validate and read complete generated SQLite registry into deterministic snapshot. */
export function readTrackRegistryProjection(databasePath: string): TrackRegistryProjectionSnapshot {
  if (!existsSync(databasePath)) {
    throw new Error(`Missing track registry database ${databasePath}`);
  }

  const database = new Database(databasePath, { readonly: true, create: false, strict: true });
  try {
    const versionRow = database.query("PRAGMA user_version").get() as { user_version: number };
    if (versionRow.user_version !== TRACK_REGISTRY_VERSION) {
      throw new Error(`Unsupported track registry version ${versionRow.user_version}; expected ${TRACK_REGISTRY_VERSION}`);
    }

    const metadataRows = database.query("SELECT key, value FROM registry_metadata ORDER BY key").all() as Array<{ key: string; value: string }>;
    if (metadataRows.length !== 2 || metadataRows[0]?.key !== "sourceHash" || metadataRows[1]?.key !== "sourceVersion") {
      throw new Error("Invalid registry metadata");
    }
    const metadata = Object.fromEntries(metadataRows.map((row) => [row.key, row.value]));
    const sourceVersion = Number(metadata.sourceVersion);
    const sourceHash = metadata.sourceHash;
    if (sourceVersion !== TRACK_REGISTRY_SOURCE_VERSION || typeof sourceHash !== "string" || !/^[0-9a-f]{64}$/.test(sourceHash)) {
      throw new Error("Invalid registry metadata");
    }

    const schema = database
      .query(`
      SELECT type, name, tbl_name, sql
        FROM sqlite_master
       WHERE type IN ('table', 'index') AND name NOT LIKE 'sqlite_%'
       ORDER BY type, name
    `)
      .all() as TrackRegistryProjectionSnapshot["schema"];

    const venueNodes = database.query("SELECT path, parent_path, slug, name, depth FROM venue_nodes ORDER BY path").all() as Array<{
      path: string;
      parent_path: string | null;
      slug: string;
      name: string;
      depth: number;
    }>;

    const layouts = database.query("SELECT canonical_id, venue_path, slug, name, facts_slug FROM layouts ORDER BY canonical_id").all() as Array<{
      canonical_id: string;
      venue_path: string;
      slug: string;
      name: string;
      facts_slug: string | null;
    }>;

    const assignments = database.query("SELECT game_id AS gameId, track_ordinal, layout_id, confirmed_at, confirmed_by, commit_id FROM game_tracks").all() as Array<{
      gameId: GameId;
      track_ordinal: number;
      layout_id: string;
      confirmed_at: string | null;
      confirmed_by: string | null;
      commit_id: string | null;
    }>;

    const facts = database.query("SELECT slug, track_slug, layout_slug, layout_name, name, source FROM track_facts ORDER BY slug").all() as Array<{
      slug: string;
      track_slug: string;
      layout_slug: string;
      layout_name: string;
      name: string;
      source: string | null;
    }>;

    const corners = database.query("SELECT facts_slug, sequence, turn_number, name, direction, group_name FROM track_corners ORDER BY facts_slug, sequence").all() as Array<{
      facts_slug: string;
      sequence: number;
      turn_number: number;
      name: string;
      direction: "left" | "right" | null;
      group_name: string | null;
    }>;

    const covers = database.query("SELECT facts_slug, corner_sequence, turn_number FROM track_corner_covers ORDER BY facts_slug, corner_sequence, turn_number").all() as Array<{
      facts_slug: string;
      corner_sequence: number;
      turn_number: number;
    }>;

    const straights = database.query("SELECT facts_slug, after_turn, name, group_name FROM track_straights ORDER BY facts_slug, after_turn").all() as Array<{
      facts_slug: string;
      after_turn: number;
      name: string;
      group_name: string | null;
    }>;

    const geometry = database.query("SELECT facts_slug, game_id, sector_1_end, sector_2_end, sector_source FROM game_geometry ORDER BY game_id, facts_slug").all() as Array<{
      facts_slug: string;
      game_id: GameId;
      sector_1_end: number | null;
      sector_2_end: number | null;
      sector_source: string | null;
    }>;

    const segments = database
      .query("SELECT facts_slug, game_id, sequence, segment_key, start_fraction, end_fraction FROM game_geometry_segments ORDER BY facts_slug, game_id, sequence")
      .all() as Array<{
      facts_slug: string;
      game_id: GameId;
      sequence: number;
      segment_key: string;
      start_fraction: number;
      end_fraction: number;
    }>;

    const verification = database.query("SELECT kind, facts_slug, game_id, data_hash, verified_date, verified_by, note FROM curation_verification ORDER BY kind, facts_slug, game_id").all() as Array<{
      kind: "meta" | "segments";
      facts_slug: string;
      game_id: string;
      data_hash: string;
      verified_date: string;
      verified_by: string | null;
      note: string | null;
    }>;

    return {
      userVersion: versionRow.user_version,
      schema,
      sourceVersion,
      sourceHash,
      venueNodes,
      layouts,
      assignments: assignments
        .map((assignment) => ({
          game_id: assignment.gameId,
          track_ordinal: assignment.track_ordinal,
          layout_id: assignment.layout_id,
          confirmed_at: assignment.confirmed_at,
          confirmed_by: assignment.confirmed_by,
          commit_id: assignment.commit_id,
        }))
        .sort((a, b) => {
          const byGame = TRACK_GAME_ORDER[a.game_id] - TRACK_GAME_ORDER[b.game_id];
          return byGame || a.track_ordinal - b.track_ordinal;
        }),
      facts,
      corners,
      covers,
      straights,
      geometry: geometry.sort((a, b) => {
        const byGame = TRACK_GAME_ORDER[a.game_id] - TRACK_GAME_ORDER[b.game_id];
        return byGame || a.facts_slug.localeCompare(b.facts_slug);
      }),
      segments: segments.sort((a, b) => {
        const byGame = TRACK_GAME_ORDER[a.game_id] - TRACK_GAME_ORDER[b.game_id];
        return byGame || a.facts_slug.localeCompare(b.facts_slug) || a.sequence - b.sequence;
      }),
      verification,
    };
  } finally {
    database.close();
  }
}
