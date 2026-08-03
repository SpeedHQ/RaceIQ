import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { GAMES_DIR, SHARED_DIR } from "@shared/platform/runtime/data-paths";
import { filterOutlierPoints } from "./points";
import type { Point, TrackBoundary, TrackSource } from "./types";
import { ttlCache } from "../storage/cache";
import { listDataFiles, readDataFile } from "../storage/files";

const tumftmDir = resolve(SHARED_DIR, "tracks", "tumftm");

interface TrackOutlineEntry {
  filename: string;
  source: TrackSource;
}

// Map FM track name -> outline points
// Map track ordinal -> outline points
// Source attribution per track name
const sourceByName = new Map<string, TrackSource>();

// FM track name -> JSON filename + source mapping
// Sources:
//   tumftm  = TUMFTM/racetrack-database (OpenStreetMap-derived, academic)
//   osm     = OpenStreetMap Overpass API (direct query)
//   recorded = Captured from in-game telemetry
const TRACK_FILES: Record<string, TrackOutlineEntry> = {
  // TUMFTM racetrack-database (high quality, ~1000 pts with track widths)
  "Brand Hatch": { filename: "brands-hatch-centerline.csv", source: "tumftm" },
  "Circuit de Barcelona-Catalunya": { filename: "catalunya-centerline.csv", source: "tumftm" },
  "Circuit de Spa-Francorchamps": { filename: "spa-centerline.csv", source: "tumftm" },
  "Hockenheimring": { filename: "hockenheim-centerline.csv", source: "tumftm" },
  "Indianapolis Motor Speedway": { filename: "indianapolis-centerline.csv", source: "tumftm" },
  "Nürburgring": { filename: "nurburgring-centerline.csv", source: "tumftm" },
  "Silverstone Racing Circuit": { filename: "silverstone-centerline.csv", source: "tumftm" },
  "Suzuka Circuit": { filename: "suzuka-centerline.csv", source: "tumftm" },
  "Yas Marina Circuit": { filename: "yas-marina-centerline.csv", source: "tumftm" },
  "Autodromo Hermanos Rodriguez": { filename: "mexico-city-centerline.csv", source: "tumftm" },

  // OpenStreetMap Overpass API — removed due to low quality (too few points, GPS artifacts)
  // These tracks will get outlines once recorded from in-game telemetry.
  // Tracks: Laguna Seca, Road Atlanta, Daytona, Lime Rock, Mugello, Road America, Virginia
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

// ── Lazy index: scanned on first access, not at startup ─────────────────────

let _indexBuilt = false;
const availableOutlineNames = new Set<string>();
const availableBoundaryNames = new Set<string>();

function ensureIndex() {
  if (_indexBuilt) return;
  _indexBuilt = true;

  // Check which bundled outlines exist on disk
  for (const [trackName, entry] of Object.entries(TRACK_FILES)) {
    const filePath = resolve(tumftmDir, entry.filename);
    if (existsSync(filePath)) {
      availableOutlineNames.add(trackName);
      sourceByName.set(trackName, entry.source);
    }
  }

  // Check which boundary files exist
  const allBoundaryFiles = [
    ...listDataFiles(tumftmDir, (f) => f.endsWith("-boundaries.json")),
  ];
  for (const filePath of allBoundaryFiles) {
    const baseName = filePath.split("/").pop()!.replace("-boundaries.json", "");
    for (const [trackName, entry] of Object.entries(TRACK_FILES)) {
      if (entry.filename.replace("-centerline.csv", "") === baseName) {
        availableBoundaryNames.add(trackName);
        break;
      }
    }
  }
}

// Lazy caches with TTL eviction
const outlineCache = ttlCache<Point[]>();
const boundaryCache = ttlCache<TrackBoundary>();

/** Project GPS (lon, lat) to local meters using equirectangular approximation. */
function projectGpsToMeters(pts: Point[]): Point[] {
  if (pts.length === 0) return pts;
  // Use centroid as reference point
  let refLat = 0, refLon = 0;
  for (const p of pts) { refLon += p.x; refLat += p.z; }
  refLon /= pts.length; refLat /= pts.length;
  const latRad = refLat * Math.PI / 180;
  const mPerDegLat = 111320;
  const mPerDegLon = 111320 * Math.cos(latRad);
  return pts.map(p => ({
    x: (p.x - refLon) * mPerDegLon,
    z: (p.z - refLat) * mPerDegLat,
  }));
}

/** Detect if coordinates are GPS (values in typical lon/lat range). */
function isGpsCoords(pts: Point[]): boolean {
  if (pts.length === 0) return false;
  // GPS: x (lon) typically -180..180, z (lat) typically -90..90
  // Meter coords: typically -10000..10000
  const sample = pts.slice(0, 5);
  return sample.every(p => Math.abs(p.x) < 200 && Math.abs(p.z) < 100);
}

/** Interpolate between points to achieve a target point count using cubic Catmull-Rom. */
function interpolateOutline(pts: Point[], targetCount: number): Point[] {
  if (pts.length >= targetCount) return pts;
  const n = pts.length;
  const result: Point[] = [];
  const totalSegments = targetCount - 1;

  for (let i = 0; i <= totalSegments; i++) {
    const t = (i / totalSegments) * n;
    const idx = Math.floor(t);
    const frac = t - idx;

    const p0 = pts[(idx - 1 + n) % n];
    const p1 = pts[idx % n];
    const p2 = pts[(idx + 1) % n];
    const p3 = pts[(idx + 2) % n];

    // Catmull-Rom spline
    const t2 = frac * frac;
    const t3 = t2 * frac;
    result.push({
      x: 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * frac + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
      z: 0.5 * ((2 * p1.z) + (-p0.z + p2.z) * frac + (2 * p0.z - 5 * p1.z + 4 * p2.z - p3.z) * t2 + (-p0.z + 3 * p1.z - 3 * p2.z + p3.z) * t3),
    });
  }
  return result;
}

function loadOutlineByName(trackName: string): Point[] | null {
  if (outlineCache.has(trackName)) return outlineCache.get(trackName)!;
  const entry = TRACK_FILES[trackName as keyof typeof TRACK_FILES];
  if (!entry) return null;
  const content = readDataFile(resolve(tumftmDir, entry.filename));
  if (!content) return null;
  try {
    const lines = content.split("\n").filter(Boolean);
    let data: Point[] = lines.slice(1).map((l) => {
      const [x, z] = l.split(",").map(Number);
      return { x, z };
    });

    // OSM data is in GPS (lon, lat) — project to meters
    if (isGpsCoords(data)) {
      data = projectGpsToMeters(data);
    }

    // TUMFTM/OSM outlines trace circuits opposite to racing direction — reverse them
    if (entry.source === "tumftm" || entry.source === "osm") {
      data = [data[0], ...data.slice(1).reverse()];
    }

    // Interpolate sparse outlines (OSM typically has <200 pts) to smooth them
    if (data.length < 500) {
      data = interpolateOutline(data, 500);
    }

    data = filterOutlierPoints(data);
    outlineCache.set(trackName, data);
    return data;
  } catch { return null; }
}

export function loadBoundaryByName(trackName: string): TrackBoundary | null {
  if (boundaryCache.has(trackName)) return boundaryCache.get(trackName)!;
  const entry = TRACK_FILES[trackName as keyof typeof TRACK_FILES];
  if (!entry) return null;
  const baseName = entry.filename.replace("-centerline.csv", "");
  const sharedPath = resolve(tumftmDir, `${baseName}-boundaries.json`);
  const content = readDataFile(sharedPath);
  if (!content) return null;
  try {
    const data = JSON.parse(content);
    if (data.leftEdge && data.rightEdge) {
      // TUMFTM/OSM boundaries also need reversing to match racing direction
      if (entry.source === "tumftm" || entry.source === "osm") {
        data.leftEdge = [data.leftEdge[0], ...data.leftEdge.slice(1).reverse()];
        data.rightEdge = [data.rightEdge[0], ...data.rightEdge.slice(1).reverse()];
        if (data.centerLine) data.centerLine = [data.centerLine[0], ...data.centerLine.slice(1).reverse()];
        if (data.pitLane) data.pitLane = [data.pitLane[0], ...data.pitLane.slice(1).reverse()];
      }
      boundaryCache.set(trackName, data);
      return data;
    }
    return null;
  } catch { return null; }
}

// Tracks where the TUMFTM outline only matches a specific layout variant.
// Maps track name -> set of ordinals that should NOT get the bundled outline/boundary
// TUMFTM outlines correspond to specific track layouts (usually the GP/full circuit).
// Map: circuit name → approximate outline length in km. Only variants with similar
// length (within 30%) get the outline — prevents showing a GP outline for the Nordschleife.
const OUTLINE_LENGTH_KM: Record<string, number> = {
  "Nürburgring": 5.15,           // GP Circuit
  "Silverstone Racing Circuit": 5.89, // Grand Prix Circuit
  "Circuit de Barcelona-Catalunya": 4.66, // Grand Prix Circuit
  "Hockenheimring": 4.57,        // Grand Prix
  "Indianapolis Motor Speedway": 3.93, // Road Course
  "Brand Hatch": 3.70,           // GP Circuit
  "Suzuka Circuit": 5.81,        // Full Circuit (East Circuit is 2.25 km)
};

// Ordinal mapping — built lazily alongside the index
const tracksPath = resolve(GAMES_DIR, "fm-2023", "tracks.csv");
const ordinalToTrackName = new Map<number, string>();
const ordinalToSharedOutline = new Map<number, string>();
const outlineOrdinals = new Set<number>();
const boundaryOrdinals = new Set<number>();

let _ordinalsBuilt = false;
function ensureOrdinals() {
  if (_ordinalsBuilt) return;
  _ordinalsBuilt = true;
  ensureIndex();
  const raw = readDataFile(tracksPath);
  for (const line of (raw ?? "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(",");
    const ordinal = parseInt(parts[0], 10);
    const name = parts[1];
    const lengthKm = parseFloat(parts[5]);
    if (isNaN(ordinal) || !name) continue;

    ordinalToTrackName.set(ordinal, name);
    const commonTrackName = parts[6]?.trim();
    if (commonTrackName) ordinalToSharedOutline.set(ordinal, commonTrackName);

    const outlineLen = OUTLINE_LENGTH_KM[name];
    const excluded = outlineLen != null && !isNaN(lengthKm) && lengthKm > 0
      && Math.abs(lengthKm - outlineLen) / outlineLen > 0.30;

    if (availableOutlineNames.has(name) && !excluded) {
      outlineOrdinals.add(ordinal);
    }
    if (availableBoundaryNames.has(name) && !excluded) {
      boundaryOrdinals.add(ordinal);
    }
  }
}

export function getTrackOutline(trackName: string): Point[] | null {
  ensureIndex();
  return loadOutlineByName(trackName);
}

/**
 * Get the bundled (external) outline by ordinal, ignoring recorded outlines.
 */
export function getBundledOutlineByOrdinal(ordinal: number): Point[] | null {
  ensureOrdinals();
  if (!outlineOrdinals.has(ordinal)) return null;
  const name = ordinalToTrackName.get(ordinal);
  if (!name) return null;
  return loadOutlineByName(name);
}
export function getTrackSource(trackName: string): TrackSource | null {
  ensureIndex();
  return sourceByName.get(trackName) ?? null;
}
/** Get the shared outline filename for a Forza track ordinal (e.g. "silverstone"). */
export function getForzaSharedOutline(ordinal: number): string | undefined {
  ensureOrdinals();
  return ordinalToSharedOutline.get(ordinal);
}

export function getTrackNameByOrdinal(ordinal: number): string | undefined {
  ensureOrdinals();
  return ordinalToTrackName.get(ordinal);
}

export function hasBundledOutlineByOrdinal(ordinal: number): boolean {
  ensureOrdinals();
  return outlineOrdinals.has(ordinal);
}

export function hasBundledBoundaryByOrdinal(ordinal: number): boolean {
  ensureOrdinals();
  return boundaryOrdinals.has(ordinal);
}
