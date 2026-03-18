import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { getTrackSectorsByName, DEFAULT_SECTORS, type TrackSectors } from "./sectors";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface Point {
  x: number;
  z: number;
}

type Source = "tumftm" | "osm" | "recorded";

interface TrackOutlineEntry {
  filename: string;
  source: Source;
}

// Map FM track name -> outline points
const outlinesByName = new Map<string, Point[]>();
// Map track ordinal -> outline points
const outlinesByOrdinal = new Map<number, Point[]>();
// Source attribution per track name
const sourceByName = new Map<string, Source>();

// FM track name -> JSON filename + source mapping
// Sources:
//   tumftm  = TUMFTM/racetrack-database (OpenStreetMap-derived, academic)
//   osm     = OpenStreetMap Overpass API (direct query)
//   recorded = Captured from in-game telemetry
const TRACK_FILES: Record<string, TrackOutlineEntry> = {
  // TUMFTM racetrack-database (9 tracks)
  "Brand Hatch": { filename: "brands-hatch.json", source: "tumftm" },
  "Circuit de Barcelona-Catalunya": { filename: "catalunya.json", source: "tumftm" },
  "Circuit de Spa-Francorchamps": { filename: "spa.json", source: "tumftm" },
  "Hockenheimring": { filename: "hockenheim.json", source: "tumftm" },
  "Indianapolis Motor Speedway": { filename: "indianapolis.json", source: "tumftm" },
  "Nürburgring": { filename: "nurburgring.json", source: "tumftm" },
  "Silverstone Racing Circuit": { filename: "silverstone.json", source: "tumftm" },
  "Suzuka Circuit": { filename: "suzuka.json", source: "tumftm" },
  "Yas Marina Circuit": { filename: "yas-marina.json", source: "tumftm" },

  // OpenStreetMap Overpass API (7 tracks)
  "WeatherTech Raceway Laguna Seca": { filename: "laguna-seca.json", source: "osm" },
  "Road Atlanta": { filename: "road-atlanta.json", source: "osm" },
  "Daytona Intl Speedway": { filename: "daytona.json", source: "osm" },
  "Lime Rock Park": { filename: "lime-rock.json", source: "osm" },
  "Mugello Circuit": { filename: "mugello.json", source: "osm" },
  "Road America": { filename: "road-america.json", source: "osm" },
  "Virginia International Raceway": { filename: "virginia.json", source: "osm" },
};

// Fictional FM tracks (no real-world data available):
// Fujimi Kaido, Grand Oak Raceway, Hakone, Maple Valley,
// Eaglerock Speedway, Sunset Peninsula Raceway

// Real tracks still missing outline data:
// Mount Panorama, Le Mans, Mid-Ohio, Sebring,
// Watkins Glen, Kyalami, Homestead-Miami

// Real tracks missing data (OSM rate-limited / no data):
// Mugello Circuit, Mount Panorama, Le Mans, Mid-Ohio,
// Sebring International, Watkins Glen, Kyalami, Road America,
// Virginia International Raceway, Homestead-Miami Speedway

// Load all bundled outlines
for (const [trackName, entry] of Object.entries(TRACK_FILES)) {
  const filePath = resolve(__dirname, entry.filename);
  if (existsSync(filePath)) {
    try {
      const data = JSON.parse(readFileSync(filePath, "utf-8")) as Point[];
      // Reverse outline to match racing direction (external data sources are typically opposite)
      data.reverse();
      outlinesByName.set(trackName, data);
      sourceByName.set(trackName, entry.source);
    } catch {}
  }
}

// Load track ordinal -> name mapping from tracks.csv
const tracksPath = resolve(__dirname, "..", "tracks.csv");
if (existsSync(tracksPath)) {
  const raw = readFileSync(tracksPath, "utf-8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [ordStr, name] = trimmed.split(",");
    const ordinal = parseInt(ordStr, 10);
    if (isNaN(ordinal)) continue;

    const outline = outlinesByName.get(name);
    if (outline) {
      outlinesByOrdinal.set(ordinal, outline);
    }
  }
}

console.log(
  `[Tracks] Loaded ${outlinesByName.size} bundled track outlines (${Array.from(sourceByName.values()).filter(s => s === "tumftm").length} TUMFTM, ${Array.from(sourceByName.values()).filter(s => s === "osm").length} OSM), mapped to ${outlinesByOrdinal.size} ordinals`
);

export function getTrackOutline(trackName: string): Point[] | null {
  return outlinesByName.get(trackName) ?? null;
}

export function getTrackOutlineByOrdinal(ordinal: number): Point[] | null {
  return outlinesByOrdinal.get(ordinal) ?? null;
}

export function hasTrackOutline(ordinal: number): boolean {
  return outlinesByOrdinal.has(ordinal);
}

export function getTrackSource(trackName: string): Source | null {
  return sourceByName.get(trackName) ?? null;
}

// Sector support
const ordinalToName = new Map<number, string>();
// Re-read tracks.csv to build ordinal -> name mapping for sectors
if (existsSync(tracksPath)) {
  const raw2 = readFileSync(tracksPath, "utf-8");
  for (const line of raw2.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [ordStr, name] = trimmed.split(",");
    const ordinal = parseInt(ordStr, 10);
    if (!isNaN(ordinal) && name) {
      ordinalToName.set(ordinal, name);
    }
  }
}

export type { TrackSectors };

export function getTrackSectors(trackName: string): TrackSectors {
  return getTrackSectorsByName(trackName);
}

export function getTrackSectorsByOrdinal(ordinal: number): TrackSectors {
  const name = ordinalToName.get(ordinal);
  if (!name) return DEFAULT_SECTORS;
  return getTrackSectorsByName(name);
}
