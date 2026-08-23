import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import sharp from "sharp";
import {
  TRACK_IMAGERY_PACKAGE_NAME,
  TrackImageryLayoutManifestSchema,
  TrackImageryVenueManifestSchema,
  type TrackImagery,
  type TrackImageryConfigurationIndex,
  type TrackImageryLayoutManifest,
  type TrackImageryVenueManifest,
} from "../../shared/racing/tracks/imagery";
import { revisionDirectoryPathComponents, canonicalTrackAssetPathComponents, trackConfigurationVenueId, type TrackConfiguration } from "../../shared/racing/tracks/configuration";
import type { GameId } from "../../shared/games/ids";
import { USER_TRACKS_DIR } from "../../shared/platform/runtime/data-paths";
import { SHARED_DIR } from "../runtime/config/paths";
import { listTrackConfigurations, loadTrackConfiguration } from "./configuration";
import { readTrackImageryPackMetadata, type TrackImageryPackMetadata } from "./imagery-pack";
import { resolveTrackImageryPackPath } from "./imagery-artifact";

const TRACK_ASSET_ROOT = resolve(SHARED_DIR, "tracks");

export interface LoadedTrackImageryTexture {
  path: string;
  modifiedAtMs: number;
}

export interface LoadedTrackImagery {
  imagery: TrackImagery;
  textures: Record<string, LoadedTrackImageryTexture>;
  packPath: string;
  packMetadata: TrackImageryPackMetadata;
}

export function trackImageryVenueDirectory(venueId: string): string {
  return resolve(TRACK_ASSET_ROOT, ...revisionDirectoryPathComponents(venueId), "imagery");
}

function trackImageryLayoutPathForConfiguration(configuration: TrackConfiguration): string {
  const venueId = trackConfigurationVenueId(configuration);
  return resolve(TRACK_ASSET_ROOT, ...canonicalTrackAssetPathComponents(venueId, configuration.track.id), "imagery", `${configuration.gameId}.json`);
}

export function trackImageryLayoutPath(gameId: GameId, trackOrdinal: number): string {
  const configuration = loadTrackConfiguration(gameId, trackOrdinal);
  if (!configuration) throw new Error(`Missing track configuration ${gameId}/${trackOrdinal}`);
  return trackImageryLayoutPathForConfiguration(configuration);
}

function loadTrackImageryLayoutForConfiguration(configuration: TrackConfiguration): TrackImageryLayoutManifest | null {
  const path = trackImageryLayoutPathForConfiguration(configuration);
  if (!existsSync(path)) return null;
  const parsed = TrackImageryLayoutManifestSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success) throw new Error(`Invalid track imagery layout ${path}: ${parsed.error.message}`);
  if (parsed.data.gameId !== configuration.gameId || parsed.data.trackOrdinal !== configuration.trackOrdinal) {
    throw new Error(`Track imagery layout identity mismatch in ${path}`);
  }
  return parsed.data;
}

export function loadTrackImageryLayout(gameId: GameId, trackOrdinal: number): TrackImageryLayoutManifest | null {
  const configuration = loadTrackConfiguration(gameId, trackOrdinal);
  return configuration ? loadTrackImageryLayoutForConfiguration(configuration) : null;
}

export function loadTrackImageryVenue(venueId: string): TrackImageryVenueManifest | null {
  const path = resolve(trackImageryVenueDirectory(venueId), "manifest.json");
  if (!existsSync(path)) return null;
  const parsed = TrackImageryVenueManifestSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success) throw new Error(`Invalid track imagery venue ${path}: ${parsed.error.message}`);
  if (parsed.data.venueId !== venueId) throw new Error(`Track imagery venue identity mismatch in ${path}`);
  return parsed.data;
}
export function listTrackImageryConfigurations(): TrackImageryConfigurationIndex {
  const venues: TrackImageryVenueManifest[] = [];
  const layouts: TrackImageryLayoutManifest[] = [];
  const seenVenues = new Set<string>();
  for (const configuration of listTrackConfigurations()) {
    const venueId = trackConfigurationVenueId(configuration);
    if (!seenVenues.has(venueId)) {
      seenVenues.add(venueId);
      const venue = loadTrackImageryVenue(venueId);
      if (venue) venues.push(venue);
    }
    const layout = loadTrackImageryLayoutForConfiguration(configuration);
    if (layout) layouts.push(layout);
  }
  venues.sort((a, b) => a.venueId.localeCompare(b.venueId));
  return { venues, layouts };
}

function textureFile(directory: string, fileName: string): LoadedTrackImageryTexture {
  if (fileName !== basename(fileName)) throw new Error(`Invalid track imagery file name ${fileName}`);
  const path = resolve(directory, fileName);
  if (!existsSync(path)) throw new Error(`Missing track imagery texture ${path}`);
  return { path, modifiedAtMs: statSync(path).mtimeMs };
}

