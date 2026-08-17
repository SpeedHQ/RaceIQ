import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, relative, resolve, sep } from "node:path";
import {
  TrackImageryLayoutManifestSchema,
  TrackImageryVenueManifestSchema,
  type TrackImagery,
  type TrackImageryConfigurationIndex,
  type TrackImageryLayoutManifest,
  type TrackImageryVenueManifest,
} from "../../shared/racing/tracks/imagery";
import { TrackVenueIdSchema, trackConfigurationVenueId } from "../../shared/racing/tracks/configuration";
import { KNOWN_GAME_IDS, type GameId } from "../../shared/games/ids";
import { SHARED_DIR } from "../runtime/config/paths";
import { loadTrackConfiguration } from "./configuration";

const TRACK_IMAGERY_ROOT = resolve(SHARED_DIR, "tracks", "imagery");
const TRACK_IMAGERY_VENUES_ROOT = resolve(TRACK_IMAGERY_ROOT, "venues");

export interface LoadedTrackImageryTexture {
  path: string;
  modifiedAtMs: number;
}

export interface LoadedTrackImagery {
  imagery: TrackImagery;
  textures: Record<string, LoadedTrackImageryTexture>;
}

export function trackImageryVenueDirectory(venueId: string): string {
  const parsed = TrackVenueIdSchema.parse(venueId);
  return resolve(TRACK_IMAGERY_VENUES_ROOT, ...parsed.split("/"));
}

export function trackImageryLayoutPath(gameId: GameId, trackOrdinal: number): string {
  return resolve(TRACK_IMAGERY_ROOT, "layouts", gameId, `${trackOrdinal}.json`);
}

export function loadTrackImageryLayout(gameId: GameId, trackOrdinal: number): TrackImageryLayoutManifest | null {
  const path = trackImageryLayoutPath(gameId, trackOrdinal);
  if (!existsSync(path)) return null;
  const parsed = TrackImageryLayoutManifestSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success) throw new Error(`Invalid track imagery layout ${path}: ${parsed.error.message}`);
  if (parsed.data.gameId !== gameId || parsed.data.trackOrdinal !== trackOrdinal) throw new Error(`Track imagery layout identity mismatch in ${path}`);
  return parsed.data;
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
  if (existsSync(TRACK_IMAGERY_VENUES_ROOT)) {
    const visit = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const child = resolve(directory, entry.name);
        const manifestPath = resolve(child, "manifest.json");
        if (existsSync(manifestPath)) {
          const venueId = relative(TRACK_IMAGERY_VENUES_ROOT, child).split(sep).join("/");
          const venue = loadTrackImageryVenue(venueId);
          if (venue) venues.push(venue);
        }
        visit(child);
      }
    };
    visit(TRACK_IMAGERY_VENUES_ROOT);
  }
  for (const gameId of KNOWN_GAME_IDS) {
    const directory = resolve(TRACK_IMAGERY_ROOT, "layouts", gameId);
    if (!existsSync(directory)) continue;
    for (const entry of readdirSync(directory)) {
      if (!entry.endsWith(".json")) continue;
      const trackOrdinal = Number.parseInt(entry.slice(0, -5), 10);
      if (!Number.isSafeInteger(trackOrdinal) || trackOrdinal < 0) continue;
      const layout = loadTrackImageryLayout(gameId, trackOrdinal);
      if (layout) layouts.push(layout);
    }
  }
  venues.sort((a, b) => a.venueId.localeCompare(b.venueId));
  layouts.sort((a, b) => KNOWN_GAME_IDS.indexOf(a.gameId) - KNOWN_GAME_IDS.indexOf(b.gameId) || a.trackOrdinal - b.trackOrdinal);
  return { venues, layouts };
}

function textureFile(directory: string, fileName: string): LoadedTrackImageryTexture {
  if (fileName !== basename(fileName)) throw new Error(`Invalid track imagery file name ${fileName}`);
  const path = resolve(directory, fileName);
  if (!existsSync(path)) throw new Error(`Missing track imagery texture ${path}`);
  return { path, modifiedAtMs: statSync(path).mtimeMs };
}

export function loadTrackImagery(gameId: GameId, trackOrdinal: number): LoadedTrackImagery | null {
  const configuration = loadTrackConfiguration(gameId, trackOrdinal);
  const layout = loadTrackImageryLayout(gameId, trackOrdinal);
  if (!configuration || !layout) return null;
  const venueId = trackConfigurationVenueId(configuration);
  const venue = loadTrackImageryVenue(venueId);
  if (!venue) throw new Error(`Missing track imagery venue ${venueId}`);
  const directory = trackImageryVenueDirectory(venueId);
  const textures: Record<string, LoadedTrackImageryTexture> = { base: textureFile(directory, venue.base.image) };
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
  const publicTextures = [
    { id: "base", kind: "base" as const, opacity: 1, source: venue.base.source, url: "" },
    ...selectedLayers.map((layer) => ({ id: layer.id, kind: layer.kind, opacity: layer.opacity, source: layer.source, url: "" })),
  ].map((texture) => ({
    ...texture,
    url: `/api/track-imagery/${trackOrdinal}/texture/${encodeURIComponent(texture.id)}?gameId=${encodeURIComponent(gameId)}&v=${Math.round(textures[texture.id]!.modifiedAtMs)}`,
  }));
  return {
    imagery: { version: 1, venueId: venue.venueId, calibration: venue.calibration, textures: publicTextures },
    textures,
  };
}

export function trackImageryContentType(fileName: string): string {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  return "image/jpeg";
}
