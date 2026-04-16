import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve } from "path";
import { getTrackSectorsByName, DEFAULT_SECTORS, type TrackSectors } from "./track-sectors";
import type { NamedSegment } from "./track-named-segments";
import { GameIdSchema } from "./types";
import { getF1TrackInfo } from "./f1-track-data";

import { SHARED_DIR, USER_TRACKS_DIR } from "./resolve-data";

/** Writable user track data (extracted, recorded, curbs). */
const userDir = USER_TRACKS_DIR;

/** FM 2023 ordinal → bundled file prefix, built lazily from tracks.csv. */
let _fmNamesBuilt = false;
const fmOrdinalToFileName = new Map<number, string>();
function ensureFmNames() {
  if (_fmNamesBuilt) return;
  _fmNamesBuilt = true;
  const raw = readDataFile(resolve(SHARED_DIR, "games", "fm-2023", "tracks.csv"));
  for (const line of (raw ?? "").split("\n")) {
    const parts = line.trim().split(",");
    const ordinal = parseInt(parts[0], 10);
    if (isNaN(ordinal)) continue;
    const shared = parts[6]?.trim();
    fmOrdinalToFileName.set(ordinal, shared ? `${shared}-${ordinal}` : `${ordinal}`);
  }
}

/** ACC 2019 variant ordinals map to the same layout as the base ordinal. */
const ACC_2019_VARIANT: Record<number, number> = {
  11: 0, 12: 1, 13: 2, 14: 3, 15: 4, 16: 5, 17: 6, 18: 7, 19: 8, 20: 9, 21: 10,
};

/** ACC ordinal → bundled file name, built lazily from tracks.csv. */
let _accNamesBuilt = false;
const accOrdinalToFileName = new Map<number, string>();
function ensureAccNames() {
  if (_accNamesBuilt) return;
  _accNamesBuilt = true;
  const raw = readDataFile(resolve(SHARED_DIR, "games", "acc", "tracks.csv"));
  for (const line of (raw ?? "").split("\n")) {
    const parts = line.trim().split(",");
    const ordinal = parseInt(parts[0], 10);
    if (isNaN(ordinal)) continue;
    const commonName = parts[3]?.trim();
    if (commonName) {
      accOrdinalToFileName.set(ordinal, commonName);
    }
  }
  // 2019 variants share the same layout as their base track
  for (const [variant, base] of Object.entries(ACC_2019_VARIANT)) {
    const baseName = accOrdinalToFileName.get(base);
    if (baseName) accOrdinalToFileName.set(Number(variant), baseName);
  }
}

/** Resolve ordinal to bundled file prefix (e.g. f1: 5 → "monaco", fm: 21 → "silverstone-21"). */
function getBundledTrackName(gameId: string, ordinal: number): string | undefined {
  if (gameId === "f1-2025") return getF1TrackInfo(ordinal)?.commonTrackName || undefined;
  if (gameId === "fm-2023") {
    ensureFmNames();
    return fmOrdinalToFileName.get(ordinal);
  }
  if (gameId === "acc") {
    ensureAccNames();
    return accOrdinalToFileName.get(ordinal);
  }
  return undefined;
}

/** Compute filename for telemetry-averaged centerline (e.g. "silverstone-21-computed-average"). */
function computedAverageFileName(gameId: string, ordinal: number): string {
  const name = getBundledTrackName(gameId, ordinal);
  return name ? `${name}-computed-average` : `${ordinal}-computed-average`;
}

/** Resolve a bundled file path: strip extracted/ prefix, map ordinal to track name. */
function toBundledPath(gameId: string, relativePath: string): string | null {
  let p = relativePath.startsWith("extracted/")
    ? relativePath.slice("extracted/".length)
    : relativePath;
  // Bundled files use track names, not ordinals: boundaries-5.json → monaco-boundaries.json
  const m = p.match(/^(\w+)-(\d+)\.(json|csv)$/);
  if (m) {
    const [, prefix, ordinal, ext] = m;
    const name = getBundledTrackName(gameId, parseInt(ordinal, 10));
    if (!name) return null;
    const kind = prefix === "recorded" ? "centerline" : prefix;
    return `${name}-${kind}.${ext}`;
  }
  return p;
}

/** Read a file from user game dir first, then fall back to bundled shared dir. */
function readUserOrBundled(gameId: string, relativePath: string): string | null {
  const userResult = readDataFile(resolve(userDir, gameId, relativePath));
  if (userResult !== null) return userResult;
  const bundledPath = toBundledPath(gameId, relativePath);
  if (!bundledPath) return null;
  return readDataFile(resolve(bundledGameDir(gameId), bundledPath));
}

/** Validate gameId using zod schema. */
function validateGameId(gameId: string): string {
  return GameIdSchema.parse(gameId);
}

