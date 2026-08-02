import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { getIRacingTrack } from "../../../shared/iracing-track-data";
import { USER_TRACKS_DIR } from "../../../shared/resolve-data";

import {
  parseIRacingActiveSvg,
  type IRacingSvgTrackMap,
} from "./track-map-svg";

interface CachedMapFile extends IRacingSvgTrackMap {
  version: 1;
  mapUrl: string;
}

const MAP_CACHE_VERSION = 1;
const FETCH_TIMEOUT_MS = 4_000;
const PUBLIC_MAP_PREFIX =
  "https://members-assets.iracing.com/public/track-maps/";
const memoryCache = new Map<number, Promise<IRacingSvgTrackMap | null>>();

function cachePath(ordinal: number): string {
  return resolve(
    USER_TRACKS_DIR,
    "iracing",
    "official-svg",
    `${ordinal}.json`,
  );
}

function readCachedMap(
  ordinal: number,
  mapUrl: string,
): IRacingSvgTrackMap | null {
  const path = cachePath(ordinal);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as CachedMapFile;
    return parsed.version === MAP_CACHE_VERSION &&
      parsed.mapUrl === mapUrl &&
      Array.isArray(parsed.points) &&
      parsed.points.length >= 20
      ? { points: parsed.points, labels: parsed.labels ?? [] }
      : null;
  } catch {
    return null;
  }
}

function writeCachedMap(
  ordinal: number,
  mapUrl: string,
  map: IRacingSvgTrackMap,
): void {
  const path = cachePath(ordinal);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        version: MAP_CACHE_VERSION,
        mapUrl,
        ...map,
      } satisfies CachedMapFile),
    );
  } catch (error) {
    console.warn(
      `[iRacing Map] Could not cache track ${ordinal}:`,
      error,
    );
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
  const mapUrl = track?.mapUrl ?? "";
  if (!mapUrl.startsWith(PUBLIC_MAP_PREFIX)) return null;

  const cached = readCachedMap(ordinal, mapUrl);
  if (cached) return cached;

  const layerUrl = (name: string) =>
    new URL(name, mapUrl).href;
  const [activeSvg, startFinishSvg, turnsSvg] = await Promise.all([
    fetchSvg(mapUrl),
    fetchSvg(layerUrl("start-finish.svg")),
    fetchSvg(layerUrl("turns.svg")),
  ]);
  if (!activeSvg) return null;
  const map = parseIRacingActiveSvg(
    activeSvg,
    startFinishSvg,
    turnsSvg,
  );
  if (map) writeCachedMap(ordinal, mapUrl, map);
  return map;
}

/** Resolve and memoize one exact iRacing layout's official SVG map. */
export function getIRacingSvgTrackMap(
  ordinal: number,
): Promise<IRacingSvgTrackMap | null> {
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
