/**
 * Build shared track metadata JSON from sectors.ts, named-segments.ts, and outline CSVs.
 * Merges all enrichment data into shared/track-outlines/shared/meta/{name}.json
 *
 * Run: bun scripts/build-shared-tracks.ts
 */

import { existsSync, readFileSync, writeFileSync, readdirSync } from "fs";
import { resolve, basename } from "path";

const SHARED_DIR = resolve(import.meta.dir, "../shared/track-outlines/shared");
const TRACKS_DIR = resolve(SHARED_DIR, "meta");

// Import sector data
import { TRACK_SECTORS, DEFAULT_SECTORS } from "../shared/track-sectors";
import { namedSegments } from "../shared/track-named-segments";

// Map of shared outline file names → display info
// We derive track names from the CSV filenames in shared/
const outlineFiles = readdirSync(SHARED_DIR).filter(f => f.endsWith(".csv"));

interface SharedTrackData {
  name: string;
  sectors?: { s1End: number; s2End: number };
  segments?: { type: string; name: string; direction?: string; startFrac: number; endFrac: number }[];
}

// Build mapping from known track names that match our shared files
const SHARED_TRACK_NAMES: Record<string, string[]> = {
  // shared file name → possible track names in sectors.ts / named-segments.ts
  "spa": ["Circuit de Spa-Francorchamps"],
  "silverstone": ["Silverstone Racing Circuit", "Silverstone Circuit"],
  "suzuka": ["Suzuka Circuit", "Suzuka International Racing Course"],
  "austin": ["Circuit of the Americas"],
  "melbourne": ["Melbourne Grand Prix Circuit"],
  "shanghai": ["Shanghai International Circuit"],
  "sakhir": ["Bahrain International Circuit"],
  "catalunya": ["Circuit de Barcelona-Catalunya"],
  "montreal": ["Circuit Gilles Villeneuve"],
  "budapest": ["Hungaroring"],
  "monza": ["Autodromo Nazionale Monza"],
  "yas-marina": ["Yas Marina Circuit"],
  "interlagos": ["Autodromo Jose Carlos Pace"],
  "spielberg": ["Red Bull Ring"],
  "zandvoort": ["Circuit Zandvoort"],
  "nurburgring": ["Nürburgring"],
  "mexico-city": ["Autodromo Hermanos Rodriguez"],
  "sochi": ["Sochi Autodrom"],
  "sepang": ["Sepang International Circuit"],
  "brands-hatch": ["Brand Hatch"],
  "indianapolis": ["Indianapolis Motor Speedway"],
  "hockenheim": ["Hockenheimring"],
};

let created = 0;

for (const csvFile of outlineFiles) {
  const trackKey = basename(csvFile, ".csv");
  const possibleNames = SHARED_TRACK_NAMES[trackKey] ?? [];
  const displayName = possibleNames[0] ?? trackKey;

  // Find sectors
  let sectors: { s1End: number; s2End: number } | undefined;
  for (const name of possibleNames) {
    if (TRACK_SECTORS[name]) {
      sectors = TRACK_SECTORS[name];
      break;
    }
  }

  // Find segments
  let segments: typeof namedSegments[string] | undefined;
  for (const name of possibleNames) {
    if (namedSegments[name]) {
      segments = namedSegments[name];
      break;
    }
  }

  const data: SharedTrackData = { name: displayName };
  if (sectors) data.sectors = sectors;
  if (segments) data.segments = segments;

  const outPath = resolve(TRACKS_DIR, `${trackKey}.json`);
  writeFileSync(outPath, JSON.stringify(data, null, 2));
  console.log(`[${trackKey}] → ${displayName}${sectors ? " +sectors" : ""}${segments ? " +segments" : ""}`);
  created++;
}

console.log(`\nCreated ${created} shared track files in ${TRACKS_DIR}`);
