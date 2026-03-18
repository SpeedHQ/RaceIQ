import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface Point {
  x: number;
  z: number;
}

// Map FM track name -> outline points
const outlinesByName = new Map<string, Point[]>();
// Map track ordinal -> outline points
const outlinesByOrdinal = new Map<number, Point[]>();

// FM track name -> JSON filename mapping
const TRACK_FILES: Record<string, string> = {
  "Brand Hatch": "brands-hatch.json",
  "Circuit de Barcelona-Catalunya": "catalunya.json",
  "Circuit de Spa-Francorchamps": "spa.json",
  "Hockenheimring": "hockenheim.json",
  "Indianapolis Motor Speedway": "indianapolis.json",
  "Nürburgring": "nurburgring.json",
  "Silverstone Racing Circuit": "silverstone.json",
  "Suzuka Circuit": "suzuka.json",
  "Yas Marina Circuit": "yas-marina.json",
};

// Load all bundled outlines
for (const [trackName, filename] of Object.entries(TRACK_FILES)) {
  const filePath = resolve(__dirname, filename);
  if (existsSync(filePath)) {
    try {
      const data = JSON.parse(readFileSync(filePath, "utf-8")) as Point[];
      outlinesByName.set(trackName, data);
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

    // Check if this track name has a bundled outline
    const outline = outlinesByName.get(name);
    if (outline) {
      outlinesByOrdinal.set(ordinal, outline);
    }
  }
}

console.log(
  `[Tracks] Loaded ${outlinesByName.size} bundled track outlines, mapped to ${outlinesByOrdinal.size} ordinals`
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
