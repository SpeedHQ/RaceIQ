import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const DEFAULT_TRACKS_SOURCE =
  "https://raw.githubusercontent.com/jasondilworth56/iracingdataapi/main/tests/mock_return_data/get_tracks.json";
const DEFAULT_ASSETS_SOURCE =
  "https://raw.githubusercontent.com/jasondilworth56/iracingdataapi/main/tests/mock_return_data/get_tracks_assets.json";
const DEFAULT_OUTPUT = resolve(import.meta.dir, "../shared/games/iracing/tracks.csv");
const MILES_TO_KM = 1.609344;

/**
 * Only alias layouts that are the same physical configuration as an existing
 * RaceIQ shared outline. The remaining layouts still receive their official
 * iRacing SVG map, but are not treated as telemetry-ready centerlines.
 */
const COMMON_TRACK_NAMES = new Map<number, string>([
  [18, "road-america"],
  [26, "daytona"],
  [47, "laguna-seca"],
  [95, "sebring"],
  [126, "road-atlanta-s"],
  [127, "road-atlanta"],
  [145, "brands-hatch"],
  [146, "brands-hatch-indy"],
  [168, "suzuka"],
  [180, "oulton-park"],
  [192, "daytona"],
  [199, "zolder"],
  [212, "interlagos"],
  [218, "montreal"],
  [219, "mount-panorama"],
  [229, "austin"],
  [233, "donington"],
  [239, "monza"],
  [249, "nurburgring-nord"],
  [250, "nurburgring"],
  [252, "nordschleife"],
  [259, "nurburgring-s"],
  [266, "imola"],
  [268, "le-mans"],
  [269, "le-mans-old"],
  [297, "snetterton"],
  [341, "silverstone"],
  [342, "silverstone-s2"],
  [343, "silverstone-s"],
  [345, "catalunya"],
  [352, "lime-rock"],
  [390, "hockenheim"],
  [403, "spielberg"],
  [433, "watkins-glen-s"],
  [434, "watkins-glen"],
  [444, "fuji"],
  [448, "indianapolis"],
  [453, "indianapolis-oval"],
  [465, "vir"],
  [467, "vir-n"],
  [468, "vir-s"],
  [485, "zandvoort"],
  [498, "mugello"],
  [501, "misano"],
  [523, "spa"],
]);

interface IRacingDataApiTrack {
  track_id?: unknown;
  track_name?: unknown;
  config_name?: unknown;
  location?: unknown;
  track_config_length?: unknown;
  track_dirpath?: unknown;
  category?: unknown;
  retired?: unknown;
  has_svg_map?: unknown;
}

interface IRacingDataApiTrackAsset {
  track_id?: unknown;
  track_map?: unknown;
  track_map_layers?: {
    active?: unknown;
  };
}

interface SeedTrack {
  ordinal: number;
  name: string;
  location: string;
  country: string;
  variant: string;
  lengthKm: number;
  commonTrackName: string;
  category: string;
  path: string;
  mapUrl: string;
  retired: boolean;
}

function optionValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function csvCell(value: string | number): string {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

async function readSource(source: string): Promise<unknown> {
  if (/^https?:\/\//i.test(source)) {
    const response = await fetch(source, {
      headers: { "User-Agent": "RaceIQ iRacing track catalog seed" },
    });
    if (!response.ok) {
      throw new Error(
        `Could not download ${source}: ${response.status} ${response.statusText}`,
      );
    }
    return response.json();
  }

  const sourcePath = resolve(source);
  if (!existsSync(sourcePath)) {
    throw new Error(`Seed source does not exist: ${sourcePath}`);
  }
  return JSON.parse(readFileSync(sourcePath, "utf-8"));
}

function parseAssets(payload: unknown): Map<number, IRacingDataApiTrackAsset> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Expected an object from the iRacing /data/track/assets response");
  }

  const assets = new Map<number, IRacingDataApiTrackAsset>();
  for (const [key, value] of Object.entries(payload)) {
    const ordinal = Number(key);
    const asset = value as IRacingDataApiTrackAsset;
    if (!Number.isInteger(ordinal) || asset.track_id !== ordinal) {
      throw new Error(`Invalid /data/track/assets entry ${key}`);
    }
    assets.set(ordinal, asset);
  }
  return assets;
}

