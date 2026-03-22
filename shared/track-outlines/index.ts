import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { getTrackSectorsByName, DEFAULT_SECTORS, type TrackSectors } from "./sectors";

const __dirname = dirname(fileURLToPath(import.meta.url));

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
  "Brand Hatch": { filename: "brands-hatch.csv", source: "tumftm" },
  "Circuit de Barcelona-Catalunya": { filename: "catalunya.csv", source: "tumftm" },
  "Circuit de Spa-Francorchamps": { filename: "spa.csv", source: "tumftm" },
  "Hockenheimring": { filename: "hockenheim.csv", source: "tumftm" },
  "Indianapolis Motor Speedway": { filename: "indianapolis.csv", source: "tumftm" },
  "Nürburgring": { filename: "nurburgring.csv", source: "tumftm" },
  "Silverstone Racing Circuit": { filename: "silverstone.csv", source: "tumftm" },
  "Suzuka Circuit": { filename: "suzuka.csv", source: "tumftm" },
  "Yas Marina Circuit": { filename: "yas-marina.csv", source: "tumftm" },

  // OpenStreetMap Overpass API (7 tracks)
  "WeatherTech Raceway Laguna Seca": { filename: "laguna-seca.csv", source: "osm" },
  "Road Atlanta": { filename: "road-atlanta.csv", source: "osm" },
  "Daytona Intl Speedway": { filename: "daytona.csv", source: "osm" },
  "Lime Rock Park": { filename: "lime-rock.csv", source: "osm" },
  "Mugello Circuit": { filename: "mugello.csv", source: "osm" },
  "Road America": { filename: "road-america.csv", source: "osm" },
  "Virginia International Raceway": { filename: "virginia.csv", source: "osm" },
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
      const lines = readFileSync(filePath, "utf-8").split("\n").filter(Boolean);
      let data: Point[] = lines.slice(1).map((l) => {
        const [x, z] = l.split(",").map(Number);
        return { x, z };
      });
      data = filterOutlierPoints(data);
      outlinesByName.set(trackName, data);
      sourceByName.set(trackName, entry.source);
    } catch {}
  }
}

// Load boundary data (left/right track edges from TUMFTM width data)
const boundariesByName = new Map<string, TrackBoundary>();
const boundariesByOrdinal = new Map<number, TrackBoundary>();

const boundariesDir = resolve(__dirname, "boundaries");
if (existsSync(boundariesDir)) {
  try {
    const files = readdirSync(boundariesDir).filter((f: string) => f.endsWith(".json"));
    for (const file of files) {
      const filePath = resolve(boundariesDir, file);
      try {
        const data = JSON.parse(readFileSync(filePath, "utf-8"));
        if (data.leftEdge && data.rightEdge) {
          // Find which track name this file belongs to
          const baseName = file.replace(".json", "");
          for (const [trackName, entry] of Object.entries(TRACK_FILES)) {
            if (entry.filename.replace(".csv", "") === baseName) {
              boundariesByName.set(trackName, data);
              break;
            }
          }
        }
      } catch {}
    }
  } catch {}
}

// Tracks where the TUMFTM outline only matches a specific layout variant.
// Maps track name -> set of ordinals that should NOT get the bundled outline/boundary
// because the TUMFTM data is for a different layout (e.g., GP circuit vs Nordschleife).
const LAYOUT_EXCLUSIONS: Record<string, Set<number>> = {
  // TUMFTM "Nürburgring" = GP Circuit (5.12km). Don't apply to other layouts:
  // 31 = Full Circuit (25.38km), 32 = Nordschleife (20.83km), 34 = Sprint (3.63km)
  "Nürburgring": new Set([31, 32, 34]),
};

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

    const excluded = LAYOUT_EXCLUSIONS[name]?.has(ordinal);

    const outline = outlinesByName.get(name);
    if (outline && !excluded) {
      outlinesByOrdinal.set(ordinal, outline);
    }
    const boundary = boundariesByName.get(name);
    if (boundary && !excluded) {
      boundariesByOrdinal.set(ordinal, boundary);
    }
  }
}

// Recorded outlines from in-game telemetry (Forza coords) — preferred over external data
// because Forza coords allow direct position plotting without calibration.
const recordedOutlines = new Map<number, Point[]>();
const recordedLapCounts = new Map<number, number>();

