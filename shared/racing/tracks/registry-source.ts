import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

import { z } from "zod";

import { SHARED_DIR } from "@shared/platform/runtime/data-paths";
import { KNOWN_GAME_IDS, type GameId, GameIdSchema } from "../../games/ids";
import {
  type TrackConfigurationConfirmation,
  TrackConfigurationConfirmationSchema,
  TrackVenueIdSchema,
} from "./configuration";
import { TrackFactsSchema, type CornerFact, type StraightFact } from "./facts";
import {
  GeometrySegmentSchema,
  TrackGeometrySchema,
} from "./geometry";
import { parseCornerKey, parseStraightKey } from "./keys";
import { TRACK_REGISTRY_VERSION, writeGeneratedTrackRegistry } from "./registry";
export const TRACK_REGISTRY_SOURCE_VERSION = 1 as const;

export interface TrackRegistryLocations {
  sourceDirectory: string;
  databasePath: string;
  reportPath: string;
  transactionPath: string;
}

export interface TrackRegistryLocationsInput {
  sourceDirectory?: string;
  databasePath?: string;
  reportPath?: string;
  transactionPath?: string;
}

const TRACK_FACT_ID = /^[a-z0-9][a-z0-9-]*$/;

const TrackFactIdSchema = z.string().regex(TRACK_FACT_ID, "Use lowercase letters, digits, and hyphens");

const TrackIdentityNodeSchema = z.object({
  id: TrackVenueIdSchema,
  name: z.string().trim().min(1),
}).strict();

const TrackLayoutSchema = z.object({
  id: TrackVenueIdSchema,
  name: z.string().trim().min(1),
  factsSlug: TrackFactIdSchema.optional(),
}).strict();

const TrackAssignmentSchema = z.object({
  gameId: GameIdSchema,
  trackOrdinal: z.number().int().nonnegative(),
  layoutId: TrackVenueIdSchema,
  confirmation: TrackConfigurationConfirmationSchema.strict().nullable(),
}).strict();

const TrackConfigurationsSchema = z.object({
  version: z.literal(TRACK_REGISTRY_SOURCE_VERSION),
  venues: z.array(TrackIdentityNodeSchema),
  layouts: z.array(TrackLayoutSchema),
  assignments: z.array(TrackAssignmentSchema),
}).strict();

const TrackFactsFileSchema = z.object({
  version: z.literal(TRACK_REGISTRY_SOURCE_VERSION),
  facts: z.array(TrackFactsSchema.strict()),
}).strict();

const GeometrySectorsSchema = TrackGeometrySchema.shape.sectors;

const TrackGeometryFileRowSchema = z.object({
  factsSlug: TrackFactIdSchema,
  gameId: GameIdSchema,
  sectors: GeometrySectorsSchema,
  segments: z.array(GeometrySegmentSchema.strict()),
}).strict();

const TrackGeometryFileSchema = z.object({
  version: z.literal(TRACK_REGISTRY_SOURCE_VERSION),
  geometry: z.array(TrackGeometryFileRowSchema),
}).strict();

const VerifiedEntrySchema = z.object({
  hash: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  by: z.string().trim().min(1).optional(),
  note: z.string().trim().min(1).optional(),
}).strict();

const TrackVerificationFileSchema = z.object({
  version: z.literal(TRACK_REGISTRY_SOURCE_VERSION),
  entries: z.record(z.string(), VerifiedEntrySchema),
}).strict();

export type TrackConfigurationSource = z.infer<typeof TrackConfigurationsSchema>;
export type TrackFactsSource = z.infer<typeof TrackFactsFileSchema>;
export type TrackGeometrySource = z.infer<typeof TrackGeometryFileSchema>;
export type TrackVerificationSource = z.infer<typeof TrackVerificationFileSchema>;

export interface VerifiedEntry {
  hash: string;
  date: string;
  by?: string;
  note?: string;
}

export type VerifiedLedger = Record<string, VerifiedEntry>;

export interface TrackRegistrySource {
  configurations: TrackConfigurationSource;
  facts: TrackFactsSource;
  geometry: TrackGeometrySource;
  verification: TrackVerificationSource;
}

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

export interface TrackRegistryReport {
  sourceVersion: number;
  sourceHash: string;
  recordCounts: {
    venues: number;
    layouts: number;
    assignments: number;
    facts: number;
    corners: number;
    covers: number;
    straights: number;
    geometry: number;
    geometrySegments: number;
    verification: number;
  };
  trackIdentities: Array<{
    gameId: GameId;
    trackOrdinal: number;
    layoutId: string;
    factsSlug: string | null;
  }>;
  geometrySectors: Array<{
    gameId: GameId;
    factsSlug: string;
    s1End: number | null;
    s2End: number | null;
    source: string | null;
  }>;
  facts: Array<{
    slug: string;
    track: string;
    layout: string;
    layoutName: string;
    name: string;
    source?: string;
    corners: Array<{
      sequence: number;
      number: number;
      covers?: number[];
      name: string;
      direction?: "left" | "right";
      group?: string;
    }>;
    straights?: Array<{
      after: number;
      name: string;
      group?: string;
    }>;
  }>;
  aliases: Array<{
    layoutId: string;
    factsSlug: string | null;
    assignments: Array<{
      gameId: GameId;
      trackOrdinal: number;
    }>;
  }>;
  orphanedReferences: {
    assignments: Array<{ gameId: string; trackOrdinal: number; layoutId: string }>;
    geometry: Array<{ gameId: string; factsSlug: string }>;
    verification: Array<{ kind: string; gameId: string; factsSlug: string }>; 
  };
  unlinked: {
    layoutsWithoutFacts: string[];
    factsWithoutLayouts: string[];
  };
}

