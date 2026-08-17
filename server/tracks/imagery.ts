import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import {
  TrackImageryLayoutManifestSchema,
  TrackImageryVenueManifestSchema,
  type TrackImagery,
  type TrackImageryLayoutManifest,
  type TrackImageryVenueManifest,
} from "../../shared/racing/tracks/imagery";
import type { GameId } from "../../shared/games/ids";
import { SHARED_DIR } from "../runtime/config/paths";

const TRACK_IMAGERY_ROOT = resolve(SHARED_DIR, "tracks", "imagery");

export interface LoadedTrackImageryTexture {
  path: string;
  modifiedAtMs: number;
}

export interface LoadedTrackImagery {
  imagery: TrackImagery;
  textures: Record<string, LoadedTrackImageryTexture>;
}

export function trackImageryVenueDirectory(venueId: string): string {
  return resolve(TRACK_IMAGERY_ROOT, "venues", venueId);
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

function textureFile(directory: string, fileName: string): LoadedTrackImageryTexture {
  if (fileName !== basename(fileName)) throw new Error(`Invalid track imagery file name ${fileName}`);
  const path = resolve(directory, fileName);
  if (!existsSync(path)) throw new Error(`Missing track imagery texture ${path}`);
  return { path, modifiedAtMs: statSync(path).mtimeMs };
}

export function loadTrackImagery(gameId: GameId, trackOrdinal: number): LoadedTrackImagery | null {
  const layout = loadTrackImageryLayout(gameId, trackOrdinal);
  if (!layout) return null;
  const venue = loadTrackImageryVenue(layout.venueId);
  if (!venue) throw new Error(`Missing track imagery venue ${layout.venueId}`);
  const directory = trackImageryVenueDirectory(layout.venueId);
  const textures: Record<string, LoadedTrackImageryTexture> = { base: textureFile(directory, venue.base.image) };
  const selectedLayers = [];
  const seen = new Set<string>();
  for (const layerId of layout.layers) {
    if (seen.has(layerId)) continue;
    seen.add(layerId);
    const layer = venue.layers.find((candidate) => candidate.id === layerId);
    if (!layer) throw new Error(`Missing imagery layer ${layerId} in venue ${layout.venueId}`);
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