// Load previously recorded outlines (from in-game telemetry)
import { readdirSync } from "fs";
try {
  const files = readdirSync(__dirname).filter((f: string) => f.startsWith("recorded-") && f.endsWith(".csv"));
  for (const file of files) {
    const match = file.match(/recorded-(\d+)\.csv/);
    if (!match) continue;
    const ordinal = parseInt(match[1], 10);
    const filePath = resolve(__dirname, file);
    try {
      const lines = readFileSync(filePath, "utf-8").split("\n").filter(Boolean);
      const data: Point[] = lines.slice(1).map((l) => {
        const [x, z] = l.split(",").map(Number);
        return { x, z };
      });
      if (data.length > 10) {
        recordedOutlines.set(ordinal, data);
      }
    } catch {}
  }
} catch {}

console.log(
  `[Tracks] Loaded ${outlinesByName.size} bundled outlines (${Array.from(sourceByName.values()).filter(s => s === "tumftm").length} TUMFTM, ${Array.from(sourceByName.values()).filter(s => s === "osm").length} OSM), ${recordedOutlines.size} recorded, ${boundariesByOrdinal.size} boundaries, mapped to ${outlinesByOrdinal.size} ordinals`
);

export function getTrackOutline(trackName: string): Point[] | null {
  return outlinesByName.get(trackName) ?? null;
}

/**
 * Get the bundled (external) outline by ordinal, ignoring recorded outlines.
 * Used for coordinate alignment between TUMFTM/OSM and Forza coordinate systems.
 */
export function getBundledOutlineByOrdinal(ordinal: number): Point[] | null {
  return outlinesByOrdinal.get(ordinal) ?? null;
}

/**
 * Get track boundary edges (left/right) by ordinal. Returns null if no boundary data.
 */
export function getTrackBoundariesByOrdinal(ordinal: number): TrackBoundary | null {
  return boundariesByOrdinal.get(ordinal) ?? null;
}

const LAPS_BEFORE_SAVE = 1; // Save after first complete lap

// Store all lap traces for averaging
const lapTraces = new Map<number, Point[][]>();
// Store start-line positions from lap boundaries for averaging
const startLinePositions = new Map<number, Point[]>();
// Store start-line yaw values for direction arrow
const startLineYaws = new Map<number, number[]>();

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
export function recordLapTrace(ordinal: number, trace: Point[], startLinePos: Point | null, startYaw: number | null): void {
  if (trace.length < 50) return;

  const count = (recordedLapCounts.get(ordinal) ?? 0) + 1;
  recordedLapCounts.set(ordinal, count);

  // Accumulate start-line positions
  if (startLinePos) {
    if (!startLinePositions.has(ordinal)) startLinePositions.set(ordinal, []);
    const positions = startLinePositions.get(ordinal)!;
    positions.push(startLinePos);
    if (positions.length > 10) positions.shift(); // keep last 10
  }

  // Accumulate start-line yaw values
  if (startYaw != null) {
    if (!startLineYaws.has(ordinal)) startLineYaws.set(ordinal, []);
    const yaws = startLineYaws.get(ordinal)!;
    yaws.push(startYaw);
    if (yaws.length > 10) yaws.shift();
  }

  // Filter outlier points from the trace (pit lane teleports, rewind jumps)
  trace = filterOutlierPoints(trace);
  if (trace.length < 50) return;

  // Store trace for averaging (keep last 10)
  if (!lapTraces.has(ordinal)) lapTraces.set(ordinal, []);
  const traces = lapTraces.get(ordinal)!;
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
  const positions = startLinePositions.get(ordinal);
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

  recordedOutlines.set(ordinal, outline);

  if (shouldSave) {
    const filePath = resolve(__dirname, `recorded-${ordinal}.csv`);
    try {
      writeFileSync(filePath, "x,z\n" + outline.map((p) => `${p.x},${p.z}`).join("\n"));
      console.log(`[Tracks] Saved recorded outline for track ${ordinal} (${outline.length} pts, lap ${count})`);
    } catch (err) {
      console.error(`[Tracks] Failed to save recorded outline:`, err);
    }
  }
}