interface TrackRegistryUpdateJournal {
  version: number;
  oldSourceHash: string;
  newSourceHash: string;
  sourceBackups: Record<string, string>;
  sourceStaged: Record<string, string>;
  databaseBackup: string;
  databaseStaged: string;
  reportBackup: string;
  reportStaged: string;
}

const TRACK_SOURCE_FILES = ["configurations.json", "facts.json", "geometry.json", "verification.json"] as const;
const CONFIGURATIONS_FILE = TRACK_SOURCE_FILES[0];
const FACTS_FILE = TRACK_SOURCE_FILES[1];
const GEOMETRY_FILE = TRACK_SOURCE_FILES[2];
const VERIFICATION_FILE = TRACK_SOURCE_FILES[3];

const GAME_ORDER = Object.fromEntries(KNOWN_GAME_IDS.map((gameId, index) => [gameId, index])) as Record<string, number>;


function jsonBytes(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function parseIsoDate(value: string, path: string): void {
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) {
    throw new Error(`${path}: invalid date ${value}`);
  }
}

function sha256OverSourceFiles(files: ReadonlyMap<string, string>): string {
  const hash = createHash("sha256");
  for (const filename of TRACK_SOURCE_FILES) {
    const body = files.get(filename);
    if (body === undefined) {
      throw new Error(`Missing source file body for ${filename}`);
    }
    hash.update(filename).update("\0").update(body);
  }
  return hash.digest("hex");
}


function deriveVenueParent(path: string): string | null {
  const index = path.lastIndexOf("/");
  return index <= 0 ? null : path.slice(0, index);
}

function deriveVenueSlug(path: string): string {
  const index = path.lastIndexOf("/");
  return path.slice(index + 1);
}

function deriveLayoutVenuePath(id: string): string {
  const index = id.lastIndexOf("/");
  return index <= 0 ? id : id.slice(0, index);
}

function deriveLayoutSlug(id: string): string {
  return deriveVenueSlug(id);
}

function readFile(path: string): string {
  if (!existsSync(path)) throw new Error(`Missing track registry file ${path}`);
  return readFileSync(path, "utf8");
}

function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

function removeIfExists(path: string): void {
  if (!existsSync(path)) return;
  try {
    unlinkSync(path);
  } catch {
    // best effort
  }
}

export function resolveTrackRegistryLocations(locations: TrackRegistryLocationsInput = {}): TrackRegistryLocations {
  const overrideRoot =
    process.env.RACEIQ_TRACK_REGISTRY_DIR &&
    (process.env.RACEIQ_TEST_MODE === "1" || process.env.NODE_ENV === "test" || process.env.RACEIQ_E2E === "1")
      ? resolve(process.env.RACEIQ_TRACK_REGISTRY_DIR)
      : null;
  const tracksRoot = overrideRoot ?? resolve(SHARED_DIR, "tracks");
  const defaultLocations: TrackRegistryLocations = {
    sourceDirectory: resolve(tracksRoot, "registry-source"),
    databasePath: resolve(tracksRoot, "registry.sqlite"),
    reportPath: resolve(tracksRoot, "registry-report.json"),
    transactionPath: resolve(tracksRoot, ".registry-source-update.json"),
  };

  return {
    ...defaultLocations,
    ...locations,
  };
}

function parseSourceDocuments(locations: TrackRegistryLocations): TrackRegistrySource {
  const sourceDirectory = locations.sourceDirectory;
  const [configurations, facts, geometry, verification] = [
    readFile(resolve(sourceDirectory, CONFIGURATIONS_FILE)),
    readFile(resolve(sourceDirectory, FACTS_FILE)),
    readFile(resolve(sourceDirectory, GEOMETRY_FILE)),
    readFile(resolve(sourceDirectory, VERIFICATION_FILE)),
  ].map((contents, index) => {
    const name = TRACK_SOURCE_FILES[index];
    let raw: unknown;
    try {
      raw = JSON.parse(contents);
    } catch (error) {
      throw new Error(`Invalid JSON in ${name}`);
    }
    if (name === CONFIGURATIONS_FILE) return TrackConfigurationsSchema.parse(raw);
    if (name === FACTS_FILE) return TrackFactsFileSchema.parse(raw);
    if (name === GEOMETRY_FILE) return TrackGeometryFileSchema.parse(raw);
    return TrackVerificationFileSchema.parse(raw);
  });

  return {
    configurations,
    facts,
    geometry,
    verification,
  } as TrackRegistrySource;
}

function canonicalizeCorner(corner: CornerFact): CornerFact {
  const covers = (corner.covers ?? []).slice().sort((a, b) => a - b);
  return {
    number: corner.number,
    ...(covers.length ? { covers } : {}),
    name: corner.name,
    ...(corner.direction ? { direction: corner.direction } : {}),
    ...(corner.group ? { group: corner.group } : {}),
  };
}

function canonicalizeStraight(straight: StraightFact): StraightFact {
  return {
    after: straight.after,
    name: straight.name,
    ...(straight.group ? { group: straight.group } : {}),
  };
}

function canonicalizeConfirmation(confirmation: TrackConfigurationConfirmation | null): TrackConfigurationConfirmation | null {
  if (confirmation === null) return null;
  parseIsoDate(confirmation.confirmedAt, "confirmation.confirmedAt");
  return {
    confirmedAt: confirmation.confirmedAt,
    confirmedBy: confirmation.confirmedBy,
    ...(confirmation.commitId ? { commitId: confirmation.commitId.toLowerCase() } : {}),
  };
}

