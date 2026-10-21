
import { getAcEvoSharedTrackName } from "@raceiq/game-ac-evo-metadata/racing/tracks/catalogs/ac-evo";
import { copyFileSync, existsSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { bundledTrackDir as bundledGameDir, computedAverageFileName, getBundledTrackName, loadBundledPointCsv, loadBundledPointCsvByName } from "../resolve-name";
import { loadAccSvgBoundaryByName } from "@raceiq/shared/racing/tracks/geometry/acc-svg";
import { filterOutlierPoints } from "@raceiq/shared/racing/tracks/geometry/points";
import { getBundledOutlineByOrdinal, hasBundledOutlineByOrdinal } from "../geometry/outlines";
import { loadSharedOutline } from "@raceiq/shared/racing/tracks/geometry/shared";
import type { Point } from "@raceiq/shared/racing/tracks/geometry/types";
import { ttlCache } from "@raceiq/shared/racing/tracks/storage/cache";

import { loadKunosTrackCatalog, type KunosTrack } from "@raceiq/shared/racing/tracks/catalogs/kunos";
import { acEvoTrackId } from "@raceiq/game-ac-evo-metadata/identity";
import { listDataFiles, readDataFile, userDir, userGameDir, validateGameId } from "@raceiq/shared/racing/tracks/storage/files";
/** Resolve curated centerline by native string identity. */
export function getTrackOutlineById(trackId: string, gameId: string, sharedName?: string): Point[] | null {
  validateGameId(gameId);
  if (!trackId) return null;
  if (gameId !== "ac-evo") {
    const ordinal = Number(trackId);
    if (!Number.isInteger(ordinal)) {
      return loadRecordedOutline(trackId, gameId) ?? loadSharedOutline(sharedName ?? trackId);
    }
    const resolvedSharedName = sharedName ?? getBundledTrackName(gameId, ordinal);
    return loadBundledPointCsv(ordinal, gameId, "centerline")
      ?? loadRecordedOutline(trackId, gameId)
      ?? loadSharedOutline(resolvedSharedName ?? "")
      ?? (gameId === "fm-2023" ? getBundledOutlineByOrdinal(ordinal) : null);
  }
  const recorded = loadRecordedOutline(trackId, gameId);
  if (recorded) return recorded;
  const catalogName = getAcEvoSharedTrackName(trackId);
  if (!catalogName) return null;
  const name = sharedName ?? catalogName;
  return loadBundledPointCsvByName(name, gameId, "centerline")
    ?? loadAccSvgBoundaryByName(name)?.centerLine
    ?? loadSharedOutline(name);
}

/** Resolve native game's extracted racing line by string identity. */
export function getTrackRacelineById(trackId: string, gameId: string): Point[] | null {
  validateGameId(gameId);
  if (!trackId) return null;
  if (gameId === "ac-evo") {
    const name = getAcEvoSharedTrackName(trackId);
    return name ? loadBundledPointCsvByName(name, gameId, "raceline") : null;
  }
  const ordinal = Number(trackId);
  return Number.isInteger(ordinal) ? loadBundledPointCsv(ordinal, gameId, "raceline") : null;
}

/** Track length derived from native-identity centerline. */
export function getTrackLengthMetersById(trackId: string, gameId: string, sharedName?: string): number | null {
  const outline = getTrackOutlineById(trackId, gameId, sharedName);
  if (!outline || outline.length < 2) return null;
  let length = 0;
  for (let i = 1; i < outline.length; i++) {
    const dx = outline[i].x - outline[i - 1].x;
    const dz = outline[i].z - outline[i - 1].z;
    length += Math.sqrt(dx * dx + dz * dz);
  }
  return length;
}

// Recorded outlines are keyed by native identity or by another game's ordinal.
const recordedOutlines = ttlCache<Point[]>();
const recordedLapCounts = new Map<string, number>();
const recordedKeys = new Set<string>();

function gk(gameId: string, identity: number | string): string { return `${gameId}:${identity}`; }
function recordedFileName(gameId: string, identity: number | string): string {
  if (typeof identity === "number") return computedAverageFileName(gameId, identity);
  if (gameId === "ac-evo") return `native-${Buffer.from(identity).toString("base64url")}-computed-average`;
  const ordinal = Number(identity);
  return Number.isInteger(ordinal)
    ? computedAverageFileName(gameId, ordinal)
    : `native-${Buffer.from(identity).toString("base64url")}-computed-average`;
}

let _recordedScanned = false;
let legacyAcEvoCatalog: Map<number, KunosTrack> | undefined;

function migrateLegacyAcEvoOutline(ordinal: number, sourcePath: string): string | undefined {
  try {
    legacyAcEvoCatalog ??= loadKunosTrackCatalog("ac-evo");
    const track = legacyAcEvoCatalog.get(ordinal);
    if (!track) return undefined;
    const id = acEvoTrackId(track.name, track.variant);
    const targetPath = resolve(userGameDir("ac-evo"), `${recordedFileName("ac-evo", id)}.csv`);
    if (!existsSync(targetPath)) copyFileSync(sourcePath, targetPath);
    return id;
  } catch {
    return undefined;
  }
}

// Scan recorded files and backfill historical AC Evo ordinal files once to native filenames.
export function scanRecordedFiles(): void {
  _recordedScanned = true;
  recordedKeys.clear();
  for (const gid of ["fm-2023", "f1-2025", "acc", "ac-evo", "iracing", "lmu"]) {
    const dir = resolve(userDir, gid);
    if (!existsSync(dir)) continue;
    for (const filePath of listDataFiles(dir, (f) => f.endsWith("-computed-average.csv"))) {
      const filename = basename(filePath);
      const native = filename.match(/^native-([A-Za-z0-9_-]+)-computed-average\.csv$/);
      if (native) {
        try {
          const id = Buffer.from(native[1], "base64url").toString("utf8");
          if (id) recordedKeys.add(gk(gid, id));
        } catch { /* Ignore malformed optional recording names. */ }
        continue;
      }
      const legacy = filename.match(/(?:^|-)(\d+)-computed-average\.csv$/);
      if (!legacy) {
        if (gid === "ac-evo") {
          legacyAcEvoCatalog ??= loadKunosTrackCatalog("ac-evo");
          for (const [ordinal, track] of legacyAcEvoCatalog) {
            if (`${track.commonTrackName}-computed-average.csv` !== filename) continue;
            const id = migrateLegacyAcEvoOutline(ordinal, filePath);
            if (id) recordedKeys.add(gk(gid, id));
            break;
          }
        }
        continue;
      }
      const ordinal = Number(legacy[1]);
      if (gid !== "ac-evo") recordedKeys.add(gk(gid, ordinal));
      if (gid === "ac-evo") {
        const id = migrateLegacyAcEvoOutline(ordinal, filePath);
        if (id) recordedKeys.add(gk(gid, id));
      }
    }
  }
}
function ensureRecordedScanned() { if (!_recordedScanned) scanRecordedFiles(); }

/** Check if higher-quality game-specific centerline geometry exists. */
function hasExtractedOutline(identity: number | string, gameId: string): boolean {
  const name = typeof identity === "string" && gameId === "ac-evo"
    ? getAcEvoSharedTrackName(identity)
    : typeof identity === "number" ? getBundledTrackName(gameId, identity) : undefined;
  if (!name) return false;
  if (gameId === "acc" || gameId === "ac-evo") return loadAccSvgBoundaryByName(name) !== null;
  return existsSync(resolve(bundledGameDir(gameId), `${name}-centerline.csv`));
}

function loadRecordedOutline(identity: number | string, gameId: string): Point[] | null {
  ensureRecordedScanned();
  const key = gk(gameId, identity);
  if (recordedOutlines.has(key)) return recordedOutlines.get(key)!;
  if (!recordedKeys.has(key)) return null;
  const userPath = resolve(userGameDir(gameId), `${recordedFileName(gameId, identity)}.csv`);
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
  if (gameId === "ac-evo") return null;
  return loadRecordedOutline(ordinal, gameId);
}

/** Load a telemetry-generated outline by native AC Evo track identity. */
export function getRecordedOutlineById(trackId: string, gameId: string): Point[] | null {
  validateGameId(gameId);
  if (!trackId) return null;
  return loadRecordedOutline(trackId, gameId);
}
// Store traces by game identity for averaging.
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
function recordLapTraceForIdentity(identity: number | string, trace: Point[], startLinePos: Point | null, startYaw: number | null, gameId: string): void {
  validateGameId(gameId);
  if (trace.length < 50) return;

  if (gameId === "ac-evo" && typeof identity === "number") return;
  if (typeof identity === "string" && identity.length === 0) return;
  const key = gk(gameId, identity);
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

  // Prefer existing game-specific outlines over telemetry recordings.
  // AC Evo reuses ACC geometry but needs its own telemetry recording for
  // boundary alignment because it uses a different coordinate space.
  if (typeof identity === "number" && hasExtractedOutline(identity, gameId) && gameId !== "ac-evo") return;

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
    console.log(`[Tracks] Averaged ${traces.length} laps for track ${identity} (lap ${count})`);
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
      console.log(`[Tracks] Rotated outline for track ${identity}: start at point ${bestIdx} (avg of ${positions.length} lap starts)`);
    }
  }

  recordedKeys.add(key);

  if (shouldSave) {
    const caName = recordedFileName(gameId, identity);
    const filePath = resolve(userGameDir(gameId), `${caName}.csv`);
    try {
      writeFileSync(filePath, `x,z\n${outline.map((p) => `${p.x},${p.z}`).join("\n")}`);
      console.log(`[Tracks] Saved ${caName} (${outline.length} pts, lap ${count})`);
    } catch (err) {
      console.error(`[Tracks] Failed to save recorded outline:`, err);
    }
  }
}
/** Record a lap trace for an ordinal-keyed game. */
export function recordLapTrace(ordinal: number, trace: Point[], startLinePos: Point | null, startYaw: number | null, gameId: string): void {
  recordLapTraceForIdentity(ordinal, trace, startLinePos, startYaw, gameId);
}

