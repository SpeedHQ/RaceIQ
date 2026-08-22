import type { SemanticTelemetrySample } from "../../../telemetry/replay/contracts";

import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Point } from "../geometry/types";
import { listDataFiles, readDataFile, userDir, userGameDir, validateGameId } from "../storage/files";

function gk(gameId: string, ordinal: number): string {
  return `${gameId}:${ordinal}`;
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
      const match = filePath
        .split("/")
        .pop()!
        .match(/curbs-(\d+)\.json/);
      if (match) curbOrdinals.add(gk(gid, parseInt(match[1], 10)));
    }
  }
}
function ensureCurbsScanned() {
  if (!_curbsScanned) scanCurbFiles();
}

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
  } catch {
    return null;
  }
}

/**
 * Extract curb segments from a lap's telemetry packets.
 * Groups consecutive rumble-strip positions into polyline segments,
 * with a gap tolerance of 5 packets (~83ms at 60Hz) to bridge brief bounces.
 */
export function extractCurbSegments(
  packets: { PositionX: number; PositionZ: number; WheelOnRumbleStripFL: number; WheelOnRumbleStripFR: number; WheelOnRumbleStripRL: number; WheelOnRumbleStripRR: number }[],
): CurbSegment[] {
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

/** Extract curb segments from resolver-backed semantic telemetry only. */
export function extractCurbSegmentsFromSemanticSamples(samples: readonly SemanticTelemetrySample[]): CurbSegment[] {
  const segments: CurbSegment[] = [];
  let currentPoints: Point[] = [];
  let gapCount = 0;
  for (const sample of samples) {
    const x = sample.values["motion.position-x"];
    const z = sample.values["motion.position-z"];
    const rumble = sample.values["tires.wheel-on-rumble-strip"];
    if (
      typeof x !== "number" ||
      !Number.isFinite(x) ||
      typeof z !== "number" ||
      !Number.isFinite(z) ||
      !Array.isArray(rumble) ||
      rumble.length !== 4 ||
      !rumble.every((value) => typeof value === "boolean")
    ) {
      continue;
    }
    if (x === 0 && z === 0) continue;
    if (rumble[0] || rumble[1] || rumble[2] || rumble[3]) {
      currentPoints.push({ x, z });
      gapCount = 0;
    } else if (currentPoints.length > 0 && ++gapCount > 5) {
      if (currentPoints.length >= 3) segments.push({ points: currentPoints, side: "both" });
      currentPoints = [];
      gapCount = 0;
    }
  }
  if (currentPoints.length >= 3) segments.push({ points: currentPoints, side: "both" });
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
  const downsampled = newSegments.map((seg) => ({
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
      if (dx * dx + dz * dz < 100) {
        // within 10m = same curb
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