/** Resolve writable game-specific user data directory, creating if needed. */
function userGameDir(gameId: string): string {
  const dir = resolve(userDir, gameId);
  if (!existsSync(dir)) {
    try { mkdirSync(dir, { recursive: true }); } catch {}
  }
  return dir;
}


/** Bundled extracted track data per game (boundaries, centerlines). */
function bundledGameDir(gameId: string): string {
  return resolve(SHARED_DIR, "tracks", gameId);
}

/** TUMFTM real-world track data (centerlines, boundaries). */
const tumftmDir = resolve(SHARED_DIR, "tracks", "tumftm");
/** Shared track metadata (sectors, segments — cross-game). */
const sharedTracksDir = resolve(SHARED_DIR, "tracks", "meta");

interface SharedTrackMeta {
  name: string;
  sectors?: TrackSectors;
  segments?: NamedSegment[];
  games?: Record<string, { sectors?: TrackSectors; segments?: NamedSegment[] }>;
}

const sharedTrackMetaCache = new Map<string, SharedTrackMeta | null>();

/** Load shared track metadata (sectors, segments) by shared track name. */
export function loadSharedTrackMeta(name: string): SharedTrackMeta | null {
  if (!name) return null;
  if (sharedTrackMetaCache.has(name)) return sharedTrackMetaCache.get(name)!;
  const filePath = resolve(sharedTracksDir, `${name}.json`);
  const content = readDataFile(filePath);
  if (!content) { sharedTrackMetaCache.set(name, null); return null; }
  try {
    const data = JSON.parse(content);
    sharedTrackMetaCache.set(name, data);
    return data;
  } catch {
    sharedTrackMetaCache.set(name, null);
    return null;
  }
}

/** Load a shared outline CSV by name (e.g. "silverstone"). */
const sharedOutlineCache = new Map<string, Point[] | null>();
export function loadSharedOutline(name: string): Point[] | null {
  if (!name) return null;
  const cached = sharedOutlineCache.get(name);
  if (cached !== undefined) return cached;
  const filePath = resolve(tumftmDir, `${name}.csv`);
  const content = readDataFile(filePath);
  if (!content) { sharedOutlineCache.set(name, null); return null; }
  try {
    const lines = content.split("\n").filter(Boolean);
    const data: Point[] = lines.slice(1).map((l) => {
      const [x, z] = l.split(",").map(Number);
      return { x, z };
    });
    const result = data.length > 10 ? data : null;
    sharedOutlineCache.set(name, result);
    return result;
  } catch { sharedOutlineCache.set(name, null); return null; }
}

/** Load shared boundary JSON by name (e.g. "silverstone"). */
type SharedBoundaryData = { leftEdge: Point[]; rightEdge: Point[]; centerLine: Point[]; pitLane: Point[] | null; coordSystem: string };
const sharedBoundaryCache = new Map<string, SharedBoundaryData | null>();
export function loadSharedBoundary(name: string): SharedBoundaryData | null {
  if (!name) return null;
  const cached = sharedBoundaryCache.get(name);
  if (cached !== undefined) return cached;
  const filePath = resolve(tumftmDir, `${name}.json`);
  const content = readDataFile(filePath);
  if (!content) { sharedBoundaryCache.set(name, null); return null; }
  try {
    const data = JSON.parse(content);
    sharedBoundaryCache.set(name, data);
    return data;
  } catch { sharedBoundaryCache.set(name, null); return null; }
}

