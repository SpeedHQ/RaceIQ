import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  getAllIRacingTracks,
  type IRacingCatalogTrack,
} from "../../shared/racing/tracks/catalogs/iracing";
import { canonicalTrackAssetPathComponents, trackConfigurationVenueId } from "../../shared/racing/tracks/configuration";
import { SHARED_DIR } from "../../server/runtime/config/paths";
import { loadTrackConfiguration } from "../../server/tracks/configuration";

const DEFAULT_OUTPUT = resolve(SHARED_DIR, "tracks");
const PUBLIC_MAP_PREFIX = "https://members-assets.iracing.com/public/track-maps/";
const DOWNLOAD_CONCURRENCY = 8;
const FETCH_TIMEOUT_MS = 15_000;

type OfficialLayerName = "active.svg" | "start-finish.svg" | "turns.svg" | "pit-road.svg";

interface OfficialMapLayers {
  activeSvg: Uint8Array;
  startFinishSvg: Uint8Array;
  turnsSvg: Uint8Array;
  pitRoadSvg: Uint8Array;
}

function optionValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function fetchSvg(url: string): Promise<Uint8Array> {
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
    return new Uint8Array(await response.arrayBuffer());
  } finally {
    clearTimeout(timeout);
  }
}

async function downloadLayers(track: IRacingCatalogTrack): Promise<OfficialMapLayers> {
  if (!track.mapUrl.startsWith(PUBLIC_MAP_PREFIX)) {
    throw new Error(`Unsupported map URL ${track.mapUrl}`);
  }
  const layerUrl = (name: "start-finish.svg" | "turns.svg" | "pitroad.svg") => new URL(name, track.mapUrl).href;
  const [activeSvg, startFinishSvg, turnsSvg, pitRoadSvg] = await Promise.all([
    fetchSvg(track.mapUrl),
    fetchSvg(track.startFinishMapUrl || layerUrl("start-finish.svg")),
    fetchSvg(track.turnsMapUrl || layerUrl("turns.svg")),
    fetchSvg(track.pitMapUrl || layerUrl("pitroad.svg")),
  ]);
  return { activeSvg, startFinishSvg, turnsSvg, pitRoadSvg };
}

function hasCompleteLayers(directory: string): boolean {
  const required: OfficialLayerName[] = ["active.svg", "start-finish.svg", "turns.svg", "pit-road.svg"];
  return required.every((name) => {
    const path = resolve(directory, name);
    if (!existsSync(path)) return false;
    const bytes = readFileSync(path);
    return bytes.length > 0 && bytes.subarray(0, Math.min(bytes.length, 2048)).toString("utf8").includes("<svg");
  });
}

function writeLayers(directory: string, layers: OfficialMapLayers): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(resolve(directory, "active.svg"), layers.activeSvg);
  writeFileSync(resolve(directory, "start-finish.svg"), layers.startFinishSvg);
  writeFileSync(resolve(directory, "turns.svg"), layers.turnsSvg);
  writeFileSync(resolve(directory, "pit-road.svg"), layers.pitRoadSvg);
}

const outputRoot = resolve(optionValue("--output") ?? DEFAULT_OUTPUT);
const reuseMaps = process.argv.includes("--reuse-maps");
const tracks = getAllIRacingTracks();
const outputDirectories = new Map<number, string>();
const assignedDirectories = new Set<string>();

for (const track of tracks) {
  const configuration = loadTrackConfiguration("iracing", track.ordinal);
  if (!configuration) throw new Error(`Missing canonical iRacing configuration for ordinal ${track.ordinal}`);
  const outputDirectory = resolve(
    outputRoot,
    ...canonicalTrackAssetPathComponents(trackConfigurationVenueId(configuration), configuration.track.id),
    "geometry",
    "iracing",
    "official",
  );
  if (assignedDirectories.has(outputDirectory)) throw new Error(`Duplicate canonical iRacing map directory ${outputDirectory}`);
  outputDirectories.set(track.ordinal, outputDirectory);
  assignedDirectories.add(outputDirectory);
}

let nextIndex = 0;
let downloaded = 0;
let reused = 0;
const failures: string[] = [];

async function worker(): Promise<void> {
  while (nextIndex < tracks.length) {
    const track = tracks[nextIndex++];
    const outputDirectory = outputDirectories.get(track.ordinal)!;
    try {
      if (reuseMaps && hasCompleteLayers(outputDirectory)) {
        reused += 1;
        continue;
      }
      writeLayers(outputDirectory, await downloadLayers(track));
      downloaded += 1;
    } catch (error) {
      const name = track.variant ? `${track.name} - ${track.variant}` : track.name;
      failures.push(`${track.ordinal} ${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

await Promise.all(
  Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, tracks.length) }, () => worker()),
);

console.log(`[iRacing Track Maps] Wrote ${downloaded + reused}/${tracks.length} official layer sets under ${outputRoot}`);
console.log(`[iRacing Track Maps] Downloaded ${downloaded}; reused ${reused}`);
if (failures.length > 0) {
  throw new Error(`Failed to seed ${failures.length} iRacing track maps:\n${failures.join("\n")}`);
}
