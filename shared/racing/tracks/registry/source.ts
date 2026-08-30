import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync, type Dirent } from "node:fs";
import { dirname, relative, resolve } from "node:path";

import { z } from "zod";

import { SHARED_DIR } from "@shared/platform/runtime/data-paths";
import { KNOWN_GAME_IDS, type GameId, GameIdSchema } from "../../../games/ids";
import {
  canonicalTrackAssetPathComponents,
  CURRENT_TRACK_REVISION,
  parseCanonicalTrackId,
  parseVenueRevisionPath,
  revisionDirectoryPathComponents,
  type TrackConfigurationConfirmation,
  TrackConfigurationConfirmationSchema,
  TrackVenueIdSchema,
} from "../configuration";
import { TrackFactsSchema, type CornerFact, type StraightFact, type TrackFacts } from "../facts";
import { TrackGeometrySchema, type TrackGeometry } from "../geometry";
import { parseCornerKey, parseStraightKey } from "../keys";
/** Authored track registry source schema version. */
export const TRACK_REGISTRY_SOURCE_VERSION = 1 as const;

/** Resolved source, generated read-model, report, and transaction paths. */
export interface TrackRegistryLocations {
  sourceDirectory: string;
  registryPath: string;
  reportPath: string;
  transactionPath: string;
}

/** Optional path overrides for isolated generation and tests. */
export interface TrackRegistryLocationsInput {
  sourceDirectory?: string;
  registryPath?: string;
  reportPath?: string;
  transactionPath?: string;
}

const TRACK_FACT_ID = /^[a-z0-9][a-z0-9-]*$/;

const TrackFactIdSchema = z.string().regex(TRACK_FACT_ID, "Use lowercase letters, digits, and hyphens");

const TrackIdentityNodeSchema = z
  .object({
    id: TrackVenueIdSchema,
    name: z.string().trim().min(1),
  })
  .strict();

const TrackLayoutSchema = z
  .object({
    id: TrackVenueIdSchema,
    name: z.string().trim().min(1),
    factsSlug: TrackFactIdSchema.optional(),
  })
  .strict();

const TrackAssignmentSchema = z
  .object({
    gameId: GameIdSchema,
    trackOrdinal: z.number().int().nonnegative(),
    layoutId: TrackVenueIdSchema,
    confirmation: TrackConfigurationConfirmationSchema.strict().nullable(),
  })
  .strict();

const TrackConfigurationsSchema = z
  .object({
    version: z.literal(TRACK_REGISTRY_SOURCE_VERSION),
    venues: z.array(TrackIdentityNodeSchema),
    layouts: z.array(TrackLayoutSchema),
    assignments: z.array(TrackAssignmentSchema),
  })
  .strict();

const TrackFileAssignmentSchema = z
  .object({
    gameId: GameIdSchema,
    trackOrdinal: z.number().int().nonnegative(),
    confirmation: TrackConfigurationConfirmationSchema.strict().nullable(),
  })
  .strict();

const VerifiedEntrySchema = z
  .object({
    hash: z.string().min(1),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    by: z.string().trim().min(1).optional(),
    note: z.string().trim().min(1).optional(),
  })
  .strict();

const VenueMetadataFileSchema = z
  .object({
    version: z.literal(TRACK_REGISTRY_SOURCE_VERSION),
    id: TrackVenueIdSchema,
    name: z.string().trim().min(1),
  })
  .strict();