/** Record a lap trace for native AC Evo track identity. */
export function recordLapTraceById(trackId: string, trace: Point[], startLinePos: Point | null, startYaw: number | null, gameId: string): void {
  recordLapTraceForIdentity(trackId, trace, startLinePos, startYaw, gameId);
}

/**
 * Record one valid open-route lap without cyclic alignment or averaging.
 * Start and finish remain exact endpoints; intermediate points are smoothed
 * and resampled by route distance.
 */
function recordOpenLapTraceForIdentity(identity: number | string, trace: Point[], gameId: string): void {
  validateGameId(gameId);
  if (gameId === "ac-evo" && typeof identity === "number") return;
  if (typeof identity === "string" && identity.length === 0) return;
  if (trace.length < 50) return;
  const filtered = filterOutlierPoints(trace);
  if (filtered.length < 50) return;
  const smoothed = filtered.map((point, index) => {
    if (index === 0 || index === filtered.length - 1) return point;
    const previous = filtered[index - 1];
    const next = filtered[index + 1];
    return {
      x: (previous.x + 2 * point.x + next.x) / 4,
      z: (previous.z + 2 * point.z + next.z) / 4,
    };
  });
  const cumulative = [0];
  for (let index = 1; index < smoothed.length; index++) {
    cumulative.push(cumulative[index - 1] + Math.hypot(
      smoothed[index].x - smoothed[index - 1].x,
      smoothed[index].z - smoothed[index - 1].z,
    ));
  }
  const total = cumulative[cumulative.length - 1];
  if (total <= 0) return;
  const count = Math.min(500, smoothed.length);
  const outline: Point[] = [];
  let segment = 1;
  for (let index = 0; index < count; index++) {
    const target = total * index / (count - 1);
    while (segment < cumulative.length - 1 && cumulative[segment] < target) segment++;
    const start = cumulative[segment - 1];
    const length = cumulative[segment] - start;
    const fraction = length > 0 ? (target - start) / length : 0;
    const from = smoothed[segment - 1];
    const to = smoothed[segment];
    outline.push({
      x: from.x + (to.x - from.x) * fraction,
      z: from.z + (to.z - from.z) * fraction,
    });
  }
  outline[0] = filtered[0];
  outline[outline.length - 1] = filtered[filtered.length - 1];
  const key = gk(gameId, identity);
  recordedOutlines.set(key, outline);
  recordedKeys.add(key);
  const filePath = resolve(userGameDir(gameId), `${recordedFileName(gameId, identity)}.csv`);
  try {
    writeFileSync(filePath, `x,z\n${outline.map((point) => `${point.x},${point.z}`).join("\n")}`);
  } catch (err) {
    console.error("[Tracks] Failed to save open-route outline:", err);
  }
}
/** Record an open-route lap for an ordinal-keyed game. */
export function recordOpenLapTrace(ordinal: number, trace: Point[], gameId: string): void {
  recordOpenLapTraceForIdentity(ordinal, trace, gameId);
}