function canonicalizeTrackRegistrySource(source: TrackRegistrySource): TrackRegistrySource {
  const configurations = source.configurations;
  const facts = source.facts;
  const geometry = source.geometry;
  const verification = source.verification;

  const venues = configurations.venues
    .map((venue) => ({
      id: venue.id,
      name: venue.name,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  const layouts = configurations.layouts
    .map((layout) => ({
      id: layout.id,
      name: layout.name,
      ...(layout.factsSlug ? { factsSlug: layout.factsSlug } : {}),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  const assignments = configurations.assignments
    .map((assignment) => ({
      gameId: assignment.gameId,
      trackOrdinal: assignment.trackOrdinal,
      layoutId: assignment.layoutId,
      confirmation: canonicalizeConfirmation(assignment.confirmation),
    }))
    .sort((a, b) => {
      const byGame = (GAME_ORDER[a.gameId] ?? Number.MAX_SAFE_INTEGER) - (GAME_ORDER[b.gameId] ?? Number.MAX_SAFE_INTEGER);
      return byGame !== 0 ? byGame : a.trackOrdinal === b.trackOrdinal ? a.layoutId.localeCompare(b.layoutId) : a.trackOrdinal - b.trackOrdinal;
    });

  const factsSorted = facts.facts
    .map((fact) => {
      const corners = fact.corners.map((corner) => canonicalizeCorner(corner));
      const straights = (fact.straights ?? []).map((straight) => canonicalizeStraight(straight));
      return {
        slug: fact.slug,
        track: fact.track,
        layout: fact.layout,
        layoutName: fact.layoutName,
        name: fact.name,
        ...(fact.source ? { source: fact.source } : {}),
        corners,
        ...(straights.length
          ? { straights: straights.sort((a, b) => a.after - b.after) }
          : {}),
      };
    })
    .sort((a, b) => a.slug.localeCompare(b.slug));

  const geometrySorted = geometry.geometry
    .map((geometryRow) => {
      const segments = geometryRow.segments.map((segment) => ({ ...segment }));
      const sectors = geometryRow.sectors ?? undefined;
      return {
        factsSlug: geometryRow.factsSlug,
        gameId: geometryRow.gameId,
        ...(sectors ? { sectors } : {}),
        segments,
      };
    })
    .sort((a, b) => {
      const byGame = (GAME_ORDER[a.gameId] ?? Number.MAX_SAFE_INTEGER) - (GAME_ORDER[b.gameId] ?? Number.MAX_SAFE_INTEGER);
      return byGame !== 0 ? byGame : a.factsSlug.localeCompare(b.factsSlug);
    });

  const entries: Array<[string, VerifiedEntry]> = Object.entries(verification.entries)
    .map(([key, entry]): [string, VerifiedEntry] => [
      key,
      {
        hash: entry.hash,
        date: entry.date,
        ...(entry.by ? { by: entry.by } : {}),
        ...(entry.note ? { note: entry.note } : {}),
      },
    ])
    .sort(([a], [b]) => a.localeCompare(b));

  return {
    configurations: {
      version: TRACK_REGISTRY_SOURCE_VERSION,
      venues,
      layouts,
      assignments,
    },
    facts: {
      version: TRACK_REGISTRY_SOURCE_VERSION,
      facts: factsSorted,
    },
    geometry: {
      version: TRACK_REGISTRY_SOURCE_VERSION,
      geometry: geometrySorted,
    },
    verification: {
      version: TRACK_REGISTRY_SOURCE_VERSION,
      entries: Object.fromEntries(entries),
    },
  };
}

function validateTrackConfigurationSource(source: TrackRegistrySource): TrackRegistrySource {
  const canonical = canonicalizeTrackRegistrySource(source);

  const errors: string[] = [];
  const venueIds = new Set<string>();
  for (const venue of canonical.configurations.venues) {
    if (venueIds.has(venue.id)) errors.push(`Duplicate venue ${venue.id}`);
    venueIds.add(venue.id);
    const parent = deriveVenueParent(venue.id);
    if (parent && !venueIds.has(parent) && !canonical.configurations.venues.some((candidate) => candidate.id === parent)) {
      errors.push(`Missing parent venue for ${venue.id}: ${parent}`);
    }
  }

  const layoutIds = new Set<string>();
  const assignmentKeys = new Set<string>();
  const layoutVenueMissing: string[] = [];
  const layoutRefsFacts = new Set<string>();
  for (const fact of canonical.facts.facts) {
    if (layoutRefsFacts.has(fact.slug)) errors.push(`Duplicate facts ${fact.slug}`);
    layoutRefsFacts.add(fact.slug);
  }

  for (const layout of canonical.configurations.layouts) {
    if (layoutIds.has(layout.id)) errors.push(`Duplicate layout ${layout.id}`);
    layoutIds.add(layout.id);
    const parent = deriveLayoutVenuePath(layout.id);
    if (!canonical.configurations.venues.some((venue) => venue.id === parent)) {
      layoutVenueMissing.push(layout.id);
    }
    if (layout.factsSlug && !layoutRefsFacts.has(layout.factsSlug)) {
      errors.push(`Layout ${layout.id} references unknown factsSlug ${layout.factsSlug}`);
    }
  }

  if (layoutVenueMissing.length > 0) {
    errors.push(...layoutVenueMissing.map((layout) => `Missing layout venue for ${layout}`));
  }

  const layoutMap = new Set(canonical.configurations.layouts.map((layout) => layout.id));
  for (const assignment of canonical.configurations.assignments) {
    const key = `${assignment.gameId}\0${assignment.trackOrdinal}`;
    if (assignmentKeys.has(key)) {
      errors.push(`Duplicate assignment ${assignment.gameId} #${assignment.trackOrdinal}`);
    }
    assignmentKeys.add(key);
    if (!layoutMap.has(assignment.layoutId)) {
      errors.push(`Assignment references missing layout ${assignment.layoutId}`);
    }
  }

  for (const fact of canonical.facts.facts) {
    const used = new Set<number>();
    const byAfter = new Set<number>();
    let previousMaximum = 0;
    for (const corner of fact.corners) {
      if (used.has(corner.number)) {
        errors.push(`Duplicate corner number ${corner.number} in facts ${fact.slug}`);
      }
      used.add(corner.number);
      for (const covered of corner.covers ?? []) {
        if (used.has(covered)) {
          errors.push(`Duplicate corner number ${covered} in facts ${fact.slug}`);
        }
        used.add(covered);
      }
      const numbers = [corner.number, ...(corner.covers ?? [])];
      const minimum = Math.min(...numbers);
      if (minimum <= previousMaximum) {
        errors.push(`Corner ${corner.number} is out of racing order in facts ${fact.slug}`);
      }
      previousMaximum = Math.max(...numbers);
    }
    for (const straight of fact.straights ?? []) {
      if (byAfter.has(straight.after)) {
        errors.push(`Duplicate straight after_turn ${straight.after} in facts ${fact.slug}`);
      }
      byAfter.add(straight.after);
    }
  }

  const geometryKeySet = new Set<string>();
  for (const row of canonical.geometry.geometry) {
    const key = `${row.factsSlug}\0${row.gameId}`;
    if (geometryKeySet.has(key)) {
      errors.push(`Duplicate geometry ${row.gameId}/${row.factsSlug}`);
    }
    geometryKeySet.add(key);

    if (!layoutRefsFacts.has(row.factsSlug)) {
      errors.push(`Geometry references missing facts slug ${row.factsSlug}`);
    }

    if (row.sectors) {
      if (!Number.isFinite(row.sectors.s1End) || !Number.isFinite(row.sectors.s2End) || row.sectors.s1End <= 0 || row.sectors.s1End >= row.sectors.s2End || row.sectors.s2End >= 1) {
        errors.push(`Invalid sectors for ${row.gameId}/${row.factsSlug}`);
      }
    }

    for (const segment of row.segments) {
      const key = segment.key;
      if (!Number.isFinite(segment.startFrac) || !Number.isFinite(segment.endFrac) || segment.startFrac < 0 || segment.startFrac > 1 || segment.endFrac < 0 || segment.endFrac > 1) {
        errors.push(`Segment fraction out of range for ${row.gameId}/${row.factsSlug} ${key}`);
      }
      if (!(segment.startFrac < segment.endFrac)) {
        errors.push(`Segment fraction ordering invalid for ${row.gameId}/${row.factsSlug} ${key}`);
      }
      if (key.startsWith("t")) {
        const corners = parseCornerKey(key);
        if (!corners.length || corners.some((n) => n <= 0)) {
          errors.push(`Invalid corner segment key ${key} for geometry ${row.gameId}/${row.factsSlug}`);
        }
      } else if (key.startsWith("s")) {
        const after = parseStraightKey(key);
        if (after == null || after <= 0 || !Number.isInteger(after)) {
          errors.push(`Invalid straight segment key ${key} for geometry ${row.gameId}/${row.factsSlug}`);
        }
      } else {
        errors.push(`Malformed segment key ${key} for geometry ${row.gameId}/${row.factsSlug}`);
      }
    }
  }

  for (const [key, entry] of Object.entries(canonical.verification.entries)) {
    parseIsoDate(entry.date, `verification ${key} date`);
    const meta = /^meta:(.+)$/.exec(key);
    const segments = /^segments:([^/]+)\/(.+)$/.exec(key);
    if (!meta && !segments) {
      errors.push(`Invalid verification key ${key}`);
      continue;
    }
    if (meta) {
      if (!layoutRefsFacts.has(meta[1])) {
        errors.push(`Verification references missing facts slug ${meta[1]}`);
      }
      continue;
    }
    const gameId = segments![1];
    const slug = segments![2];
    if (!KNOWN_GAME_IDS.includes(gameId as (typeof KNOWN_GAME_IDS)[number])) {
      errors.push(`Verification references unknown game ${gameId}`);
    }
    const geometryExists = canonical.geometry.geometry.some((row) => row.gameId === gameId && row.factsSlug === slug);
    if (!geometryExists) {
      errors.push(`Verification references missing geometry for ${gameId}/${slug}`);
    }
  }

  if (errors.length > 0) {
    throw new Error(errors.join("; "));
  }

  return canonical;
}

export function loadTrackRegistrySource(locations: TrackRegistryLocationsInput = {}): TrackRegistrySource {
  const resolved = resolveTrackRegistryLocations(locations);
  const parsed = parseSourceDocuments(resolved);
  return validateTrackConfigurationSource(parsed);
}

export function renderTrackRegistrySource(source: TrackRegistrySource): ReadonlyMap<string, string> {
  const canonical = validateTrackConfigurationSource(source);
  const map = new Map<string, string>();
  map.set(CONFIGURATIONS_FILE, jsonBytes(canonical.configurations));
  map.set(FACTS_FILE, jsonBytes(canonical.facts));
  map.set(GEOMETRY_FILE, jsonBytes(canonical.geometry));
  map.set(VERIFICATION_FILE, jsonBytes(canonical.verification));
  return map;
}

function clearTrackRegistryProjection(database: Database): void {
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

function insertTrackRegistryProjection(
  database: Database,
  source: TrackRegistrySource,
  sourceHash: string,
): void {
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
    insertGeometry.run(
      row.factsSlug,
      row.gameId,
      row.sectors?.s1End ?? null,
      row.sectors?.s2End ?? null,
      row.sectors?.source ?? null,
    );
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
    insertVerification.run(
      meta ? "meta" : "segments",
      meta?.[1] ?? segments![2],
      segments?.[1] ?? "",
      entry.hash,
      entry.date,
      entry.by ?? null,
      entry.note ?? null,
    );
  }
  insertMetadata.run("sourceVersion", String(TRACK_REGISTRY_SOURCE_VERSION));
  insertMetadata.run("sourceHash", sourceHash);
}
function compileTrackRegistryProjection(source: TrackRegistrySource, targetDatabasePath: string): TrackRegistryProjectionSnapshot {
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
    if (existsSync(resolved.databasePath)) copyFileSync(resolved.databasePath, databaseBackup);
    if (existsSync(resolved.reportPath)) copyFileSync(resolved.reportPath, reportBackup);
    try {
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
    if (
      metadataRows.length !== 2 ||
      metadataRows[0]?.key !== "sourceHash" ||
      metadataRows[1]?.key !== "sourceVersion"
    ) {
      throw new Error("Invalid registry metadata");
    }
    const metadata = Object.fromEntries(metadataRows.map((row) => [row.key, row.value]));
    const sourceVersion = Number(metadata.sourceVersion);
    const sourceHash = metadata.sourceHash;
    if (
      sourceVersion !== TRACK_REGISTRY_SOURCE_VERSION ||
      typeof sourceHash !== "string" ||
      !/^[0-9a-f]{64}$/.test(sourceHash)
    ) {
      throw new Error("Invalid registry metadata");
    }

    const schema = database.query(`
      SELECT type, name, tbl_name, sql
        FROM sqlite_master
       WHERE type IN ('table', 'index') AND name NOT LIKE 'sqlite_%'
       ORDER BY type, name
    `).all() as TrackRegistryProjectionSnapshot["schema"];

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

    const segments = database.query("SELECT facts_slug, game_id, sequence, segment_key, start_fraction, end_fraction FROM game_geometry_segments ORDER BY facts_slug, game_id, sequence").all() as Array<{
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
          const byGame = GAME_ORDER[a.game_id] - GAME_ORDER[b.game_id];
          return byGame || a.track_ordinal - b.track_ordinal;
        }),
      facts,
      corners,
      covers,
      straights,
      geometry: geometry.sort((a, b) => {
        const byGame = GAME_ORDER[a.game_id] - GAME_ORDER[b.game_id];
        return byGame || a.facts_slug.localeCompare(b.facts_slug);
      }),
      segments: segments.sort((a, b) => {
        const byGame = GAME_ORDER[a.game_id] - GAME_ORDER[b.game_id];
        return byGame || a.facts_slug.localeCompare(b.facts_slug) || a.sequence - b.sequence;
      }),
      verification,
    };
  } finally {
    database.close();
  }
}

export function renderTrackRegistryReport(snapshot: TrackRegistryProjectionSnapshot): string {
  const layoutById = new Map(snapshot.layouts.map((layout) => [layout.canonical_id, layout]));
  const factsBySlug = new Map(snapshot.facts.map((fact) => [fact.slug, fact]));

  const cornersByFacts = new Map<string, typeof snapshot.corners>();
  for (const corner of snapshot.corners) {
    const existing = cornersByFacts.get(corner.facts_slug) ?? [];
    existing.push(corner);
    cornersByFacts.set(corner.facts_slug, existing);
  }

  const coversByKey = new Map<string, number[]>();
  for (const cover of snapshot.covers) {
    const key = `${cover.facts_slug}\0${cover.corner_sequence}`;
    const numbers = coversByKey.get(key) ?? [];
    numbers.push(cover.turn_number);
    coversByKey.set(key, numbers);
  }

  const straightsByFacts = new Map<string, typeof snapshot.straights>();
  for (const straight of snapshot.straights) {
    const existing = straightsByFacts.get(straight.facts_slug) ?? [];
    existing.push(straight);
    straightsByFacts.set(straight.facts_slug, existing);
  }

  const factWithCoverage = Array.from(factsBySlug.values())
    .sort((a, b) => a.slug.localeCompare(b.slug))
    .map((fact) => {
      const corners = (cornersByFacts.get(fact.slug) ?? []).map((corner) => ({
        sequence: corner.sequence,
        number: corner.turn_number,
        ...(coversByKey.get(`${fact.slug}\0${corner.sequence}`) && (coversByKey.get(`${fact.slug}\0${corner.sequence}`)?.length ?? 0) > 0
          ? { covers: coversByKey.get(`${fact.slug}\0${corner.sequence}`)?.sort((a, b) => a - b) }
          : {}),
        name: corner.name,
        ...(corner.direction ? { direction: corner.direction } : {}),
        ...(corner.group_name ? { group: corner.group_name } : {}),
      }));

      const straights = (straightsByFacts.get(fact.slug) ?? []).map((straight) => ({
        after: straight.after_turn,
        name: straight.name,
        ...(straight.group_name ? { group: straight.group_name } : {}),
      }));

      return {
        slug: fact.slug,
        track: fact.track_slug,
        layout: fact.layout_slug,
        layoutName: fact.layout_name,
        name: fact.name,
        ...(fact.source ? { source: fact.source } : {}),
        corners: corners,
        ...(straights.length ? { straights } : {}),
      };
    });

  const assignmentsByGameOrder = [...snapshot.assignments].sort((a, b) => {
    const byGame = (GAME_ORDER[a.game_id] ?? Number.MAX_SAFE_INTEGER) - (GAME_ORDER[b.game_id] ?? Number.MAX_SAFE_INTEGER);
    return byGame !== 0 ? byGame : a.track_ordinal - b.track_ordinal;
  });

  const trackIdentities = assignmentsByGameOrder.map((assignment) => {
    const layout = layoutById.get(assignment.layout_id);
    return {
      gameId: assignment.game_id,
      trackOrdinal: assignment.track_ordinal,
      layoutId: assignment.layout_id,
      factsSlug: layout?.facts_slug ?? null,
    };
  });

  const geometrySectors = [...snapshot.geometry]
    .sort((a, b) => {
      const byGame = (GAME_ORDER[a.game_id] ?? Number.MAX_SAFE_INTEGER) - (GAME_ORDER[b.game_id] ?? Number.MAX_SAFE_INTEGER);
      return byGame !== 0 ? byGame : a.facts_slug.localeCompare(b.facts_slug);
    })
    .map((row) => ({
      gameId: row.game_id,
      factsSlug: row.facts_slug,
      s1End: row.sector_1_end,
      s2End: row.sector_2_end,
      source: row.sector_source,
    }));

  const assignmentsByLayout = new Map<string, Array<{ gameId: GameId; trackOrdinal: number }>>();
  for (const identity of trackIdentities) {
    const existing = assignmentsByLayout.get(identity.layoutId) ?? [];
    existing.push({ gameId: identity.gameId, trackOrdinal: identity.trackOrdinal });
    assignmentsByLayout.set(identity.layoutId, existing);
  }

  const aliases = Array.from(assignmentsByLayout.entries())
    .filter(([, assignments]) => assignments.length > 1)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([layoutId, assignments]) => {
      const layout = layoutById.get(layoutId);
      const ordered = assignments
        .map((assignment) => ({
          gameId: assignment.gameId,
          trackOrdinal: assignment.trackOrdinal,
        }))
        .sort((a, b) => (GAME_ORDER[a.gameId] ?? Number.MAX_SAFE_INTEGER) - (GAME_ORDER[b.gameId] ?? Number.MAX_SAFE_INTEGER));
      return {
        layoutId,
        factsSlug: layout?.facts_slug ?? null,
        assignments: ordered,
      };
    });

  const layoutFactsRefs = new Set(layoutsHasFacts(snapshot.layouts));
  const layoutWithoutFacts = [...layoutFactsRefs]
    .filter((value) => value[1] === null)
    .map(([id]) => id)
    .sort();

  const factsWithoutLayouts = [...factsBySlug.keys()]
    .filter((slug) => !snapshot.layouts.some((layout) => layout.facts_slug === slug))
    .sort();

  const assignmentOrphans: Array<{ gameId: string; trackOrdinal: number; layoutId: string }> = [];
  for (const assignment of assignmentsByGameOrder) {
    if (!layoutById.has(assignment.layout_id)) {
      assignmentOrphans.push({
        gameId: assignment.game_id,
        trackOrdinal: assignment.track_ordinal,
        layoutId: assignment.layout_id,
      });
    }
  }

  const geometrySet = new Set(snapshot.geometry.map((row) => `${row.facts_slug}\0${row.game_id}`));
  const geometryOrphans: Array<{ gameId: string; factsSlug: string }> = [];
  for (const row of snapshot.geometry) {
    if (!factsBySlug.has(row.facts_slug)) {
      geometryOrphans.push({ gameId: row.game_id, factsSlug: row.facts_slug });
    }
  }

  const verificationOrphans: Array<{ kind: string; gameId: string; factsSlug: string }> = [];
  for (const row of snapshot.verification) {
    if (row.kind === "meta") {
      if (!factsBySlug.has(row.facts_slug)) {
        verificationOrphans.push({ kind: "meta", gameId: row.game_id, factsSlug: row.facts_slug });
      }
      continue;
    }
    const hasTarget = geometrySet.has(`${row.facts_slug}\0${row.game_id}`);
    if (!hasTarget) {
      verificationOrphans.push({ kind: "segments", gameId: row.game_id, factsSlug: row.facts_slug });
    }
  }

  const report = {
    sourceVersion: snapshot.sourceVersion,
    sourceHash: snapshot.sourceHash,
    recordCounts: {
      venues: snapshot.venueNodes.length,
      layouts: snapshot.layouts.length,
      assignments: snapshot.assignments.length,
      facts: snapshot.facts.length,
      corners: snapshot.corners.length,
      covers: snapshot.covers.length,
      straights: snapshot.straights.length,
      geometry: snapshot.geometry.length,
      geometrySegments: snapshot.segments.length,
      verification: snapshot.verification.length,
    },
    trackIdentities,
    geometrySectors,
    facts: factWithCoverage,
    aliases,
    orphanedReferences: {
      assignments: assignmentOrphans,
      geometry: geometryOrphans,
      verification: verificationOrphans,
    },
    unlinked: {
      layoutsWithoutFacts: layoutWithoutFacts,
      factsWithoutLayouts,
    },
  };

  return `${JSON.stringify(report, null, 2)}\n`;
}

function layoutsHasFacts(layouts: TrackRegistryProjectionSnapshot["layouts"]): Map<string, string | null> {
  return new Map(layouts.map((layout) => [layout.canonical_id, layout.facts_slug]));
}

function stageTrackRegistrySourceUpdate(
  currentSource: TrackRegistrySource,
  nextSource: TrackRegistrySource,
  resolved: TrackRegistryLocations,
  oldSourceHash: string,
  newSourceHash: string,
): TrackRegistryUpdateJournal {
  const sessionId = randomBytes(8).toString("hex");
  const renderedCurrent = renderTrackRegistrySource(currentSource);
  const renderedNext = renderTrackRegistrySource(nextSource);
  const sourceBackups: Record<string, string> = {};
  const sourceStaged: Record<string, string> = {};
  const databaseBackup = `${resolved.databasePath}.backup.${sessionId}`;
  const databaseStaged = `${resolved.databasePath}.stage.${sessionId}`;
  const reportBackup = `${resolved.reportPath}.backup.${sessionId}`;
  const reportStaged = `${resolved.reportPath}.stage.${sessionId}`;

  try {
    for (const filename of TRACK_SOURCE_FILES) {
      const sourcePath = resolve(resolved.sourceDirectory, filename);
      const backupPath = `${sourcePath}.backup.${sessionId}`;
      const stagedPath = `${sourcePath}.stage.${sessionId}`;
      writeFile(backupPath, renderedCurrent.get(filename)!);
      writeFile(stagedPath, renderedNext.get(filename)!);
      sourceBackups[filename] = backupPath;
      sourceStaged[filename] = stagedPath;
    }
    if (existsSync(resolved.databasePath)) copyFileSync(resolved.databasePath, databaseBackup);
    if (existsSync(resolved.reportPath)) copyFileSync(resolved.reportPath, reportBackup);
    const projection = compileTrackRegistryProjection(nextSource, databaseStaged);
    Bun.gc(true);
    writeFile(reportStaged, renderTrackRegistryReport(projection));
    return {
      version: 1,
      oldSourceHash,
      newSourceHash,
      sourceBackups,
      sourceStaged,
      databaseBackup,
      databaseStaged,
      reportBackup,
      reportStaged,
    };
  } catch (error) {
    for (const path of [...Object.values(sourceBackups), ...Object.values(sourceStaged)]) removeIfExists(path);
    removeIfExists(databaseBackup);
    removeIfExists(databaseStaged);
    removeIfExists(reportBackup);
    removeIfExists(reportStaged);
    throw error;
  }
}

function writeAtomicFile(path: string, content: string): void {
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  writeFile(temporary, content);
  try {
    renameSync(temporary, path);
  } finally {
    removeIfExists(temporary);
  }
}

function cleanTrackRegistryUpdateFiles(
  journal: TrackRegistryUpdateJournal,
  transactionPath: string,
): void {
  for (const filename of TRACK_SOURCE_FILES) {
    removeIfExists(journal.sourceStaged[filename]);
    removeIfExists(journal.sourceBackups[filename]);
  }
  removeIfExists(journal.databaseStaged);
  removeIfExists(journal.databaseBackup);
  removeIfExists(journal.reportStaged);
  removeIfExists(journal.reportBackup);
  removeIfExists(transactionPath);
}

function actualSourceHash(sourceDirectory: string): string | null {
  const files = new Map<string, string>();
  for (const filename of TRACK_SOURCE_FILES) {
    const path = resolve(sourceDirectory, filename);
    if (!existsSync(path)) return null;
    files.set(filename, readFile(path));
  }
  return sha256OverSourceFiles(files);
}


function rebuildRegistryArtifacts(source: TrackRegistrySource, locations: TrackRegistryLocations): void {
  const canonical = validateTrackConfigurationSource(source);
  const sourceHash = sha256OverSourceFiles(renderTrackRegistrySource(canonical));
  if (resolve(locations.databasePath) === resolve(resolveTrackRegistryLocations().databasePath)) {
    writeGeneratedTrackRegistry((database) => {
      clearTrackRegistryProjection(database);
      insertTrackRegistryProjection(database, canonical, sourceHash);
    });
    const projection = readTrackRegistryProjection(locations.databasePath);
    writeAtomicFile(locations.reportPath, renderTrackRegistryReport(projection));
    return;
  }

  const nonce = randomBytes(8).toString("hex");
  const databaseStaged = `${locations.databasePath}.recovery.${nonce}.tmp`;
  const reportStaged = `${locations.reportPath}.recovery.${nonce}.tmp`;
  try {
    const projection = compileTrackRegistryProjection(canonical, databaseStaged);
    writeFile(reportStaged, renderTrackRegistryReport(projection));
    Bun.gc(true);
    renameSync(databaseStaged, locations.databasePath);
    renameSync(reportStaged, locations.reportPath);
  } finally {
    removeIfExists(databaseStaged);
    removeIfExists(reportStaged);
  }
}

function restoreOldRegistryUpdate(
  journal: TrackRegistryUpdateJournal,
  resolved: TrackRegistryLocations,
): void {
  for (const filename of TRACK_SOURCE_FILES) {
    const backup = journal.sourceBackups[filename];
    if (!backup || !existsSync(backup)) {
      throw new Error(`Missing track registry source backup ${backup ?? filename}`);
    }
    copyFileSync(backup, resolve(resolved.sourceDirectory, filename));
  }
  const restored = loadTrackRegistrySource(resolved);
  const restoredHash = sha256OverSourceFiles(renderTrackRegistrySource(restored));
  if (restoredHash !== journal.oldSourceHash) {
    throw new Error("Track registry recovery old-source hash mismatch");
  }
  rebuildRegistryArtifacts(restored, resolved);
  cleanTrackRegistryUpdateFiles(journal, resolved.transactionPath);
}

export function recoverTrackRegistrySourceUpdate(locations: TrackRegistryLocationsInput = {}): void {
  const resolved = resolveTrackRegistryLocations(locations);
  if (!existsSync(resolved.transactionPath)) return;
  let journal: TrackRegistryUpdateJournal;
  try {
    journal = JSON.parse(readFile(resolved.transactionPath)) as TrackRegistryUpdateJournal;
  } catch {
    throw new Error(`Malformed track registry transaction file ${resolved.transactionPath}`);
  }
  if (journal.version !== 1) {
    throw new Error(`Unsupported track registry update transaction schema version ${journal.version}`);
  }

  if (actualSourceHash(resolved.sourceDirectory) === journal.newSourceHash) {
    const source = loadTrackRegistrySource(resolved);
    const canonicalHash = sha256OverSourceFiles(renderTrackRegistrySource(source));
    if (canonicalHash !== journal.newSourceHash) {
      throw new Error("Track registry recovery new-source hash mismatch");
    }
    rebuildRegistryArtifacts(source, resolved);
    cleanTrackRegistryUpdateFiles(journal, resolved.transactionPath);
    return;
  }
  restoreOldRegistryUpdate(journal, resolved);
}

export function updateTrackRegistrySource(
  mutator: (draft: TrackRegistrySource) => TrackRegistrySource | void,
  locations: TrackRegistryLocationsInput = {},
): void {
  const resolved = resolveTrackRegistryLocations(locations);
  recoverTrackRegistrySourceUpdate(resolved);
  const current = loadTrackRegistrySource(resolved);
  const currentRendered = renderTrackRegistrySource(current);
  const currentHash = sha256OverSourceFiles(currentRendered);
  const draft = structuredClone(current) as TrackRegistrySource;
  const mutated = mutator(draft) ?? draft;
  const next = validateTrackConfigurationSource(mutated);
  const nextRendered = renderTrackRegistrySource(next);
  const nextHash = sha256OverSourceFiles(nextRendered);
  const needsCanonicalRewrite = TRACK_SOURCE_FILES.some((filename) =>
    readFile(resolve(resolved.sourceDirectory, filename)) !== currentRendered.get(filename),
  );
  if (currentHash === nextHash && !needsCanonicalRewrite) return;

  const journal = stageTrackRegistrySourceUpdate(current, next, resolved, currentHash, nextHash);
  writeAtomicFile(resolved.transactionPath, `${JSON.stringify(journal, null, 2)}\n`);
  try {
    for (const filename of TRACK_SOURCE_FILES) {
      renameSync(journal.sourceStaged[filename], resolve(resolved.sourceDirectory, filename));
    }
    if (resolve(resolved.databasePath) === resolve(resolveTrackRegistryLocations().databasePath)) {
      writeGeneratedTrackRegistry((database) => {
        clearTrackRegistryProjection(database);
        insertTrackRegistryProjection(database, next, nextHash);
      });
      removeIfExists(journal.databaseStaged);
    } else {
      renameSync(journal.databaseStaged, resolved.databasePath);
    }
    renameSync(journal.reportStaged, resolved.reportPath);
    const projection = readTrackRegistryProjection(resolved.databasePath);
    if (projection.sourceHash !== nextHash) {
      throw new Error("Stale track registry projection after update");
    }
    if (readFile(resolved.reportPath) !== renderTrackRegistryReport(projection)) {
      throw new Error("Stale track registry report after update");
    }
  } catch (error) {
    restoreOldRegistryUpdate(journal, resolved);
    throw error;
  }
  cleanTrackRegistryUpdateFiles(journal, resolved.transactionPath);
}

export function assertTrackRegistryArtifactsCurrent(locations: TrackRegistryLocationsInput = {}): void {
  const resolved = resolveTrackRegistryLocations(locations);
  if (existsSync(resolved.transactionPath)) {
    throw new Error(`Pending track registry source update ${resolved.transactionPath}; run bun run tracks:registry`);
  }
  const source = loadTrackRegistrySource(resolved);
  const rendered = renderTrackRegistrySource(source);
  for (const filename of TRACK_SOURCE_FILES) {
    const path = resolve(resolved.sourceDirectory, filename);
    if (readFile(path) !== rendered.get(filename)) {
      throw new Error(`Non-canonical track registry source ${path}; run bun run tracks:registry`);
    }
  }

  const disposableDatabase = `${resolved.databasePath}.check.${randomBytes(8).toString("hex")}.tmp`;
  try {
    const expectedProjection = compileTrackRegistryProjection(source, disposableDatabase);
    const actualProjection = readTrackRegistryProjection(resolved.databasePath);
    Bun.gc(true);
    if (JSON.stringify(actualProjection) !== JSON.stringify(expectedProjection)) {
      throw new Error("Stale generated track registry; run bun run tracks:registry");
    }
    if (readFile(resolved.reportPath) !== renderTrackRegistryReport(expectedProjection)) {
      throw new Error("Stale track registry report; run bun run tracks:registry");
    }
  } finally {
    removeIfExists(disposableDatabase);
  }
}