function parseTracks(
  payload: unknown,
  assets: Map<number, IRacingDataApiTrackAsset>,
  includeRetired: boolean,
): SeedTrack[] {
  if (!Array.isArray(payload)) {
    throw new Error("Expected an array from the iRacing /data/track/get response");
  }

  const tracks = payload.map((value, index): SeedTrack => {
    const row = value as IRacingDataApiTrack;
    if (
      !Number.isInteger(row.track_id) ||
      typeof row.track_name !== "string" ||
      !row.track_name.trim() ||
      (row.config_name != null && typeof row.config_name !== "string") ||
      typeof row.location !== "string" ||
      typeof row.track_config_length !== "number" ||
      !Number.isFinite(row.track_config_length) ||
      typeof row.track_dirpath !== "string" ||
      !row.track_dirpath.trim() ||
      typeof row.category !== "string" ||
      typeof row.retired !== "boolean" ||
      typeof row.has_svg_map !== "boolean"
    ) {
      throw new Error(
        `Invalid /data/track/get row at index ${index}: expected native track identity, layout, length, path, category, retired, and SVG fields`,
      );
    }

    const ordinal = row.track_id as number;
    const asset = assets.get(ordinal);
    const mapRoot =
      row.has_svg_map && typeof asset?.track_map === "string"
        ? asset.track_map
        : "";
    const activeLayer =
      typeof asset?.track_map_layers?.active === "string"
        ? asset.track_map_layers.active
        : "";
    const locationParts = row.location
      .trim()
      .split(",")
      .map((part) => part.trim());

    return {
      ordinal,
      name: row.track_name.trim(),
      location: locationParts.slice(0, -1).join(", "),
      country: locationParts.at(-1) ?? "",
      variant: typeof row.config_name === "string" ? row.config_name.trim() : "",
      lengthKm: Number(((row.track_config_length as number) * MILES_TO_KM).toFixed(3)),
      commonTrackName: COMMON_TRACK_NAMES.get(ordinal) ?? "",
      category: row.category.trim(),
      path: `tracks\\${row.track_dirpath.replaceAll("/", "\\")}`,
      mapUrl: mapRoot && activeLayer ? new URL(activeLayer, mapRoot).href : "",
      retired: row.retired,
    };
  });

  const filtered = includeRetired
    ? tracks
    : tracks.filter((track) => !track.retired);
  const ids = new Set<number>();
  const paths = new Set<string>();
  for (const track of filtered) {
    const normalizedPath = track.path.toLocaleLowerCase();
    if (ids.has(track.ordinal)) {
      throw new Error(`Duplicate iRacing track ID ${track.ordinal}`);
    }
    if (paths.has(normalizedPath)) {
      throw new Error(`Duplicate iRacing track path ${track.path}`);
    }
    ids.add(track.ordinal);
    paths.add(normalizedPath);
  }

  return filtered.sort((a, b) => a.ordinal - b.ordinal);
}

function writeCatalog(output: string, tracks: SeedTrack[]): void {
  const lines = [
    "ordinal,name,location,country,variant,lengthKm,commonTrackName,category,path,mapUrl",
    ...tracks.map((track) =>
      [
        track.ordinal,
        track.name,
        track.location,
        track.country,
        track.variant,
        track.lengthKm,
        track.commonTrackName,
        track.category,
        track.path,
        track.mapUrl,
      ]
        .map(csvCell)
        .join(","),
    ),
  ];
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${lines.join("\n")}\n`, "utf-8");
}

const tracksSource =
  optionValue("--tracks-source") ??
  optionValue("--source") ??
  DEFAULT_TRACKS_SOURCE;
const assetsSource =
  optionValue("--assets-source") ??
  DEFAULT_ASSETS_SOURCE;
const output = resolve(optionValue("--output") ?? DEFAULT_OUTPUT);
const includeRetired = process.argv.includes("--include-retired");
const [tracksPayload, assetsPayload] = await Promise.all([
  readSource(tracksSource),
  readSource(assetsSource),
]);
const tracks = parseTracks(
  tracksPayload,
  parseAssets(assetsPayload),
  includeRetired,
);
writeCatalog(output, tracks);

console.log(
  `[iRacing Tracks] Seeded ${tracks.length} ${includeRetired ? "total" : "non-retired"} layouts to ${output}`,
);
console.log(`[iRacing Tracks] Tracks source: ${tracksSource}`);
console.log(`[iRacing Tracks] Assets source: ${assetsSource}`);
