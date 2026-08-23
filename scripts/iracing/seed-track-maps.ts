import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  IRACING_MAP_CACHE_VERSION,
  orientIRacingOvalMap,
} from "../../server/games/iracing/track-map";
import {
  parseIRacingActiveSvg,
  type IRacingSvgTrackMap,
} from "../../server/games/iracing/track-map-svg";
import {
  getAllIRacingTracks,
  getIRacingOvalDirection,
  type IRacingCatalogTrack,
} from "../../shared/racing/tracks/catalogs/iracing";

const DEFAULT_OUTPUT = resolve(import.meta.dir, "../../shared/games/iracing/track-maps");
const PUBLIC_MAP_PREFIX = "https://members-assets.iracing.com/public/track-maps/";
const DOWNLOAD_CONCURRENCY = 8;
const FETCH_TIMEOUT_MS = 15_000;

interface CachedMapFile extends IRacingSvgTrackMap {
  version: typeof IRACING_MAP_CACHE_VERSION;
  mapUrl: string;
}

function optionValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function readCompleteCache(path: string, track: IRacingCatalogTrack): CachedMapFile | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as CachedMapFile;
    return parsed.version === IRACING_MAP_CACHE_VERSION &&
      parsed.mapUrl === track.mapUrl &&
      Array.isArray(parsed.points) &&
      parsed.points.length >= 20 &&
      Array.isArray(parsed.labels) &&
      Array.isArray(parsed.pitLines)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

async function fetchSvg(url: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": "RaceIQ iRacing track map vendor" },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }
    return response.text();
  } finally {
    clearTimeout(timeout);
  }
}

async function downloadMap(track: IRacingCatalogTrack): Promise<CachedMapFile> {
  if (!track.mapUrl.startsWith(PUBLIC_MAP_PREFIX)) {
    throw new Error(`Unsupported map URL ${track.mapUrl}`);
  }
  const layerUrl = (name: string) => new URL(name, track.mapUrl).href;
  const [activeSvg, startFinishSvg, turnsSvg, pitRoadSvg] = await Promise.all([
    fetchSvg(track.mapUrl),
    fetchSvg(track.startFinishMapUrl || layerUrl("start-finish.svg")),
    fetchSvg(track.turnsMapUrl || layerUrl("turns.svg")),
    track.pitMapUrl ? fetchSvg(track.pitMapUrl) : null,
  ]);
  const parsed = parseIRacingActiveSvg(activeSvg, startFinishSvg, turnsSvg, pitRoadSvg);
  if (!parsed) throw new Error("Could not reconstruct centerline from active.svg");
  const ovalDirection = getIRacingOvalDirection(track.ordinal);
  const map = ovalDirection ? orientIRacingOvalMap(parsed, ovalDirection) : parsed;
  return {
    version: IRACING_MAP_CACHE_VERSION,
    mapUrl: track.mapUrl,
    points: map.points,
    labels: map.labels,
    pitLines: map.pitLines,
  };
}

const outputDir = resolve(optionValue("--output") ?? DEFAULT_OUTPUT);
const sourceCacheDir = optionValue("--source-cache");
const reuseMaps = process.argv.includes("--reuse-maps");
const tracks = getAllIRacingTracks();
mkdirSync(outputDir, { recursive: true });

let nextIndex = 0;
let downloaded = 0;
let reused = 0;
const failures: string[] = [];

async function worker(): Promise<void> {
  while (nextIndex < tracks.length) {
    const track = tracks[nextIndex++];
    const outputPath = resolve(outputDir, `${track.ordinal}.json`);
    const sourcePath = sourceCacheDir
      ? resolve(sourceCacheDir, `${track.ordinal}.json`)
      : null;
    const cached =
      (sourcePath ? readCompleteCache(sourcePath, track) : null) ??
      (reuseMaps ? readCompleteCache(outputPath, track) : null);
    try {
      const map = cached ?? await downloadMap(track);
      writeFileSync(outputPath, JSON.stringify(map), "utf8");
      if (cached) {
        reused += 1;
      } else {
        downloaded += 1;
      }
    } catch (error) {
      const name = track.variant ? `${track.name} - ${track.variant}` : track.name;
      failures.push(`${track.ordinal} ${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

await Promise.all(
  Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, tracks.length) }, () => worker()),
);

console.log(`[iRacing Track Maps] Wrote ${downloaded + reused}/${tracks.length} maps to ${outputDir}`);
console.log(`[iRacing Track Maps] Downloaded ${downloaded}; reused ${reused}`);
if (failures.length > 0) {
  throw new Error(`Failed to seed ${failures.length} iRacing track maps:\n${failures.join("\n")}`);
}