/** Record an open-route lap for native AC Evo track identity. */
export function recordOpenLapTraceById(trackId: string, trace: Point[], gameId: string): void {
  recordOpenLapTraceForIdentity(trackId, trace, gameId);
}


/**
 * Get centerline for a track. Priority: bundled game data → computed average → TUMFTM.
 * sharedName: optional shared outline file name (e.g. "silverstone") for cross-game tracks.
 */
export function getTrackOutlineByOrdinal(ordinal: number, gameId: string, sharedName?: string): Point[] | null {
  validateGameId(gameId);
  if (gameId === "ac-evo") return null;
  const resolvedSharedName = sharedName ?? getBundledTrackName(gameId, ordinal);
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
  if (gameId === "ac-evo") return null;
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
  if (gameId === "ac-evo") return false;
  ensureRecordedScanned();
  const key = gk(gameId, ordinal);
  return recordedKeys.has(key) || recordedOutlines.has(key);
}

/** Check whether native AC Evo track identity has a recorded outline. */
export function hasRecordedOutlineById(trackId: string, gameId: string): boolean {
  validateGameId(gameId);
  if (!trackId) return false;
  ensureRecordedScanned();
  const key = gk(gameId, trackId);
  return recordedKeys.has(key) || recordedOutlines.has(key);
}