/** Read a file, returning null on failure */
function readDataFile(filePath: string): string | null {
  try {
    return readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

/** List files matching a filter in a directory */
function listDataFiles(dir: string, filter: (name: string) => boolean): string[] {
  try {
    const { readdirSync } = require("fs");
    return (readdirSync(dir) as string[]).filter(filter).map((f: string) => resolve(dir, f));
  } catch {
    return [];
  }
}

interface Point {
  x: number;
  z: number;
}

export interface TrackBoundary {
  leftEdge: Point[];
  rightEdge: Point[];
  pitLane: Point[] | null;
}

type Source = "tumftm" | "osm" | "recorded";

interface TrackOutlineEntry {
  filename: string;
  source: Source;
}

// Map FM track name -> outline points
// Map track ordinal -> outline points
// Source attribution per track name
const sourceByName = new Map<string, Source>();

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

// ── TTL cache: evicts entries after CACHE_TTL_MS of inactivity ──────────────
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface CacheEntry<T> { data: T; timer: ReturnType<typeof setTimeout>; }

function ttlCache<T>() {
  const map = new Map<string, CacheEntry<T>>();
  return {
    get(key: string): T | undefined {
      const entry = map.get(key);
      if (!entry) return undefined;
      clearTimeout(entry.timer);
      entry.timer = setTimeout(() => map.delete(key), CACHE_TTL_MS);
      return entry.data;
    },
    set(key: string, data: T) {
      const existing = map.get(key);
      if (existing) clearTimeout(existing.timer);
      map.set(key, { data, timer: setTimeout(() => map.delete(key), CACHE_TTL_MS) });
    },
    has(key: string) { return map.has(key); },
    delete(key: string) { const e = map.get(key); if (e) clearTimeout(e.timer); map.delete(key); },
  };
}

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

function loadBoundaryByName(trackName: string): TrackBoundary | null {
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
const tracksPath = resolve(SHARED_DIR, "games", "fm-2023", "tracks.csv");
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

// Recorded outlines from in-game telemetry — keyed by "gameId:ordinal"
const recordedOutlines = ttlCache<Point[]>();
const recordedLapCounts = new Map<string, number>();
const recordedOrdinals = new Set<string>();

function gk(gameId: string, ordinal: number): string { return `${gameId}:${ordinal}`; }

let _recordedScanned = false;
// Scan which recorded files exist across user data + bundled dirs
export function scanRecordedFiles(): void {
  _recordedScanned = true;
  recordedOrdinals.clear();
  for (const gid of ["fm-2023", "f1-2025", "acc"]) {
    const dir = resolve(userDir, gid);
    if (!existsSync(dir)) continue;
    for (const filePath of listDataFiles(dir, (f) => f.endsWith("-computed-average.csv"))) {
      const m = filePath.split("/").pop()!.match(/-(\d+)-computed-average\.csv$/);
      if (m) recordedOrdinals.add(gk(gid, parseInt(m[1], 10)));
    }
  }
}
function ensureRecordedScanned() { if (!_recordedScanned) scanRecordedFiles(); }

/** Check if a game-extracted centerline exists (user-extracted or bundled). */
function hasExtractedOutline(ordinal: number, gameId: string): boolean {
  const name = getBundledTrackName(gameId, ordinal);
  if (name && existsSync(resolve(bundledGameDir(gameId), `${name}-centerline.csv`))) return true;
  return false;
}

function loadRecordedOutline(ordinal: number, gameId: string): Point[] | null {
  ensureRecordedScanned();
  const key = gk(gameId, ordinal);
  if (recordedOutlines.has(key)) return recordedOutlines.get(key)!;
  if (!recordedOrdinals.has(key)) return null;
  const caName = computedAverageFileName(gameId, ordinal);
  const userPath = resolve(userGameDir(gameId), `${caName}.csv`);
  const content = readDataFile(userPath);
  if (!content) return null;
  try {
    const lines = content.split("\n").filter(Boolean);
    const data: Point[] = lines.slice(1).map((l) => {
      const [x, z] = l.split(",").map(Number);
      return { x, z };
    });
    if (data.length > 10) {
      recordedOutlines.set(key, data);
      return data;
    }
    return null;
  } catch { return null; }
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

/**
 * Get track boundary edges (left/right) by ordinal. Returns null if no boundary data.
 */
export function getTrackBoundariesByOrdinal(ordinal: number, gameId: string): TrackBoundary | null {
  // Try extracted boundaries first (game-specific)
  const extracted = loadExtractedBoundary(ordinal, gameId);
  if (extracted) return extracted;

  // Shared boundaries are in real-world coordinates — only usable for Forza
  // which has calibration transforms. F1/ACC use their own coordinate spaces.
  if (gameId !== "fm-2023") return null;

  ensureOrdinals();
  if (!boundaryOrdinals.has(ordinal)) return null;
  const name = ordinalToTrackName.get(ordinal);
  if (!name) return null;
  return loadBoundaryByName(name);
}

/** Compute Procrustes transform (scale + rotation + translation) from src to tgt.
 *  Tries both normal and Z-flipped source, picks whichever has lower error. */
function computeAlignment(src: Point[], tgt: Point[]): { scale: number; cos: number; sin: number; tx: number; tz: number; flipZ: boolean; flipX: boolean } | null {
  if (src.length < 5 || tgt.length < 5) return null;
  const n = Math.min(100, Math.min(src.length, tgt.length));
  const sample = (pts: Point[]) => {
    const step = pts.length / n;
    return Array.from({ length: n }, (_, i) => pts[Math.floor(i * step)]);
  };
  void sample(tgt); // sampled at equal fractional distances below instead

  // Sample target at equal fractional distances
  function cumDist(pts: Point[]): number[] {
    const d = [0];
    for (let i = 1; i < pts.length; i++)
      d.push(d[i - 1] + Math.sqrt((pts[i].x - pts[i - 1].x) ** 2 + (pts[i].z - pts[i - 1].z) ** 2));
    return d;
  }
  function sampleAtFracs(pts: Point[], fracs: number[]): Point[] {
    const cd = cumDist(pts);
    const total = cd[cd.length - 1];
    return fracs.map(f => {
      const target = f * total;
      let lo = 0;
      for (let i = 1; i < cd.length; i++) { if (cd[i] >= target) { lo = i - 1; break; } }
      if (lo >= pts.length - 1) return pts[pts.length - 1];
      const seg = cd[lo + 1] - cd[lo];
      const t2 = seg > 0 ? (target - cd[lo]) / seg : 0;
      return { x: pts[lo].x + t2 * (pts[lo + 1].x - pts[lo].x), z: pts[lo].z + t2 * (pts[lo + 1].z - pts[lo].z) };
    });
  }

  const fracs = Array.from({ length: n }, (_, i) => i / n);
  const tSampled = sampleAtFracs(tgt, fracs);

  function procrustes(s: Point[], t2: Point[]) {
    const cs = { x: s.reduce((a, p) => a + p.x, 0) / n, z: s.reduce((a, p) => a + p.z, 0) / n };
    const ct = { x: t2.reduce((a, p) => a + p.x, 0) / n, z: t2.reduce((a, p) => a + p.z, 0) / n };
    let num = 0, den = 0, sn2 = 0, tn2 = 0;
    for (let i = 0; i < n; i++) {
      const sx = s[i].x - cs.x, sz = s[i].z - cs.z;
      const tx = t2[i].x - ct.x, tz = t2[i].z - ct.z;
      num += sx * tz - sz * tx; den += sx * tx + sz * tz;
      sn2 += sx * sx + sz * sz; tn2 += tx * tx + tz * tz;
    }
    const rot = Math.atan2(num, den);
    const sc = sn2 > 0 ? Math.sqrt(tn2 / sn2) : 1;
    const co = Math.cos(rot), si = Math.sin(rot);
    const result = { scale: sc, cos: co, sin: si, tx: ct.x - sc * (co * cs.x - si * cs.z), tz: ct.z - sc * (si * cs.x + co * cs.z) };
    let err = 0;
    for (let i = 0; i < n; i++) {
      const ax = sc * (co * s[i].x - si * s[i].z) + result.tx;
      const az = sc * (si * s[i].x + co * s[i].z) + result.tz;
      err += (ax - t2[i].x) ** 2 + (az - t2[i].z) ** 2;
    }
    return { ...result, err };
  }

  // Try all flip combinations × multiple starting offsets along the track
  type Candidate = { scale: number; cos: number; sin: number; tx: number; tz: number; err: number; flipZ: boolean; flipX: boolean };
  let best: Candidate | null = null;
  const offsets = 1; // test every possible starting offset for best alignment

  for (const [flipX, flipZ] of [[false, false], [false, true], [true, false], [true, true]] as [boolean, boolean][]) {
    const flipped = src.map(p => ({ x: flipX ? -p.x : p.x, z: flipZ ? -p.z : p.z }));
    // Try multiple starting offsets
    for (let off = 0; off < n; off += offsets) {
      const shifted = fracs.map(f => (f + off / n) % 1);
      const sSampled = sampleAtFracs(flipped, shifted);
      const r = procrustes(sSampled, tSampled);
      if (!best || r.err < best.err) {
        best = { ...r, flipX, flipZ };
      }
    }
    // Also try reversed direction
    const revFlipped = [...flipped].reverse();
    for (let off = 0; off < n; off += offsets) {
      const shifted = fracs.map(f => (f + off / n) % 1);
      const sSampled = sampleAtFracs(revFlipped, shifted);
      const r = procrustes(sSampled, tSampled);
      if (!best || r.err < best.err) {
        best = { ...r, flipX, flipZ };
      }
    }
  }

  return best ? { scale: best.scale, cos: best.cos, sin: best.sin, tx: best.tx, tz: best.tz, flipZ: best.flipZ, flipX: best.flipX } : null;
}

function applyAlignment(p: Point, a: { scale: number; cos: number; sin: number; tx: number; tz: number; flipZ: boolean; flipX: boolean }): Point {
  const px = a.flipX ? -p.x : p.x;
  const pz = a.flipZ ? -p.z : p.z;
  return { x: a.scale * (a.cos * px - a.sin * pz) + a.tx, z: a.scale * (a.sin * px + a.cos * pz) + a.tz };
}

/** Load extracted boundary data, aligned to telemetry coordinate space if possible. */
function loadExtractedBoundary(ordinal: number, gameId: string): TrackBoundary | null {
  const userExtracted = resolve(userGameDir(gameId), "extracted", `boundaries-${ordinal}.json`);
  const trackName = getBundledTrackName(gameId, ordinal);
  const bundledFile = trackName ? resolve(bundledGameDir(gameId), `${trackName}-boundaries.json`) : null;
  const content = readDataFile(userExtracted) ?? (bundledFile ? readDataFile(bundledFile) : null);
  if (!content) return null;
  try {
    const data = JSON.parse(content);
    if (!data.leftEdge || !data.rightEdge || data.leftEdge.length < 10) return null;
    let left: Point[] = data.leftEdge;
    let right: Point[] = data.rightEdge;
    let pit: Point[] | null = data.pitLane ?? null;

    // If alignment was poor, transform boundaries to match telemetry outline.
    // ACC coordinates are pre-aligned (same space as telemetry), skip.
    if (!data.aligned && data.coordSystem !== "acc") {
      const extContent = readUserOrBundled(gameId, `extracted/recorded-${ordinal}.csv`);
      const caName = computedAverageFileName(gameId, ordinal);
      const telContent = readDataFile(resolve(userGameDir(gameId), `${caName}.csv`));
      if (extContent && telContent) {
        const parseCSV = (c: string) => c.split("\n").filter(Boolean).slice(1).map(l => { const [x, z] = l.split(",").map(Number); return { x, z }; });
        const extCenter = parseCSV(extContent);
        const telCenter = parseCSV(telContent);
        const align = computeAlignment(extCenter, telCenter);
        if (align) {
          left = left.map(p => applyAlignment(p, align));
          right = right.map(p => applyAlignment(p, align));
          if (pit) pit = pit.map(p => applyAlignment(p, align));
        }
      }
    }

    return { leftEdge: left, rightEdge: right, pitLane: pit };
  } catch { return null; }
}

/** Load extracted Track.seg segments (corners/straights with apex data). */
export function loadExtractedSegments(ordinal: number, gameId: string): { type: string; name: string; direction?: string | null; startFrac: number; endFrac: number; apexFrac?: number; peakCurvature?: number }[] | null {
  const content = readUserOrBundled(gameId, `extracted/segments-${ordinal}.json`);
  if (!content) return null;
  try {
    const data = JSON.parse(content);
    if (!data.segments || !Array.isArray(data.segments) || data.segments.length < 2) return null;
    let tNum = 1, sNum = 1;
    return data.segments.map((s: any) => ({
      type: s.type,
      name: s.type === "corner" ? `T${tNum++}` : `S${sNum++}`,
      direction: s.direction ?? null,
      startFrac: s.startFrac,
      endFrac: s.endFrac,
      apexFrac: s.apexFrac,
      peakCurvature: s.peakCurvature,
    }));
  } catch { return null; }
}

/** Load altitude (elevation) array for a track from extracted game data. */
export function getTrackAltitudeByOrdinal(ordinal: number): number[] | null {
  const content = readUserOrBundled("fm-2023", `extracted/boundaries-${ordinal}.json`);
  if (!content) return null;
  try {
    const data = JSON.parse(content);
    return data.altitude && data.altitude.length > 0 ? data.altitude : null;
  } catch { return null; }
}

// Store all lap traces for averaging — keyed by "gameId:ordinal"
const lapTraces = new Map<string, Point[][]>();
// Store start-line positions from lap boundaries for averaging
const startLinePositions = new Map<string, Point[]>();
// Store start-line yaw values for direction arrow
const startLineYaws = new Map<string, number[]>();

/**
 * Remove outlier points where the distance to the next point is abnormally large.
 * This catches pit lane teleports, rewind jumps, and other glitches.
 * Uses median spacing * 5 as the threshold — anything larger is a jump.
 */
function filterOutlierPoints(points: Point[]): Point[] {
  if (points.length < 10) return points;

  // Compute all consecutive distances
  const dists: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const dx = points[i].x - points[i - 1].x;
    const dz = points[i].z - points[i - 1].z;
    dists.push(Math.sqrt(dx * dx + dz * dz));
  }

  // Median distance
  const sorted = [...dists].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const threshold = Math.max(median * 5, 20); // at least 20m to avoid filtering tight corners

  // Keep points where the gap FROM the previous point is reasonable
  const filtered: Point[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    if (dists[i - 1] <= threshold) {
      filtered.push(points[i]);
    }
  }

  return filtered;
}

/**
 * Record a lap trace for a track.
 * - After 1 lap: use it immediately (so position tracking works right away)
 * - After 5 laps: average the traces for a smoother outline, save to disk
 * - After 10 laps: refine further with more data
 * - Every 10 laps after: re-refine
 *
 * startLinePos: the car's position when LapNumber incremented (start/finish crossing).
 * startYaw: the car's Yaw (radians) at lap start, used for direction arrow.
 * Both are averaged across valid laps.
 */
export function recordLapTrace(ordinal: number, trace: Point[], startLinePos: Point | null, startYaw: number | null, gameId: string): void {
  validateGameId(gameId);
  if (trace.length < 50) return;

  const key = gk(gameId, ordinal);
  const count = (recordedLapCounts.get(key) ?? 0) + 1;
  recordedLapCounts.set(key, count);

  // Accumulate start-line positions
  if (startLinePos) {
    if (!startLinePositions.has(key)) startLinePositions.set(key, []);
    const positions = startLinePositions.get(key)!;
    positions.push(startLinePos);
    if (positions.length > 10) positions.shift(); // keep last 10
  }

  // Accumulate start-line yaw values
  if (startYaw != null) {
    if (!startLineYaws.has(key)) startLineYaws.set(key, []);
    const yaws = startLineYaws.get(key)!;
    yaws.push(startYaw);
    if (yaws.length > 10) yaws.shift();
  }

  // If an extracted (game-file) outline already exists, don't overwrite it
  // with telemetry recordings — the game data is higher quality.
  if (hasExtractedOutline(ordinal, gameId)) return;

  // Filter outlier points from the trace (pit lane teleports, rewind jumps)
  trace = filterOutlierPoints(trace);
  if (trace.length < 50) return;

  // Store trace for averaging (keep last 10)
  if (!lapTraces.has(key)) lapTraces.set(key, []);
  const traces = lapTraces.get(key)!;
  traces.push(trace);
  if (traces.length > 10) traces.shift();

  // Downsample a single trace to ~500 points
  const downsample = (pts: Point[], target: number): Point[] => {
    if (pts.length <= target) return pts;
    const step = pts.length / target;
    const result: Point[] = [];
    for (let i = 0; i < target; i++) result.push(pts[Math.floor(i * step)]);
    return result;
  };

  let outline: Point[];
  const shouldSave = count === 1 || count === 5 || count === 10 || count % 10 === 0;

  if (traces.length >= 5) {
    // Average multiple traces: downsample each to 500 pts, then average x/z per index
    const target = 500;
    const sampled = traces.map((t) => downsample(t, target));
    outline = [];
    for (let i = 0; i < target; i++) {
      let sx = 0, sz = 0, n = 0;
      for (const s of sampled) {
        if (i < s.length) { sx += s[i].x; sz += s[i].z; n++; }
      }
      outline.push({ x: sx / n, z: sz / n });
    }
    console.log(`[Tracks] Averaged ${traces.length} laps for track ${ordinal} (lap ${count})`);
  } else {
    // Just use the latest trace
    outline = downsample(trace, 500);
  }

  // Rotate outline so the averaged start-line position becomes index 0
  const positions = startLinePositions.get(key);
  if (positions && positions.length > 0) {
    // Average all collected start-line positions
    let sx = 0, sz = 0;
    for (const p of positions) { sx += p.x; sz += p.z; }
    const avgStart = { x: sx / positions.length, z: sz / positions.length };

    // Find nearest outline point to averaged start position
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < outline.length; i++) {
      const dx = outline[i].x - avgStart.x;
      const dz = outline[i].z - avgStart.z;
      const d = dx * dx + dz * dz;
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }

    // Rotate array so bestIdx becomes index 0
    if (bestIdx > 0) {
      outline = [...outline.slice(bestIdx), ...outline.slice(0, bestIdx)];
      console.log(`[Tracks] Rotated outline for track ${ordinal}: start at point ${bestIdx} (avg of ${positions.length} lap starts)`);
    }
  }

  recordedOutlines.set(key, outline);

  if (shouldSave) {
    const caName = computedAverageFileName(gameId, ordinal);
    const filePath = resolve(userGameDir(gameId), `${caName}.csv`);
    try {
      writeFileSync(filePath, "x,z\n" + outline.map((p) => `${p.x},${p.z}`).join("\n"));
      console.log(`[Tracks] Saved ${caName} (${outline.length} pts, lap ${count})`);
    } catch (err) {
      console.error(`[Tracks] Failed to save recorded outline:`, err);
    }
  }
}

/** Load bundled game-extracted centerline CSV by ordinal. */
const bundledCenterlineCache = new Map<string, Point[] | null>();
function loadBundledCenterline(ordinal: number, gameId: string): Point[] | null {
  const key = gk(gameId, ordinal);
  const cached = bundledCenterlineCache.get(key);
  if (cached !== undefined) return cached;
  const name = getBundledTrackName(gameId, ordinal);
  if (!name) { bundledCenterlineCache.set(key, null); return null; }
  const filePath = resolve(bundledGameDir(gameId), `${name}-centerline.csv`);
  const content = readDataFile(filePath);
  if (!content) { bundledCenterlineCache.set(key, null); return null; }
  try {
    const lines = content.split("\n").filter(Boolean);
    const data: Point[] = lines.slice(1).map((l) => {
      const [x, z] = l.split(",").map(Number);
      return { x, z };
    });
    const result = data.length > 10 ? data : null;
    bundledCenterlineCache.set(key, result);
    return result;
  } catch { bundledCenterlineCache.set(key, null); return null; }
}

/**
 * Get centerline for a track. Priority: bundled game data → computed average → TUMFTM.
 * sharedName: optional shared outline file name (e.g. "silverstone") for cross-game tracks.
 */
export function getTrackOutlineByOrdinal(ordinal: number, gameId: string, sharedName?: string): Point[] | null {
  validateGameId(gameId);
  return loadBundledCenterline(ordinal, gameId) ?? loadRecordedOutline(ordinal, gameId) ?? loadSharedOutline(sharedName ?? "") ?? getBundledOutlineByOrdinal(ordinal);
}

export function hasRecordedOutline(ordinal: number, gameId: string): boolean {
  validateGameId(gameId);
  ensureRecordedScanned();
  const key = gk(gameId, ordinal);
  return recordedOrdinals.has(key) || recordedOutlines.has(key);
}

export function hasTrackOutline(ordinal: number, gameId: string): boolean {
  validateGameId(gameId);
  ensureOrdinals();
  return hasRecordedOutline(ordinal, gameId) || outlineOrdinals.has(ordinal);
}

export function getTrackSource(trackName: string): Source | null {
  ensureIndex();
  return sourceByName.get(trackName) ?? null;
}

/**
 * Get the averaged start-line Yaw (radians) for a track. Returns null if not yet recorded.
 */
export function getStartYaw(ordinal: number, gameId: string): number | null {
  validateGameId(gameId);
  const yaws = startLineYaws.get(gk(gameId, ordinal));
  if (!yaws || yaws.length === 0) return null;
  // Average yaw using circular mean (handles wrapping around ±π)
  let sinSum = 0, cosSum = 0;
  for (const y of yaws) { sinSum += Math.sin(y); cosSum += Math.cos(y); }
  return Math.atan2(sinSum / yaws.length, cosSum / yaws.length);
}

/**
 * Delete a computed-average outline for a track (resets to bundled or no outline).
 */
export function deleteRecordedOutline(ordinal: number, gameId: string): boolean {
  validateGameId(gameId);
  const key = gk(gameId, ordinal);
  const had = recordedOutlines.has(key);
  recordedOutlines.delete(key);
  recordedLapCounts.delete(key);
  lapTraces.delete(key);
  startLinePositions.delete(key);
  startLineYaws.delete(key);

  const { unlinkSync } = require("fs");
  const caName = computedAverageFileName(gameId, ordinal);
  const filePath = resolve(userGameDir(gameId), `${caName}.csv`);
  if (existsSync(filePath)) {
    try { unlinkSync(filePath); } catch {}
  }
  if (had) console.log(`[Tracks] Deleted computed average for track ${ordinal}`);
  return had;
}


// Sector support — reuses ordinalToTrackName from above

// ── Curb/Kerb Detection ─────────────────────────────────────────────────────
// Curbs are detected from WheelOnRumbleStrip telemetry fields. When any wheel
// is on a rumble strip, we record the car's position. Consecutive rumble-strip
// positions are grouped into segments. Multiple laps are merged to build a
// complete curb map for each track.

export interface CurbSegment {
  points: Point[];
  side: "left" | "right" | "both";
}

const curbsByOrdinal = new Map<string, CurbSegment[]>();
const curbLapCounts = new Map<string, number>();
const curbOrdinals = new Set<string>();

let _curbsScanned = false;
function scanCurbFiles(): void {
  _curbsScanned = true;
  curbOrdinals.clear();
  for (const gid of ["fm-2023", "f1-2025"]) {
    const dir = resolve(userDir, gid);
    if (!existsSync(dir)) continue;
    for (const filePath of listDataFiles(dir, (f) => f.startsWith("curbs-") && f.endsWith(".json"))) {
      const match = filePath.split("/").pop()!.match(/curbs-(\d+)\.json/);
      if (match) curbOrdinals.add(gk(gid, parseInt(match[1], 10)));
    }
  }
}
function ensureCurbsScanned() { if (!_curbsScanned) scanCurbFiles(); }

function loadCurbs(ordinal: number, gameId: string): CurbSegment[] | null {
  ensureCurbsScanned();
  const key = gk(gameId, ordinal);
  if (curbsByOrdinal.has(key)) return curbsByOrdinal.get(key)!;
  if (!curbOrdinals.has(key)) return null;
  const userPath = resolve(userGameDir(gameId), `curbs-${ordinal}.json`);
  const content = readDataFile(userPath);
  if (!content) return null;
  try {
    const data = JSON.parse(content);
    if (Array.isArray(data)) {
      curbsByOrdinal.set(key, data);
      return data;
    }
    return null;
  } catch { return null; }
}

/**
 * Extract curb segments from a lap's telemetry packets.
 * Groups consecutive rumble-strip positions into polyline segments,
 * with a gap tolerance of 5 packets (~83ms at 60Hz) to bridge brief bounces.
 */
export function extractCurbSegments(packets: { PositionX: number; PositionZ: number; WheelOnRumbleStripFL: number; WheelOnRumbleStripFR: number; WheelOnRumbleStripRL: number; WheelOnRumbleStripRR: number }[]): CurbSegment[] {
  const segments: CurbSegment[] = [];
  let currentPoints: Point[] = [];
  let currentSide: "left" | "right" | "both" = "both";
  let gapCount = 0;
  const GAP_TOLERANCE = 5; // bridge gaps up to 5 packets
  const MIN_SEGMENT_POINTS = 3; // need at least 3 positions to be a real curb

  for (const p of packets) {
    if (p.PositionX === 0 && p.PositionZ === 0) continue;

    const fl = p.WheelOnRumbleStripFL > 0;
    const fr = p.WheelOnRumbleStripFR > 0;
    const rl = p.WheelOnRumbleStripRL > 0;
    const rr = p.WheelOnRumbleStripRR > 0;
    const anyRumble = fl || fr || rl || rr;

    if (anyRumble) {
      // Don't assign side from wheel position — a left wheel can hit a right curb.
      // Side is determined later by correlating with track boundaries.
      if (currentPoints.length === 0) {
        currentSide = "both";
      }
      currentPoints.push({ x: p.PositionX, z: p.PositionZ });
      gapCount = 0;
    } else if (currentPoints.length > 0) {
      gapCount++;
      if (gapCount > GAP_TOLERANCE) {
        // End of segment
        if (currentPoints.length >= MIN_SEGMENT_POINTS) {
          segments.push({ points: [...currentPoints], side: currentSide });
        }
        currentPoints = [];
        gapCount = 0;
      }
    }
  }

  // Close final segment
  if (currentPoints.length >= MIN_SEGMENT_POINTS) {
    segments.push({ points: currentPoints, side: currentSide });
  }

  return segments;
}

/**
 * Record curb data from a completed lap. Merges with existing curb data
 * for the track, deduplicating overlapping segments.
 */
export function recordCurbData(ordinal: number, newSegments: CurbSegment[], gameId: string): void {
  validateGameId(gameId);
  if (newSegments.length === 0) return;

  const key = gk(gameId, ordinal);
  const count = (curbLapCounts.get(key) ?? 0) + 1;
  curbLapCounts.set(key, count);

  const existing = curbsByOrdinal.get(key) ?? [];

  // Downsample segment points (curbs at 60Hz produce too many points)
  const downsampled = newSegments.map(seg => ({
    ...seg,
    points: downsamplePoints(seg.points, 3), // keep every ~3m
  }));

  // Merge: for each new segment, check if it overlaps an existing one
  const merged = [...existing];
  for (const newSeg of downsampled) {
    if (newSeg.points.length < 2) continue;
    const mid = newSeg.points[Math.floor(newSeg.points.length / 2)];
    let foundOverlap = false;

    for (let i = 0; i < merged.length; i++) {
      const eMid = merged[i].points[Math.floor(merged[i].points.length / 2)];
      const dx = mid.x - eMid.x;
      const dz = mid.z - eMid.z;
      if (dx * dx + dz * dz < 100) { // within 10m = same curb
        // Average the points for a smoother result
        if (merged[i].points.length === newSeg.points.length) {
          for (let j = 0; j < merged[i].points.length; j++) {
            // Weighted average favoring accumulated data
            const w = Math.min(count - 1, 5);
            merged[i].points[j] = {
              x: (merged[i].points[j].x * w + newSeg.points[j].x) / (w + 1),
              z: (merged[i].points[j].z * w + newSeg.points[j].z) / (w + 1),
            };
          }
        }
        foundOverlap = true;
        break;
      }
    }

    if (!foundOverlap) {
      merged.push(newSeg);
    }
  }

  curbsByOrdinal.set(key, merged);

  // Save to disk on first lap and periodically
  if (count === 1 || count === 3 || count === 5 || count % 5 === 0) {
    const filePath = resolve(userGameDir(gameId), `curbs-${ordinal}.json`);
    try {
      writeFileSync(filePath, JSON.stringify(merged, null, 2));
      console.log(`[Tracks] Saved curb data for track ${ordinal}: ${merged.length} segments from ${count} laps`);
    } catch (err) {
      console.error(`[Tracks] Failed to save curb data:`, err);
    }
  }
}

/** Downsample points keeping minimum spacing. */
function downsamplePoints(points: Point[], minDist: number): Point[] {
  if (points.length <= 2) return points;
  const result = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const last = result[result.length - 1];
    const dx = points[i].x - last.x;
    const dz = points[i].z - last.z;
    if (dx * dx + dz * dz >= minDist * minDist) {
      result.push(points[i]);
    }
  }
  // Always include last point
  const lastPt = points[points.length - 1];
  if (result[result.length - 1] !== lastPt) result.push(lastPt);
  return result;
}

/**
 * Get curb segments for a track by ordinal.
 */
export function getTrackCurbs(ordinal: number, gameId: string): CurbSegment[] | null {
  validateGameId(gameId);
  return loadCurbs(ordinal, gameId);
}

export type { TrackSectors };

export function getTrackSectors(trackName: string): TrackSectors {
  return getTrackSectorsByName(trackName);
}

export function getTrackSectorsByOrdinal(ordinal: number): TrackSectors {
  ensureOrdinals();
  const name = ordinalToTrackName.get(ordinal);
  if (!name) return DEFAULT_SECTORS;
  return getTrackSectorsByName(name);
}

/** Get the shared outline filename for a Forza track ordinal (e.g. "silverstone"). */
export function getForzaSharedOutline(ordinal: number): string | undefined {
  ensureOrdinals();
  return ordinalToSharedOutline.get(ordinal);
}