/**
 * Get outline for a track. Prefers recorded (Forza coords) over external data.
 */
export function getTrackOutlineByOrdinal(ordinal: number): Point[] | null {
  return recordedOutlines.get(ordinal) ?? outlinesByOrdinal.get(ordinal) ?? null;
}

/**
 * Check if a recorded outline exists (Forza coords, direct plotting).
 */
export function hasRecordedOutline(ordinal: number): boolean {
  return recordedOutlines.has(ordinal);
}

export function hasTrackOutline(ordinal: number): boolean {
  return recordedOutlines.has(ordinal) || outlinesByOrdinal.has(ordinal);
}

export function getTrackSource(trackName: string): Source | null {
  return sourceByName.get(trackName) ?? null;
}

/**
 * Get the averaged start-line Yaw (radians) for a track. Returns null if not yet recorded.
 */
export function getStartYaw(ordinal: number): number | null {
  const yaws = startLineYaws.get(ordinal);
  if (!yaws || yaws.length === 0) return null;
  // Average yaw using circular mean (handles wrapping around ±π)
  let sinSum = 0, cosSum = 0;
  for (const y of yaws) { sinSum += Math.sin(y); cosSum += Math.cos(y); }
  return Math.atan2(sinSum / yaws.length, cosSum / yaws.length);
}

/**
 * Delete a recorded outline for a track (resets to bundled or no outline).
 */
export function deleteRecordedOutline(ordinal: number): boolean {
  const had = recordedOutlines.has(ordinal);
  recordedOutlines.delete(ordinal);
  recordedLapCounts.delete(ordinal);
  lapTraces.delete(ordinal);
  startLinePositions.delete(ordinal);
  startLineYaws.delete(ordinal);

  // Delete the file on disk
  const filePath = resolve(__dirname, `recorded-${ordinal}.csv`);
  if (existsSync(filePath)) {
    try {
      const { unlinkSync } = require("fs");
      unlinkSync(filePath);
      console.log(`[Tracks] Deleted recorded outline for track ${ordinal}`);
    } catch (err) {
      console.error(`[Tracks] Failed to delete recorded outline file:`, err);
    }
  }
  return had;
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

// ── Curb/Kerb Detection ─────────────────────────────────────────────────────
// Curbs are detected from WheelOnRumbleStrip telemetry fields. When any wheel
// is on a rumble strip, we record the car's position. Consecutive rumble-strip
// positions are grouped into segments. Multiple laps are merged to build a
// complete curb map for each track.

export interface CurbSegment {
  points: Point[];
  side: "left" | "right" | "both";
}

const curbsByOrdinal = new Map<number, CurbSegment[]>();
const curbLapCounts = new Map<number, number>();

// Load previously saved curb data
try {
  const curbFiles = readdirSync(__dirname).filter((f: string) => f.startsWith("curbs-") && f.endsWith(".json"));
  for (const file of curbFiles) {
    const match = file.match(/curbs-(\d+)\.json/);
    if (!match) continue;
    const ordinal = parseInt(match[1], 10);
    try {
      const data = JSON.parse(readFileSync(resolve(__dirname, file), "utf-8"));
      if (Array.isArray(data)) {
        curbsByOrdinal.set(ordinal, data);
      }
    } catch {}
  }
  if (curbFiles.length > 0) {
    console.log(`[Tracks] Loaded curb data for ${curbFiles.length} tracks`);
  }
} catch {}

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
export function recordCurbData(ordinal: number, newSegments: CurbSegment[]): void {
  if (newSegments.length === 0) return;

  const count = (curbLapCounts.get(ordinal) ?? 0) + 1;
  curbLapCounts.set(ordinal, count);

  const existing = curbsByOrdinal.get(ordinal) ?? [];

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

  curbsByOrdinal.set(ordinal, merged);

  // Save to disk on first lap and periodically
  if (count === 1 || count === 3 || count === 5 || count % 5 === 0) {
    const filePath = resolve(__dirname, `curbs-${ordinal}.json`);
    try {
      writeFileSync(filePath, JSON.stringify(merged));
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
export function getTrackCurbs(ordinal: number): CurbSegment[] | null {
  return curbsByOrdinal.get(ordinal) ?? null;
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
