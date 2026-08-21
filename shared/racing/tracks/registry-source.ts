import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
  type Dirent,
} from "node:fs";
import { dirname, relative, resolve } from "node:path";

import { z } from "zod";

import { SHARED_DIR } from "@shared/platform/runtime/data-paths";
import { KNOWN_GAME_IDS, type GameId, GameIdSchema } from "../../games/ids";
import {
  canonicalTrackAssetPathComponents,
  CURRENT_TRACK_REVISION,
  parseCanonicalTrackId,
  parseVenueRevisionPath,
  revisionDirectoryPathComponents,
  type TrackConfigurationConfirmation,
  TrackConfigurationConfirmationSchema,
  TrackVenueIdSchema,
} from "./configuration";
import {
  TrackFactsSchema,
  type CornerFact,
  type StraightFact,
  type TrackFacts,
} from "./facts";
import {
  TrackGeometrySchema,
  type TrackGeometry,
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

const TrackFileAssignmentSchema = z.object({
  gameId: GameIdSchema,
  trackOrdinal: z.number().int().nonnegative(),
  confirmation: TrackConfigurationConfirmationSchema.strict().nullable(),
}).strict();

const VerifiedEntrySchema = z.object({
  hash: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  by: z.string().trim().min(1).optional(),
  note: z.string().trim().min(1).optional(),
}).strict();

const VenueMetadataFileSchema = z.object({
  version: z.literal(TRACK_REGISTRY_SOURCE_VERSION),
  id: TrackVenueIdSchema,
  name: z.string().trim().min(1),
}).strict();

const TrackMetadataFileSchema = z.object({
  version: z.literal(TRACK_REGISTRY_SOURCE_VERSION),
  id: TrackVenueIdSchema,
  name: z.string().trim().min(1),
  assignments: z.array(TrackFileAssignmentSchema),
  facts: TrackFactsSchema.strict().optional(),
  geometryByGame: z.partialRecord(GameIdSchema, TrackGeometrySchema.strict()).optional(),
  verification: z.object({
    meta: VerifiedEntrySchema.optional(),
    segments: z.partialRecord(GameIdSchema, VerifiedEntrySchema).optional(),
  }).strict().optional(),
}).strict();

const RevisionMetadataFileSchema = z.object({
  version: z.literal(TRACK_REGISTRY_SOURCE_VERSION),
  id: TrackVenueIdSchema,
  name: z.string().trim().min(1),
}).strict();

export type TrackConfigurationSource = z.infer<typeof TrackConfigurationsSchema>;
export interface TrackFactsSource {
  version: typeof TRACK_REGISTRY_SOURCE_VERSION;
  facts: TrackFacts[];
}
export interface TrackGeometrySource {
  version: typeof TRACK_REGISTRY_SOURCE_VERSION;
  geometry: Array<{ factsSlug: string; gameId: GameId } & TrackGeometry>;
}
export interface TrackVerificationSource {
  version: typeof TRACK_REGISTRY_SOURCE_VERSION;
  entries: Record<string, VerifiedEntry>;
}

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

const VENUES_DIRECTORY = "venues";
const VENUE_FILE = "venue.json";
const REVISIONS_DIRECTORY = "revisions";
const REVISION_FILE = "revision.json";
const TRACKS_DIRECTORY = "tracks";
const TRACK_METADATA_FILE = "metadata.json";
const SEGMENTS_SUFFIX = "-segments.json";
const VENUE_METADATA_PATH = /^venues\/([a-z0-9][a-z0-9-]*)\/venue\.json$/;
const REVISION_METADATA_PATH = /^venues\/([a-z0-9][a-z0-9-]*)\/revisions\/((?:[a-z0-9][a-z0-9-]*\/)*[a-z0-9][a-z0-9-]*)\/revision\.json$/;
const TRACK_METADATA_PATH = /^venues\/([a-z0-9][a-z0-9-]*)\/revisions\/((?:[a-z0-9][a-z0-9-]*\/)*[a-z0-9][a-z0-9-]*)\/tracks\/([a-z0-9][a-z0-9-]*)\/metadata\.json$/;
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
  for (const [filename, body] of [...files.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    hash.update(filename).update("\0").update(body);
  }
  return hash.digest("hex");
}


function deriveVenueParent(path: string): string | null {
  const { rootVenuePath, revisionPath } = parseVenueRevisionPath(path);
  if (revisionPath === CURRENT_TRACK_REVISION) return null;
  const components = revisionDirectoryPathComponents(path).slice(3, -1);
  return components.length === 0 ? rootVenuePath : `${rootVenuePath}/${components.join("/")}`;
}

function deriveVenueSlug(path: string): string {
  const { rootVenuePath, revisionPath } = parseVenueRevisionPath(path);
  if (revisionPath === CURRENT_TRACK_REVISION) return rootVenuePath;
  return revisionDirectoryPathComponents(path).at(-1)!;
}

function deriveLayoutVenuePath(id: string): string {
  return parseCanonicalTrackId(id).venuePath;
}

function deriveLayoutSlug(id: string): string {
  return parseCanonicalTrackId(id).layoutSlug;
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
function pruneEmptySourceDirectories(path: string, root: string): void {
  let directory = dirname(path);
  while (directory !== root && !relative(root, directory).startsWith("..")) {
    if (!existsSync(directory) || readdirSync(directory).length > 0) return;
    rmdirSync(directory);
    directory = dirname(directory);
  }
}


function shardRoot(locations: TrackRegistryLocations): string {
  return dirname(locations.sourceDirectory);
}

function sourceFilePath(locations: TrackRegistryLocations, filename: string): string {
  const root = shardRoot(locations);
  const path = resolve(root, filename);
  if (relative(root, path).startsWith("..")) {
    throw new Error(`Invalid track registry shard path ${filename}`);
  }
  return path;
}

function isUpdateSidecar(name: string): boolean {
  return /\.(?:backup|stage)\.[a-z0-9]+$/i.test(name);
}

function readDirectory(path: string): Dirent[] {
  if (!existsSync(path)) throw new Error(`Missing track registry directory ${path}`);
  return readdirSync(path, { withFileTypes: true });
}

function sourcePaths(locations: TrackRegistryLocations): string[] {
  const root = shardRoot(locations);
  const venuesRoot = resolve(root, VENUES_DIRECTORY);
  const paths: string[] = [];

  function collectTrackPaths(directory: string, venuePath: string): void {
    const tracksDirectory = resolve(directory, TRACKS_DIRECTORY);
    if (!existsSync(tracksDirectory)) return;
    for (const entry of readDirectory(tracksDirectory)) {
      if (isUpdateSidecar(entry.name)) continue;
      if (!entry.isDirectory()) {
        throw new Error(`Unexpected track metadata shard ${resolve(tracksDirectory, entry.name)}`);
      }
      const metadataPath = resolve(tracksDirectory, entry.name, TRACK_METADATA_FILE);
      if (!existsSync(metadataPath)) {
        const remaining = readDirectory(resolve(tracksDirectory, entry.name)).filter((candidate) => !isUpdateSidecar(candidate.name));
        if (remaining.length === 0) continue;
        throw new Error(`Missing track metadata shard ${metadataPath}`);
      }
      paths.push(`${canonicalTrackAssetPathComponents(venuePath, entry.name).join("/")}/${TRACK_METADATA_FILE}`);
    }
  }

  function collectRevisionPaths(directory: string, rootVenuePath: string, revisionPath: string): void {
    const venuePath = `${rootVenuePath}/${revisionPath}`;
    const revisionDocument = resolve(directory, REVISION_FILE);
    if (existsSync(revisionDocument)) {
      paths.push(`${revisionDirectoryPathComponents(venuePath).join("/")}/${REVISION_FILE}`);
    } else if (existsSync(resolve(directory, TRACKS_DIRECTORY))) {
      throw new Error(`Missing revision metadata shard ${revisionDocument}`);
    }
    collectTrackPaths(directory, venuePath);

    for (const entry of readDirectory(directory)) {
      if (!entry.isDirectory() || entry.name === TRACKS_DIRECTORY) continue;
      const child = resolve(directory, entry.name);
      if (existsSync(resolve(child, VENUE_FILE))) {
        throw new Error(`Unexpected nested venue metadata shard ${resolve(child, VENUE_FILE)}`);
      }
      if (entry.name === "imagery") continue;
      collectRevisionPaths(child, rootVenuePath, `${revisionPath}/${entry.name}`);
    }
  }

  for (const entry of readDirectory(venuesRoot)) {
    if (!entry.isDirectory()) continue;
    const directory = resolve(venuesRoot, entry.name);
    const venueDocument = resolve(directory, VENUE_FILE);
    if (!existsSync(venueDocument)) {
      throw new Error(`Missing venue metadata shard ${venueDocument}`);
    }
    paths.push(`${VENUES_DIRECTORY}/${entry.name}/${VENUE_FILE}`);
    const directTracks = resolve(directory, TRACKS_DIRECTORY);
    if (existsSync(directTracks)) {
      throw new Error(`Unexpected direct track metadata directory ${directTracks}`);
    }
    for (const child of readDirectory(directory)) {
      if (child.isDirectory() && child.name !== REVISIONS_DIRECTORY && existsSync(resolve(directory, child.name, VENUE_FILE))) {
        throw new Error(`Unexpected nested venue metadata shard ${resolve(directory, child.name, VENUE_FILE)}`);
      }
    }
    const revisionsDirectory = resolve(directory, REVISIONS_DIRECTORY);
    if (!existsSync(revisionsDirectory)) continue;
    for (const revision of readDirectory(revisionsDirectory)) {
      if (revision.isDirectory()) collectRevisionPaths(resolve(revisionsDirectory, revision.name), entry.name, revision.name);
    }
  }
  if (existsSync(resolve(root, "meta"))) {
    throw new Error(`Unexpected legacy track metadata directory ${resolve(root, "meta")}`);
  }
  if (existsSync(locations.sourceDirectory)) {
    for (const entry of readDirectory(locations.sourceDirectory)) {
      if (isUpdateSidecar(entry.name)) continue;
      if (entry.isFile() && entry.name.endsWith(".json")) {
        throw new Error(`Unexpected aggregate track registry source ${resolve(locations.sourceDirectory, entry.name)}`);
      }
    }
  }
  for (const gameId of KNOWN_GAME_IDS) {
    const gameDirectory = resolve(root, gameId);
    if (!existsSync(gameDirectory)) continue;
    for (const entry of readDirectory(gameDirectory)) {
      if (entry.isFile() && entry.name.endsWith(SEGMENTS_SUFFIX)) {
        throw new Error(`Unexpected legacy track segments shard ${resolve(gameDirectory, entry.name)}`);
      }
    }
  }
  return paths.sort((a, b) => a.localeCompare(b));
}

export function readTrackRegistrySourceFiles(
  locations: TrackRegistryLocationsInput = {},
): ReadonlyMap<string, string> {
  const resolved = resolveTrackRegistryLocations(locations);
  return new Map(sourcePaths(resolved).map((filename) => [filename, readFile(sourceFilePath(resolved, filename))]));
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
function findColocatedAsset(
  directory: string,
  root: string,
  registryPaths: ReadonlySet<string>,
): string | null {
  if (!existsSync(directory)) return null;
  for (const entry of readDirectory(directory)) {
    if (isUpdateSidecar(entry.name)) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = findColocatedAsset(path, root, registryPaths);
      if (nested) return nested;
      continue;
    }
    const relativePath = relative(root, path).replaceAll("\\", "/");
    if (!registryPaths.has(relativePath)) return path;
  }
  return null;
}

function assertRemovedMetadataHasNoAssets(
  current: ReadonlyMap<string, string>,
  next: ReadonlyMap<string, string>,
  locations: TrackRegistryLocations,
): void {
  const root = shardRoot(locations);
  const currentPaths = new Set(current.keys());
  for (const filename of currentPaths) {
    if (next.has(filename)) continue;
    const asset = findColocatedAsset(dirname(sourceFilePath(locations, filename)), root, currentPaths);
    if (asset) {
      throw new Error(`Cannot remove track metadata ${filename} while colocated asset remains: ${asset}`);
    }
  }
}


function parseJsonDocument(contents: string, filename: string): unknown {
  try {
    return JSON.parse(contents);
  } catch {
    throw new Error(`Invalid JSON in ${filename}`);
  }
}

function parseSourceDocuments(locations: TrackRegistryLocations): TrackRegistrySource {
  const files = readTrackRegistrySourceFiles(locations);
  const venues: TrackConfigurationSource["venues"] = [];
  const layouts: TrackConfigurationSource["layouts"] = [];
  const assignments: TrackConfigurationSource["assignments"] = [];
  const facts: TrackFacts[] = [];
  const geometry: TrackGeometrySource["geometry"] = [];
  const entries: VerifiedLedger = {};
  const revisions = new Map<string, { rootVenuePath: string; revisionPath: string; name: string }>();

  for (const [filename, contents] of files) {
    const venueMatch = VENUE_METADATA_PATH.exec(filename);
    if (venueMatch) {
      const venue = VenueMetadataFileSchema.parse(parseJsonDocument(contents, filename));
      if (venue.id !== venueMatch[1]) {
        throw new Error(`Venue metadata shard ${filename} must match venue id ${venue.id}`);
      }
      venues.push({ id: venue.id, name: venue.name });
      continue;
    }

    const revisionMatch = REVISION_METADATA_PATH.exec(filename);
    if (revisionMatch) {
      const revision = RevisionMetadataFileSchema.parse(parseJsonDocument(contents, filename));
      const venuePath = `${revisionMatch[1]}/${revisionMatch[2]}`;
      const { rootVenuePath, revisionPath } = parseVenueRevisionPath(venuePath);
      if (revision.id !== revisionPath) {
        throw new Error(`Revision metadata shard ${filename} must match revision id ${revision.id}`);
      }
      if (revisionPath !== CURRENT_TRACK_REVISION) {
        revisions.set(venuePath, { rootVenuePath, revisionPath, name: revision.name });
      }
      continue;
    }

    const trackMatch = TRACK_METADATA_PATH.exec(filename);
    if (!trackMatch) throw new Error(`Unexpected track metadata shard ${filename}`);
    const venuePath = `${trackMatch[1]}/${trackMatch[2]}`;
    const { rootVenuePath, revisionPath } = parseVenueRevisionPath(venuePath);
    const layoutId = `${rootVenuePath}/${revisionPath === CURRENT_TRACK_REVISION ? "" : `${revisionPath}/`}${trackMatch[3]}`;
    const track = TrackMetadataFileSchema.parse(parseJsonDocument(contents, filename));
    if (track.id !== layoutId) {
      throw new Error(`Track metadata shard ${filename} must match layout id ${track.id}`);
    }
    if ((track.geometryByGame || track.verification) && !track.facts) {
      throw new Error(`Track metadata shard ${filename} needs facts for geometry or verification`);
    }
    layouts.push({
      id: track.id,
      name: track.name,
      ...(track.facts ? { factsSlug: track.facts.slug } : {}),
    });
    for (const assignment of track.assignments) {
      assignments.push({
        ...assignment,
        layoutId: track.id,
      });
    }
    if (!track.facts) continue;

    facts.push(track.facts);
    for (const [gameId, value] of Object.entries(track.geometryByGame ?? {}) as Array<[GameId, TrackGeometry]>) {
      geometry.push({
        factsSlug: track.facts.slug,
        gameId,
        ...(value.sectors ? { sectors: value.sectors } : {}),
        segments: value.segments,
      });
    }
    if (track.verification?.meta) {
      entries[`meta:${track.facts.slug}`] = track.verification.meta;
    }
    for (const [gameId, entry] of Object.entries(track.verification?.segments ?? {}) as Array<[GameId, VerifiedEntry]>) {
      entries[`segments:${gameId}/${track.facts.slug}`] = entry;
    }
  }

  for (const { rootVenuePath, revisionPath, name } of revisions.values()) {
    const components = revisionDirectoryPathComponents(`${rootVenuePath}/${revisionPath}`).slice(3);
    for (let index = 0; index < components.length; index += 1) {
      const path = `${rootVenuePath}/${components.slice(0, index + 1).join("/")}`;
      const explicitName = revisions.get(path)?.name;
      if (!venues.some((venue) => venue.id === path)) {
        venues.push({ id: path, name: explicitName ?? (index === components.length - 1 ? name : components[index]!) });
      }
    }
  }

  return {

    configurations: {
      version: TRACK_REGISTRY_SOURCE_VERSION,
      venues,
      layouts,
      assignments,
    },
    facts: {
      version: TRACK_REGISTRY_SOURCE_VERSION,
      facts,
    },
    geometry: {
      version: TRACK_REGISTRY_SOURCE_VERSION,
      geometry,
    },
    verification: {
      version: TRACK_REGISTRY_SOURCE_VERSION,
      entries,
    },
  };
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
    const { rootVenuePath, revisionPath } = parseVenueRevisionPath(venue.id);
    if (revisionPath === CURRENT_TRACK_REVISION && venue.id !== rootVenuePath) {
      errors.push(`Current revision must not add venue node ${venue.id}`);
    }
    const parent = deriveVenueParent(venue.id);
    if (parent && !venueIds.has(parent) && !canonical.configurations.venues.some((candidate) => candidate.id === parent)) {
      errors.push(`Missing parent venue for ${venue.id}: ${parent}`);
    }
  }

  const layoutIds = new Set<string>();
  const assignmentKeys = new Set<string>();
  const layoutVenueMissing: string[] = [];
  const layoutRefsFacts = new Set<string>();
  const factsLayoutIds = new Map<string, string>();
  for (const fact of canonical.facts.facts) {
    if (layoutRefsFacts.has(fact.slug)) errors.push(`Duplicate facts ${fact.slug}`);
    layoutRefsFacts.add(fact.slug);
  }

  for (const layout of canonical.configurations.layouts) {
    if (layoutIds.has(layout.id)) errors.push(`Duplicate layout ${layout.id}`);
    layoutIds.add(layout.id);
    const parent = deriveLayoutVenuePath(layout.id);
    const { venuePath } = parseCanonicalTrackId(layout.id);
    const { rootVenuePath, revisionPath } = parseVenueRevisionPath(venuePath);
    if (revisionPath === CURRENT_TRACK_REVISION && venuePath !== rootVenuePath) {
      errors.push(`Current revision must not appear in canonical layout id ${layout.id}`);
    }
    if (!canonical.configurations.venues.some((venue) => venue.id === parent)) {
      layoutVenueMissing.push(layout.id);
    }
    if (layout.factsSlug && !layoutRefsFacts.has(layout.factsSlug)) {
      errors.push(`Layout ${layout.id} references unknown factsSlug ${layout.factsSlug}`);
    }
    if (layout.factsSlug) {
      const previousLayout = factsLayoutIds.get(layout.factsSlug);
      if (previousLayout) {
        errors.push(`Facts ${layout.factsSlug} belongs to multiple layouts: ${previousLayout}, ${layout.id}`);
      }
      factsLayoutIds.set(layout.factsSlug, layout.id);
    }
  }

  if (layoutVenueMissing.length > 0) {
    errors.push(...layoutVenueMissing.map((layout) => `Missing layout venue for ${layout}`));
  }
  for (const fact of canonical.facts.facts) {
    if (!factsLayoutIds.has(fact.slug)) errors.push(`Facts ${fact.slug} has no layout metadata shard`);
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
  const factsBySlug = new Map(canonical.facts.facts.map((fact) => [fact.slug, fact]));
  const geometryByFactsSlug = new Map<string, TrackGeometrySource["geometry"]>();
  for (const geometry of canonical.geometry.geometry) {
    const rows = geometryByFactsSlug.get(geometry.factsSlug) ?? [];
    rows.push(geometry);
    geometryByFactsSlug.set(geometry.factsSlug, rows);
  }

  for (const venue of canonical.configurations.venues) {
    const { rootVenuePath, revisionPath } = parseVenueRevisionPath(venue.id);
    if (revisionPath === CURRENT_TRACK_REVISION) {
      map.set(`${VENUES_DIRECTORY}/${rootVenuePath}/${VENUE_FILE}`, jsonBytes({
        version: TRACK_REGISTRY_SOURCE_VERSION,
        id: venue.id,
        name: venue.name,
      }));
      map.set(`${revisionDirectoryPathComponents(venue.id).join("/")}/${REVISION_FILE}`, jsonBytes({
        version: TRACK_REGISTRY_SOURCE_VERSION,
        id: CURRENT_TRACK_REVISION,
        name: "Current",
      }));
      continue;
    }
    map.set(`${revisionDirectoryPathComponents(venue.id).join("/")}/${REVISION_FILE}`, jsonBytes({
      version: TRACK_REGISTRY_SOURCE_VERSION,
      id: revisionPath,
      name: venue.name,
    }));
  }
  for (const layout of canonical.configurations.layouts) {
    const fact = layout.factsSlug ? factsBySlug.get(layout.factsSlug) : undefined;
    if (layout.factsSlug && !fact) throw new Error(`Layout ${layout.id} references unknown factsSlug ${layout.factsSlug}`);
    const geometryByGame: Partial<Record<GameId, TrackGeometry>> = {};
    for (const geometry of fact ? geometryByFactsSlug.get(fact.slug) ?? [] : []) {
      geometryByGame[geometry.gameId] = {
        ...(geometry.sectors ? { sectors: geometry.sectors } : {}),
        segments: geometry.segments,
      };
    }
    const segmentVerification = fact ? Object.fromEntries(
      Object.keys(geometryByGame)
        .filter((gameId) => canonical.verification.entries[`segments:${gameId}/${fact.slug}`])
        .map((gameId) => [gameId, canonical.verification.entries[`segments:${gameId}/${fact.slug}`]!]),
    ) : {};
    const verification = fact ? {
      ...(canonical.verification.entries[`meta:${fact.slug}`] ? { meta: canonical.verification.entries[`meta:${fact.slug}`] } : {}),
      ...(Object.keys(segmentVerification).length ? { segments: segmentVerification } : {}),
    } : undefined;
    const { venuePath, layoutSlug } = parseCanonicalTrackId(layout.id);
    map.set(`${canonicalTrackAssetPathComponents(venuePath, layoutSlug).join("/")}/${TRACK_METADATA_FILE}`, jsonBytes({
      version: TRACK_REGISTRY_SOURCE_VERSION,
      id: layout.id,
      name: layout.name,
      assignments: canonical.configurations.assignments
        .filter((assignment) => assignment.layoutId === layout.id)
        .map(({ gameId, trackOrdinal, confirmation }) => ({ gameId, trackOrdinal, confirmation })),
      ...(fact ? { facts: fact } : {}),
      ...(Object.keys(geometryByGame).length ? { geometryByGame } : {}),
      ...(verification && Object.keys(verification).length ? { verification } : {}),
    }));
  }
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
    const filenames = new Set([...renderedCurrent.keys(), ...renderedNext.keys()]);
    for (const filename of filenames) {
      const sourcePath = sourceFilePath(resolved, filename);
      if (renderedCurrent.has(filename)) {
        const backupPath = `${sourcePath}.backup.${sessionId}`;
        writeFile(backupPath, renderedCurrent.get(filename)!);
        sourceBackups[filename] = backupPath;
      }
      if (renderedNext.has(filename)) {
        const stagedPath = `${sourcePath}.stage.${sessionId}`;
        writeFile(stagedPath, renderedNext.get(filename)!);
        sourceStaged[filename] = stagedPath;
      }
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
  const nonce = randomBytes(8).toString("hex");
  const temporary = `${path}.${nonce}.tmp`;
  const backup = `${path}.${nonce}.backup`;
  let backedUp = false;
  writeFile(temporary, content);
  try {
    if (existsSync(path)) {
      renameSync(path, backup);
      backedUp = true;
    }
    renameSync(temporary, path);
    removeIfExists(backup);
  } catch (error) {
    if (backedUp && existsSync(backup)) {
      removeIfExists(path);
      renameSync(backup, path);
    }
    throw error;
  } finally {
    removeIfExists(temporary);
  }
}

function cleanTrackRegistryUpdateFiles(
  journal: TrackRegistryUpdateJournal,
  resolved: TrackRegistryLocations,
): void {
  for (const path of [...Object.values(journal.sourceStaged), ...Object.values(journal.sourceBackups)]) {
    removeIfExists(path);
  }
  removeIfExists(journal.databaseStaged);
  removeIfExists(journal.databaseBackup);
  removeIfExists(journal.reportStaged);
  removeIfExists(journal.reportBackup);
  removeIfExists(resolved.transactionPath);
  const root = shardRoot(resolved);
  for (const filename of new Set([
    ...Object.keys(journal.sourceStaged),
    ...Object.keys(journal.sourceBackups),
  ])) {
    pruneEmptySourceDirectories(sourceFilePath(resolved, filename), root);
  }
}

function actualSourceHash(locations: TrackRegistryLocations): string | null {
  try {
    return sha256OverSourceFiles(readTrackRegistrySourceFiles(locations));
  } catch {
    return null;
  }
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
  for (const filename of Object.keys(journal.sourceStaged)) {
    if (!journal.sourceBackups[filename]) removeIfExists(sourceFilePath(resolved, filename));
  }
  for (const [filename, backup] of Object.entries(journal.sourceBackups)) {
    if (!existsSync(backup)) {
      throw new Error(`Missing track registry source backup ${backup}`);
    }
    copyFileSync(backup, sourceFilePath(resolved, filename));
  }
  const restored = loadTrackRegistrySource(resolved);
  const restoredHash = sha256OverSourceFiles(renderTrackRegistrySource(restored));
  if (restoredHash !== journal.oldSourceHash) {
    throw new Error("Track registry recovery old-source hash mismatch");
  }
  rebuildRegistryArtifacts(restored, resolved);
  cleanTrackRegistryUpdateFiles(journal, resolved);
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

  if (actualSourceHash(resolved) === journal.newSourceHash) {
    const source = loadTrackRegistrySource(resolved);
    const canonicalHash = sha256OverSourceFiles(renderTrackRegistrySource(source));
    if (canonicalHash !== journal.newSourceHash) {
      throw new Error("Track registry recovery new-source hash mismatch");
    }
    rebuildRegistryArtifacts(source, resolved);
    cleanTrackRegistryUpdateFiles(journal, resolved);
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
  const currentFiles = readTrackRegistrySourceFiles(resolved);
  const needsCanonicalRewrite = currentFiles.size !== currentRendered.size ||
    [...currentRendered].some(([filename, contents]) => currentFiles.get(filename) !== contents);
  if (currentHash === nextHash && !needsCanonicalRewrite) return;
  assertRemovedMetadataHasNoAssets(currentRendered, nextRendered, resolved);

  const journal = stageTrackRegistrySourceUpdate(current, next, resolved, currentHash, nextHash);
  writeAtomicFile(resolved.transactionPath, `${JSON.stringify(journal, null, 2)}\n`);
  try {
    for (const [filename, staged] of Object.entries(journal.sourceStaged)) {
      renameSync(staged, sourceFilePath(resolved, filename));
    }
    for (const filename of Object.keys(journal.sourceBackups)) {
      if (!journal.sourceStaged[filename]) removeIfExists(sourceFilePath(resolved, filename));
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
  cleanTrackRegistryUpdateFiles(journal, resolved);
}

export function assertTrackRegistryArtifactsCurrent(locations: TrackRegistryLocationsInput = {}): void {
  const resolved = resolveTrackRegistryLocations(locations);
  if (existsSync(resolved.transactionPath)) {
    throw new Error(`Pending track registry source update ${resolved.transactionPath}; run bun run tracks:registry`);
  }
  const source = loadTrackRegistrySource(resolved);
  const rendered = renderTrackRegistrySource(source);
  const actual = readTrackRegistrySourceFiles(resolved);
  if (actual.size !== rendered.size) {
    throw new Error("Non-canonical track registry source file set; run bun run tracks:registry");
  }
  for (const [filename, contents] of rendered) {
    if (actual.get(filename) !== contents) {
      throw new Error(`Non-canonical track registry source ${sourceFilePath(resolved, filename)}; run bun run tracks:registry`);
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
