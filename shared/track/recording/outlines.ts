import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { bundledTrackDir as bundledGameDir, computedAverageFileName, getBundledTrackName, loadBundledPointCsv } from "../resolve-name";
import { filterOutlierPoints } from "../geometry/points";
import { getBundledOutlineByOrdinal, hasBundledOutlineByOrdinal } from "../geometry/outlines";
import { loadSharedOutline } from "../geometry/shared";
import type { Point } from "../geometry/types";
import { ttlCache } from "../storage/cache";
import { listDataFiles, readDataFile, userDir, userGameDir, validateGameId } from "../storage/files";

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
  for (const gid of ["fm-2023", "f1-2025", "acc", "ac-evo", "iracing"]) {
    const dir = resolve(userDir, gid);
    if (!existsSync(dir)) continue;
    for (const filePath of listDataFiles(dir, (f) => f.endsWith("-computed-average.csv"))) {
      const m = filePath
        .split("/")
        .pop()!
        .match(/(?:^|-)(\d+)-computed-average\.csv$/);
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

/** Load only a telemetry-generated outline, without bundled/shared fallbacks. */
export function getRecordedOutlineByOrdinal(
  ordinal: number,
  gameId: string,
): Point[] | null {
  validateGameId(gameId);
  return loadRecordedOutline(ordinal, gameId);
}
// Store all lap traces for averaging — keyed by "gameId:ordinal"
const lapTraces = new Map<string, Point[][]>();
// Store start-line positions from lap boundaries for averaging
const startLinePositions = new Map<string, Point[]>();
// Store start-line yaw values for direction arrow
const startLineYaws = new Map<string, number[]>();

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
  // Exception: AC Evo reuses ACC's extracted outlines but still needs its own
  // telemetry recording for boundary alignment (different coordinate space).
  if (hasExtractedOutline(ordinal, gameId) && gameId !== "ac-evo") return;

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


/**
 * Get centerline for a track. Priority: bundled game data → computed average → TUMFTM.
 * sharedName: optional shared outline file name (e.g. "silverstone") for cross-game tracks.
 */
export function getTrackOutlineByOrdinal(ordinal: number, gameId: string, sharedName?: string): Point[] | null {
  validateGameId(gameId);
  const resolvedSharedName =
    sharedName ?? getBundledTrackName(gameId, ordinal);
  return loadBundledPointCsv(ordinal, gameId, "centerline") ??
    loadRecordedOutline(ordinal, gameId) ??
    loadSharedOutline(resolvedSharedName ?? "") ??
    (gameId === "fm-2023" ? getBundledOutlineByOrdinal(ordinal) : null);
}

/**
 * Get the game's reference racing line for a track, if one was extracted.
 *
 * Only ACC ships this (fastlane.ai's AI line, reused by AC Evo for the shared Kunos
 * circuits); every other game returns null. It is a driving line, not track geometry —
 * use getTrackOutlineByOrdinal for the centreline.
 */
export function getTrackRacelineByOrdinal(ordinal: number, gameId: string): Point[] | null {
  validateGameId(gameId);
  return loadBundledPointCsv(ordinal, gameId, "raceline");
}

/**
 * Total track length in metres, derived by summing consecutive point distances
 * along the outline. Returns null when no outline is available (never guess a length).
 */
export function getTrackLengthMeters(ordinal: number, gameId: string, sharedName?: string): number | null {
  const outline = getTrackOutlineByOrdinal(ordinal, gameId, sharedName);
  if (!outline || outline.length < 2) return null;
  let length = 0;
  for (let i = 1; i < outline.length; i++) {
    const dx = outline[i].x - outline[i - 1].x;
    const dz = outline[i].z - outline[i - 1].z;
    length += Math.sqrt(dx * dx + dz * dz);
  }
  return length;
}

export function hasRecordedOutline(ordinal: number, gameId: string): boolean {
  validateGameId(gameId);
  ensureRecordedScanned();
  const key = gk(gameId, ordinal);
  return recordedOrdinals.has(key) || recordedOutlines.has(key);
}

export function hasTrackOutline(ordinal: number, gameId: string): boolean {
  validateGameId(gameId);
  return hasRecordedOutline(ordinal, gameId) || hasBundledOutlineByOrdinal(ordinal);
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