const TrackMetadataFileSchema = z
  .object({
    version: z.literal(TRACK_REGISTRY_SOURCE_VERSION),
    id: TrackVenueIdSchema,
    name: z.string().trim().min(1),
    assignments: z.array(TrackFileAssignmentSchema),
    facts: TrackFactsSchema.strict().optional(),
    geometryByGame: z.partialRecord(GameIdSchema, TrackGeometrySchema.strict()).optional(),
    verification: z
      .object({
        meta: VerifiedEntrySchema.optional(),
        segments: z.partialRecord(GameIdSchema, VerifiedEntrySchema).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const RevisionMetadataFileSchema = z
  .object({
    version: z.literal(TRACK_REGISTRY_SOURCE_VERSION),
    id: TrackVenueIdSchema,
    name: z.string().trim().min(1),
  })
  .strict();

/** Canonical venue, layout, and game assignment source document. */
export type TrackConfigurationSource = z.infer<typeof TrackConfigurationsSchema>;
/** Game-independent facts source document. */
export interface TrackFactsSource {
  version: typeof TRACK_REGISTRY_SOURCE_VERSION;
  facts: TrackFacts[];
}
/** Per-game normalized geometry source document. */
export interface TrackGeometrySource {
  version: typeof TRACK_REGISTRY_SOURCE_VERSION;
  geometry: Array<{ factsSlug: string; gameId: GameId } & TrackGeometry>;
}
/** Curation verification ledger source document. */
export interface TrackVerificationSource {
  version: typeof TRACK_REGISTRY_SOURCE_VERSION;
  entries: Record<string, VerifiedEntry>;
}

/** Sign-off metadata binding authored content to reviewed hash. */
export interface VerifiedEntry {
  hash: string;
  date: string;
  by?: string;
  note?: string;
}

/** Verification entries keyed by authored asset identity. */
export type VerifiedLedger = Record<string, VerifiedEntry>;

/** Complete parsed and validated authored registry source. */
export interface TrackRegistrySource {
  configurations: TrackConfigurationSource;
  facts: TrackFactsSource;
  geometry: TrackGeometrySource;
  verification: TrackVerificationSource;
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
/** @internal Stable game ordering shared by canonical registry renderers. */
export const TRACK_GAME_ORDER = Object.fromEntries(KNOWN_GAME_IDS.map((gameId, index) => [gameId, index])) as Record<string, number>;

function jsonBytes(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function parseIsoDate(value: string, path: string): void {
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) {
    throw new Error(`${path}: invalid date ${value}`);
  }
}

/** @internal Compute deterministic source identity over sorted relative names and contents. */
export function sha256OverSourceFiles(files: ReadonlyMap<string, string>): string {
  const hash = createHash("sha256");
  for (const [filename, body] of [...files.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    hash.update(filename).update("\0").update(body);
  }
  return hash.digest("hex");
}

/** @internal Derive parent canonical venue path, accounting for revision hierarchy. */
export function deriveVenueParent(path: string): string | null {
  const { rootVenuePath, revisionPath } = parseVenueRevisionPath(path);
  if (revisionPath === CURRENT_TRACK_REVISION) return null;
  const components = revisionDirectoryPathComponents(path).slice(3, -1);
  return components.length === 0 ? rootVenuePath : `${rootVenuePath}/${components.join("/")}`;
}

/** @internal Derive terminal venue segment from canonical venue path. */
export function deriveVenueSlug(path: string): string {
  const { rootVenuePath, revisionPath } = parseVenueRevisionPath(path);
  if (revisionPath === CURRENT_TRACK_REVISION) return rootVenuePath;
  return revisionDirectoryPathComponents(path).at(-1)!;
}

/** @internal Extract venue path from canonical layout ID. */
export function deriveLayoutVenuePath(id: string): string {
  return parseCanonicalTrackId(id).venuePath;
}

/** @internal Extract layout segment from canonical layout ID. */
export function deriveLayoutSlug(id: string): string {
  return parseCanonicalTrackId(id).layoutSlug;
}

/** @internal Read required UTF-8 registry file with domain-specific error. */
export function readFile(path: string): string {
  if (!existsSync(path)) throw new Error(`Missing track registry file ${path}`);
  return readFileSync(path, "utf8");
}

/** @internal Create parent directories and write UTF-8 registry file. */
export function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

/** @internal Remove regular registry file when present. */
export function removeIfExists(path: string): void {
  if (!existsSync(path)) return;
  try {
    unlinkSync(path);
  } catch {
    // best effort
  }
}
/** @internal Remove empty source directories up to registry shard root. */
export function pruneEmptySourceDirectories(path: string, root: string): void {
  let directory = dirname(path);
  while (directory !== root && !relative(root, directory).startsWith("..")) {
    if (!existsSync(directory) || readdirSync(directory).length > 0) return;
    rmdirSync(directory);
    directory = dirname(directory);
  }
}

/** @internal Resolve common directory containing source shard and generated artifacts. */
export function shardRoot(locations: TrackRegistryLocations): string {
  return dirname(locations.sourceDirectory);
}

/** @internal Resolve validated source-relative path without permitting root escape. */
export function sourceFilePath(locations: TrackRegistryLocations, filename: string): string {
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

/** Read canonical source shard files in deterministic relative-path order. */
export function readTrackRegistrySourceFiles(locations: TrackRegistryLocationsInput = {}): ReadonlyMap<string, string> {
  const resolved = resolveTrackRegistryLocations(locations);
  return new Map(sourcePaths(resolved).map((filename) => [filename, readFile(sourceFilePath(resolved, filename))]));
}

/** Resolve default registry locations and apply caller path overrides. */
export function resolveTrackRegistryLocations(locations: TrackRegistryLocationsInput = {}): TrackRegistryLocations {
  const overrideRoot =
    process.env.RACEIQ_TRACK_REGISTRY_DIR && (process.env.RACEIQ_TEST_MODE === "1" || process.env.NODE_ENV === "test" || process.env.RACEIQ_E2E === "1")
      ? resolve(process.env.RACEIQ_TRACK_REGISTRY_DIR)
      : null;
  const tracksRoot = overrideRoot ?? resolve(SHARED_DIR, "tracks");
  const defaultLocations: TrackRegistryLocations = {
    sourceDirectory: resolve(tracksRoot, "registry-source"),
    registryPath: resolve(tracksRoot, "registry.json"),
    reportPath: resolve(tracksRoot, "registry-report.json"),
    transactionPath: resolve(tracksRoot, ".registry-source-update.json"),
  };

  return {
    ...defaultLocations,
    ...locations,
  };
}
function findColocatedAsset(directory: string, root: string, registryPaths: ReadonlySet<string>): string | null {
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

/** @internal Reject metadata deletion while colocated authored assets still exist. */
export function assertRemovedMetadataHasNoAssets(current: ReadonlyMap<string, string>, next: ReadonlyMap<string, string>, locations: TrackRegistryLocations): void {
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
      const byGame = (TRACK_GAME_ORDER[a.gameId] ?? Number.MAX_SAFE_INTEGER) - (TRACK_GAME_ORDER[b.gameId] ?? Number.MAX_SAFE_INTEGER);
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
        ...(straights.length ? { straights: straights.sort((a, b) => a.after - b.after) } : {}),
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
      const byGame = (TRACK_GAME_ORDER[a.gameId] ?? Number.MAX_SAFE_INTEGER) - (TRACK_GAME_ORDER[b.gameId] ?? Number.MAX_SAFE_INTEGER);
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

/** @internal Canonicalize source ordering and enforce cross-document identity invariants. */
export function validateTrackConfigurationSource(source: TrackRegistrySource): TrackRegistrySource {
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

/** Parse, canonicalize, and validate registry source shard. */
export function loadTrackRegistrySource(locations: TrackRegistryLocationsInput = {}): TrackRegistrySource {
  const resolved = resolveTrackRegistryLocations(locations);
  const parsed = parseSourceDocuments(resolved);
  return validateTrackConfigurationSource(parsed);
}

/** Render complete source into canonical relative-path UTF-8 documents. */
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
      map.set(
        `${VENUES_DIRECTORY}/${rootVenuePath}/${VENUE_FILE}`,
        jsonBytes({
          version: TRACK_REGISTRY_SOURCE_VERSION,
          id: venue.id,
          name: venue.name,
        }),
      );
      map.set(
        `${revisionDirectoryPathComponents(venue.id).join("/")}/${REVISION_FILE}`,
        jsonBytes({
          version: TRACK_REGISTRY_SOURCE_VERSION,
          id: CURRENT_TRACK_REVISION,
          name: "Current",
        }),
      );
      continue;
    }
    map.set(
      `${revisionDirectoryPathComponents(venue.id).join("/")}/${REVISION_FILE}`,
      jsonBytes({
        version: TRACK_REGISTRY_SOURCE_VERSION,
        id: revisionPath,
        name: venue.name,
      }),
    );
  }
  for (const layout of canonical.configurations.layouts) {
    const fact = layout.factsSlug ? factsBySlug.get(layout.factsSlug) : undefined;
    if (layout.factsSlug && !fact) throw new Error(`Layout ${layout.id} references unknown factsSlug ${layout.factsSlug}`);
    const geometryByGame: Partial<Record<GameId, TrackGeometry>> = {};
    for (const geometry of fact ? (geometryByFactsSlug.get(fact.slug) ?? []) : []) {
      geometryByGame[geometry.gameId] = {
        ...(geometry.sectors ? { sectors: geometry.sectors } : {}),
        segments: geometry.segments,
      };
    }
    const segmentVerification = fact
      ? Object.fromEntries(
          Object.keys(geometryByGame)
            .filter((gameId) => canonical.verification.entries[`segments:${gameId}/${fact.slug}`])
            .map((gameId) => [gameId, canonical.verification.entries[`segments:${gameId}/${fact.slug}`]!]),
        )
      : {};
    const verification = fact
      ? {
          ...(canonical.verification.entries[`meta:${fact.slug}`] ? { meta: canonical.verification.entries[`meta:${fact.slug}`] } : {}),
          ...(Object.keys(segmentVerification).length ? { segments: segmentVerification } : {}),
        }
      : undefined;
    const { venuePath, layoutSlug } = parseCanonicalTrackId(layout.id);
    map.set(
      `${canonicalTrackAssetPathComponents(venuePath, layoutSlug).join("/")}/${TRACK_METADATA_FILE}`,
      jsonBytes({
        version: TRACK_REGISTRY_SOURCE_VERSION,
        id: layout.id,
        name: layout.name,
        assignments: canonical.configurations.assignments
          .filter((assignment) => assignment.layoutId === layout.id)
          .map(({ gameId, trackOrdinal, confirmation }) => ({ gameId, trackOrdinal, confirmation })),
        ...(fact ? { facts: fact } : {}),
        ...(Object.keys(geometryByGame).length ? { geometryByGame } : {}),
        ...(verification && Object.keys(verification).length ? { verification } : {}),
      }),
    );
  }
  return map;
}
/** @internal Replace one text file atomically while restoring previous file on failure. */
export function writeAtomicFile(path: string, content: string): void {
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
