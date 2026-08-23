import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getIRacingOvalDirection, getIRacingTrack } from "../../../shared/racing/tracks/catalogs/iracing";
import { canonicalTrackAssetPathComponents, trackConfigurationVenueId } from "../../../shared/racing/tracks/configuration";
import { USER_TRACKS_DIR } from "../../../shared/platform/runtime/data-paths";
import { SHARED_DIR } from "../../runtime/config/paths";
import { loadTrackConfiguration } from "../../tracks/configuration";

import { parseIRacingActiveSvg, parseIRacingPitRoadSvg, type IRacingSvgTrackMap } from "./track-map-svg";

interface CachedMapFile extends Omit<IRacingSvgTrackMap, "pitLines"> {
  version: 4;
  mapUrl: string;
  /** Omitted when pit-road layer fetch fails; next request retries that layer. */
  pitLines?: IRacingSvgTrackMap["pitLines"];
}

interface CachedMapResult {
  map: IRacingSvgTrackMap;
  hasPitLineLayer: boolean;
}

/**
 * SVG contour order is arbitrary when turn-label layer is unavailable.
 * Normalize oval traversal to physical race direction while retaining
 * start/finish as point zero.
 */
export function orientIRacingOvalMap(map: IRacingSvgTrackMap, direction: "left" | "right"): IRacingSvgTrackMap {
  let signedArea = 0;
  for (let index = 0; index < map.points.length; index++) {
    const point = map.points[index];
    const next = map.points[(index + 1) % map.points.length];
    signedArea += point.x * next.z - next.x * point.z;
  }
  const shouldBePositive = direction === "left";
  if (signedArea > 0 === shouldBePositive) return map;
  return {
    ...map,
    points: [map.points[0], ...map.points.slice(1).reverse()],
  };
}

export const IRACING_MAP_CACHE_VERSION = 4;
const FETCH_TIMEOUT_MS = 4_000;
const PUBLIC_MAP_PREFIX = "https://members-assets.iracing.com/public/track-maps/";
const memoryCache = new Map<number, Promise<IRacingSvgTrackMap | null>>();

function cachePath(ordinal: number): string {
  return resolve(USER_TRACKS_DIR, "iracing", "official-svg", `${ordinal}.json`);
}

function bundledLayerDirectory(ordinal: number): string | null {
  const configuration = loadTrackConfiguration("iracing", ordinal);
  if (!configuration) return null;
  return resolve(
    SHARED_DIR,
    "tracks",
    ...canonicalTrackAssetPathComponents(trackConfigurationVenueId(configuration), configuration.track.id),
    "geometry",
    "iracing",
    "official",
  );
}

function readBundledMap(ordinal: number): CachedMapResult | null {
  const directory = bundledLayerDirectory(ordinal);
  if (!directory) return null;
  const activePath = resolve(directory, "active.svg");
  const startFinishPath = resolve(directory, "start-finish.svg");
  const turnsPath = resolve(directory, "turns.svg");
  const pitRoadPath = resolve(directory, "pit-road.svg");
  if (!existsSync(activePath) || !existsSync(startFinishPath) || !existsSync(turnsPath)) return null;
  const pitRoadSvg = existsSync(pitRoadPath) ? readFileSync(pitRoadPath, "utf8") : null;
  const map = parseIRacingActiveSvg(
    readFileSync(activePath, "utf8"),
    readFileSync(startFinishPath, "utf8"),
    readFileSync(turnsPath, "utf8"),
    pitRoadSvg,
  );
  return map ? { map, hasPitLineLayer: pitRoadSvg !== null } : null;
}

function readCache(path: string, mapUrl: string): CachedMapResult | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as CachedMapFile;
    const valid = parsed.version === IRACING_MAP_CACHE_VERSION && parsed.mapUrl === mapUrl && Array.isArray(parsed.points) && parsed.points.length >= 20 && Array.isArray(parsed.labels);
    if (!valid) return null;
    const hasPitLineLayer = Array.isArray(parsed.pitLines);
    return {
      map: {
        points: parsed.points,
        labels: parsed.labels,
        pitLines: hasPitLineLayer ? parsed.pitLines! : [],
      },
      hasPitLineLayer,
    };
  } catch {
    return null;
  }
}