export function hasTrackOutline(ordinal: number, gameId: string): boolean {
  validateGameId(gameId);
  return hasRecordedOutline(ordinal, gameId) || hasBundledOutlineByOrdinal(ordinal);
}


/**
 * Get the averaged start-line Yaw (radians) for a track. Returns null if not yet recorded.
 */
export function getStartYaw(trackId: string, gameId: string): number | null {
  validateGameId(gameId);
  const yaws = startLineYaws.get(gk(gameId, trackId));
  if (!yaws || yaws.length === 0) return null;
  // Average yaw using circular mean (handles wrapping around ±π)
  let sinSum = 0, cosSum = 0;
  for (const y of yaws) { sinSum += Math.sin(y); cosSum += Math.cos(y); }
  return Math.atan2(sinSum / yaws.length, cosSum / yaws.length);
}

/**
 * Delete a computed-average outline for a track (resets to bundled or no outline).
 */
function deleteRecordedOutlineForIdentity(identity: number | string, gameId: string): boolean {
  validateGameId(gameId);
  if (typeof identity === "number" && gameId === "ac-evo") return false;
  if (typeof identity === "string" && identity.length === 0) return false;
  const key = gk(gameId, identity);
  const had = recordedKeys.has(key) || recordedOutlines.has(key);
  recordedKeys.delete(key);
  recordedOutlines.delete(key);
  recordedLapCounts.delete(key);
  lapTraces.delete(key);
  startLinePositions.delete(key);
  startLineYaws.delete(key);

  const filePath = resolve(userGameDir(gameId), `${recordedFileName(gameId, identity)}.csv`);
  if (existsSync(filePath)) {
    try { unlinkSync(filePath); } catch {}
  }
  if (had) console.log(`[Tracks] Deleted computed average for track ${identity}`);
  return had;
}

/** Delete an ordinal-keyed game's computed-average outline. */
export function deleteRecordedOutline(ordinal: number, gameId: string): boolean {
  return deleteRecordedOutlineForIdentity(ordinal, gameId);
}

/** Delete a native AC Evo track's computed-average outline. */
export function deleteRecordedOutlineById(trackId: string, gameId: string): boolean {
  return deleteRecordedOutlineForIdentity(trackId, gameId);
}