export async function loadTrackImagery(gameId: GameId, trackOrdinal: number): Promise<LoadedTrackImagery | null> {
  const configuration = loadTrackConfiguration(gameId, trackOrdinal);
  if (!configuration) return null;
  const layout = loadTrackImageryLayoutForConfiguration(configuration);
  if (!layout) return null;
  const venueId = trackConfigurationVenueId(configuration);
  const venue = loadTrackImageryVenue(venueId);
  if (!venue) throw new Error(`Missing track imagery venue ${venueId}`);
  const directory = trackImageryVenueDirectory(venueId);
  if (venue.base.pack !== TRACK_IMAGERY_PACKAGE_NAME) throw new Error(`Unsupported imagery package ${venue.base.pack}`);
  const localPackPath = resolve(directory, TRACK_IMAGERY_PACKAGE_NAME);
  const packPath = await resolveTrackImageryPackPath(localPackPath, venue.base.artifact);
  const packMetadata = readTrackImageryPackMetadata(packPath);
  const boundsMatch = JSON.stringify(packMetadata.bounds) === JSON.stringify(venue.base.bounds);
  const resolutionMatch = venue.base.source.storedResolutionM === undefined || venue.base.source.storedResolutionM === packMetadata.resolutionM;
  if (packMetadata.tier !== "hq" || packMetadata.tileSize !== venue.base.tileSize || !boundsMatch || !resolutionMatch || !packMetadata.contentHash) {
    throw new Error(`Imagery package metadata mismatch in ${packPath}`);
  }
  const packageVersion = packMetadata.contentHash;
  const textures: Record<string, LoadedTrackImageryTexture> = {};
  const selectedLayers = [];
  const seen = new Set<string>();
  for (const layerId of layout.layers) {
    if (seen.has(layerId)) continue;
    seen.add(layerId);
    const layer = venue.layers.find((candidate) => candidate.id === layerId);
    if (!layer) throw new Error(`Missing imagery layer ${layerId} in venue ${venueId}`);
    textures[layer.id] = textureFile(resolve(directory, "layers"), layer.image);
    selectedLayers.push(layer);
  }
  const publicTextures = selectedLayers.map((layer) => ({
    id: layer.id,
    kind: layer.kind,
    opacity: layer.opacity,
    source: layer.source,
    url: `/api/track-imagery/${trackOrdinal}/texture/${encodeURIComponent(layer.id)}?gameId=${encodeURIComponent(gameId)}&v=${Math.round(textures[layer.id]!.modifiedAtMs)}`,
  }));
  return {
    imagery: {
      version: 2,
      venueId: venue.venueId,
      calibration: venue.calibration,
      base: {
        tier: packMetadata.tier,
        width: packMetadata.width,
        height: packMetadata.height,
        tileSize: packMetadata.tileSize,
        columns: packMetadata.columns,
        rows: packMetadata.rows,
        bounds: venue.base.bounds,
        contentHash: packageVersion,
        ...(packMetadata.resolutionM === undefined ? {} : { resolutionM: packMetadata.resolutionM }),
        source: venue.base.source,
        tileUrlTemplate: `/api/track-imagery/${trackOrdinal}/base/hq/{x}/{y}?gameId=${encodeURIComponent(gameId)}&v=${encodeURIComponent(packageVersion)}`,
      },
      textures: publicTextures,
    },
    textures,
    packPath,
    packMetadata,
  };
}

export function trackImageryContentType(fileName: string): string {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  return "image/jpeg";
}

const TRACK_BASE_IMAGERY_DIR = join(USER_TRACKS_DIR, "imagery");
const MAX_BASE_IMAGE_DIMENSION = 2560;
const baseImageUrlByPath = new Map<string, string | null>();

export function getBaseTrackImagePath(gameId: GameId, baseTrackName: string): string {
  const identity = `${gameId}\0${baseTrackName.trim().normalize("NFKC").toLocaleLowerCase()}`;
  const digest = createHash("sha256").update(identity).digest("hex").slice(0, 24);
  return join(TRACK_BASE_IMAGERY_DIR, `${gameId}-${digest}.webp`);
}

export function getBaseTrackImageUrl(gameId: GameId, baseTrackName: string): string | null {
  const path = getBaseTrackImagePath(gameId, baseTrackName);
  const cached = baseImageUrlByPath.get(path);
  if (cached !== undefined) return cached;

  try {
    const modifiedAt = Math.trunc(statSync(path).mtimeMs);
    const url = `/api/track-base-image?gameId=${encodeURIComponent(gameId)}&baseTrackName=${encodeURIComponent(baseTrackName)}&v=${modifiedAt}`;
    baseImageUrlByPath.set(path, url);
    return url;
  } catch {
    baseImageUrlByPath.set(path, null);
    return null;
  }
}

export async function saveBaseTrackImage(gameId: GameId, baseTrackName: string, input: ArrayBuffer): Promise<string> {
  const image = await sharp(input, { failOn: "error", limitInputPixels: 40_000_000 })
    .rotate()
    .resize({ width: MAX_BASE_IMAGE_DIMENSION, height: MAX_BASE_IMAGE_DIMENSION, fit: "inside", withoutEnlargement: true })
    .webp({ quality: 88 })
    .toBuffer();

  mkdirSync(TRACK_BASE_IMAGERY_DIR, { recursive: true });
  const path = getBaseTrackImagePath(gameId, baseTrackName);
  await Bun.write(path, image);
  baseImageUrlByPath.delete(path);
  return getBaseTrackImageUrl(gameId, baseTrackName)!;
}