function writeCachedMap(ordinal: number, mapUrl: string, map: IRacingSvgTrackMap, includePitLines = true): void {
  const path = cachePath(ordinal);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      `${JSON.stringify({
        version: IRACING_MAP_CACHE_VERSION,
        mapUrl,
        points: map.points,
        labels: map.labels,
        ...(includePitLines && { pitLines: map.pitLines }),
      } satisfies CachedMapFile, null, 2)}\n`,
    );
  } catch (error) {
    console.warn(`[iRacing Map] Could not cache track ${ordinal}:`, error);
  }
}

async function fetchSvg(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": "RaceIQ iRacing track map" },
      signal: controller.signal,
    });
    return response.ok ? response.text() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function loadMap(ordinal: number): Promise<IRacingSvgTrackMap | null> {
  const track = getIRacingTrack(ordinal);
  if (!track) return null;
  const mapUrl = track.mapUrl;
  if (!mapUrl.startsWith(PUBLIC_MAP_PREFIX)) return null;
  const ovalDirection = getIRacingOvalDirection(ordinal);
  const orientMap = (map: IRacingSvgTrackMap) => (ovalDirection ? orientIRacingOvalMap(map, ovalDirection) : map);

  const bundled = readBundledMap(ordinal);
  if (bundled?.hasPitLineLayer) return orientMap(bundled.map);
  const cached = readCache(cachePath(ordinal), mapUrl);
  if (cached?.hasPitLineLayer) return orientMap(cached.map);
  const incomplete = bundled ?? cached;
  if (incomplete) {
    const pitRoadSvg = track.pitMapUrl ? await fetchSvg(track.pitMapUrl) : null;
    const upgraded = {
      ...incomplete.map,
      pitLines: pitRoadSvg ? parseIRacingPitRoadSvg(pitRoadSvg) : [],
    };
    if (pitRoadSvg || !track.pitMapUrl) {
      writeCachedMap(ordinal, mapUrl, upgraded);
    } else {
      // Keep serving the valid outline, but retry the transient missing layer.
      memoryCache.delete(ordinal);
    }
    return orientMap(upgraded);
  }

  const layerUrl = (name: string) => new URL(name, mapUrl).href;
  const [activeSvg, startFinishSvg, turnsSvg, pitRoadSvg] = await Promise.all([
    fetchSvg(mapUrl),
    fetchSvg(track.startFinishMapUrl || layerUrl("start-finish.svg")),
    fetchSvg(track.turnsMapUrl || layerUrl("turns.svg")),
    track.pitMapUrl ? fetchSvg(track.pitMapUrl) : null,
  ]);
  if (!activeSvg) return null;
  const map = parseIRacingActiveSvg(activeSvg, startFinishSvg, turnsSvg, pitRoadSvg);
  const oriented = map ? orientMap(map) : null;
  if (oriented) {
    writeCachedMap(ordinal, mapUrl, oriented, !!pitRoadSvg || !track.pitMapUrl);
  }
  if (!pitRoadSvg && track.pitMapUrl) {
    // Active map succeeded; only pit-road fetch was transiently incomplete.
    memoryCache.delete(ordinal);
  }
  return oriented;
}

/** Resolve and memoize one exact iRacing layout's official SVG map. */
export function getIRacingSvgTrackMap(ordinal: number): Promise<IRacingSvgTrackMap | null> {
  const existing = memoryCache.get(ordinal);
  if (existing) return existing;
  const pending = loadMap(ordinal);
  memoryCache.set(ordinal, pending);
  pending.then((map) => {
    // Do not pin transient network failures for the lifetime of the server.
    if (!map) memoryCache.delete(ordinal);
  });
  return pending;
}
