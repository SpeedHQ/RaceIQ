import { resolve } from "node:path";
import { bundledTrackDir as bundledGameDir, computedAverageFileName, getBundledTrackName, readUserOrBundled } from "../resolve-name";
import { readDataFile, userGameDir } from "@raceiq/shared/racing/tracks/storage/files";
import { applyAlignment, computeAlignment } from "@raceiq/shared/racing/tracks/geometry/points";
import { getTrackNameByOrdinal, hasBundledBoundaryByOrdinal, loadBoundaryByName } from "./outlines";
import { loadAccSvgBoundaryByName } from "@raceiq/shared/racing/tracks/geometry/acc-svg";
import type { Point, TrackBoundary } from "@raceiq/shared/racing/tracks/geometry/types";
import { getRecordedOutlineById } from "../recording/outlines";
import { getAcEvoSharedTrackName } from "@raceiq/game-ac-evo-metadata/racing/tracks/catalogs/ac-evo";
import { isAcEvoTouristLayout, parseAcEvoTrackId } from "@raceiq/game-ac-evo-metadata/identity";

/** Tourist shares Nordschleife world coordinates, but not its lap origin or closing section. */
function trimTouristBoundary(boundary: TrackBoundary, route: Point[]): TrackBoundary | null {
  const count = Math.min(boundary.leftEdge.length, boundary.rightEdge.length);
  if (count < 10 || route.length < 10) return null;
  const center = Array.from({ length: count }, (_, index) => ({
    x: (boundary.leftEdge[index].x + boundary.rightEdge[index].x) / 2,
    z: (boundary.leftEdge[index].z + boundary.rightEdge[index].z) / 2,
  }));
  function nearest(point: Point): number {
    let best = -1;
    let distanceSquared = 15 * 15;
    for (let index = 0; index < count; index++) {
      // Recorded Tourist routes contain normalized telemetry X; extracted edges contain raw game X.
      const distance = (-point.x - center[index].x) ** 2 + (point.z - center[index].z) ** 2;
      if (distance < distanceSquared) {
        best = index;
        distanceSquared = distance;
      }
    }
    return best;
  }
  const cumulative = [0];
  for (let index = 1; index < count; index++) {
    cumulative.push(cumulative[index - 1] + Math.hypot(center[index].x - center[index - 1].x, center[index].z - center[index - 1].z));
  }
  const circuitLength = cumulative[count - 1] + Math.hypot(center[0].x - center[count - 1].x, center[0].z - center[count - 1].z);
  let previous = -1;
  let runStart = -1;
  let runLength = 0;
  let bestStart = -1;
  let bestEnd = -1;
  let bestLength = 0;
  let routeLength = 0;
  const runs: { start: number; end: number; length: number }[] = [];
  // Bundled edges include the GP detour. Preserve supported runs without bridging the missing connector.
  for (let index = 0; index < route.length; index++) {
    const current = nearest(route[index]);
    const step = index > 0 ? Math.hypot(route[index].x - route[index - 1].x, route[index].z - route[index - 1].z) : 0;
    routeLength += step;
    const edgeStep = current >= 0 && previous >= 0
      ? (cumulative[current] - cumulative[previous] + circuitLength) % circuitLength
      : Infinity;
    if (current < 0 || previous < 0 || edgeStep > step * 2 + 30) {
      if (runStart >= 0 && previous >= 0 && runLength > 20) runs.push({ start: runStart, end: previous, length: runLength });
      runStart = current;
      runLength = 0;
    } else {
      runLength += step;
    }
    if (runLength > bestLength) {
      bestLength = runLength;
      bestStart = runStart;
      bestEnd = current;
    }
    previous = current;
  }
  if (runStart >= 0 && previous >= 0 && runLength > 20) runs.push({ start: runStart, end: previous, length: runLength });
  if (bestStart < 0 || bestEnd < 0 || bestStart === bestEnd || routeLength <= 0 || bestLength / routeLength < 0.9) return null;
  function clip(start: number, end: number): TrackBoundary {
    const leftEdge: Point[] = [];
    const rightEdge: Point[] = [];
    const centerLine: Point[] = [];
    for (let index = start; ; index = (index + 1) % count) {
      leftEdge.push(boundary.leftEdge[index]);
      rightEdge.push(boundary.rightEdge[index]);
      centerLine.push(center[index]);
      if (index === end) break;
    }
    return { leftEdge, rightEdge, centerLine, pitLane: null };
  }
  function length(points: Point[]): number {
    let result = 0;
    for (let index = 1; index < points.length; index++) {
      result += Math.hypot(points[index].x - points[index - 1].x, points[index].z - points[index - 1].z);
    }
    return result;
  }
  const primary = clip(bestStart, bestEnd);
  if (Math.abs(length(primary.centerLine!) / bestLength - 1) > 0.1) return null;
  const additionalSections: NonNullable<TrackBoundary["additionalSections"]> = [];
  for (const run of runs) {
    if (run.start === bestStart && run.end === bestEnd) continue;
    const section = clip(run.start, run.end);
    if (Math.abs(length(section.centerLine!) / run.length - 1) <= 0.1) {
      additionalSections.push({ leftEdge: section.leftEdge, rightEdge: section.rightEdge });
    }
  }
  return { ...primary, additionalSections };
}

/** Resolve curated boundaries by native AC Evo identity without ordinal translation. */
export function getTrackBoundariesById(trackId: string, gameId: string): TrackBoundary | null {
  if (!trackId) return null;
  if (gameId !== "ac-evo") {
    const ordinal = Number(trackId);
    return Number.isInteger(ordinal) ? getTrackBoundariesByOrdinal(ordinal, gameId) : null;
  }
  const tourist = isAcEvoTouristLayout(parseAcEvoTrackId(trackId));
  const name = tourist ? "nordschleife" : getAcEvoSharedTrackName(trackId);
  if (!name) return null;
  const content = readDataFile(resolve(bundledGameDir(gameId), `${name}-boundaries.json`));
  let boundary: TrackBoundary | null = null;
  if (content) {
    try {
      const data = JSON.parse(content) as TrackBoundary;
      if (data.leftEdge?.length && data.rightEdge?.length) boundary = data;
    } catch { /* Ignore malformed optional geometry. */ }
  }
  boundary ??= loadAccSvgBoundaryByName(name);
  const recordedCenterline = getRecordedOutlineById(trackId, gameId);
  if (tourist) return boundary && recordedCenterline ? trimTouristBoundary(boundary, recordedCenterline) : null;
  if (!boundary || !recordedCenterline || !boundary.centerLine) return boundary;
  const alignment = computeAlignment(boundary.centerLine, recordedCenterline);
  if (!alignment) return boundary;
  return {
    ...boundary,
    leftEdge: boundary.leftEdge.map((point) => applyAlignment(point, alignment)),
    rightEdge: boundary.rightEdge.map((point) => applyAlignment(point, alignment)),
    centerLine: boundary.centerLine.map((point) => applyAlignment(point, alignment)),
    pitLane: boundary.pitLane?.map((point) => applyAlignment(point, alignment)) ?? null,
  };
}

export function getTrackBoundariesByOrdinal(ordinal: number, gameId: string): TrackBoundary | null {
  if (gameId === "lmu") return null;
  // Try extracted boundaries first (game-specific)
  const extracted = loadExtractedBoundary(ordinal, gameId);
  if (extracted) return extracted;

  // Shared boundaries are in real-world coordinates — only usable for Forza
  // which has calibration transforms.
  if (gameId !== "fm-2023") return null;

  if (!hasBundledBoundaryByOrdinal(ordinal)) return null;
  const name = getTrackNameByOrdinal(ordinal);
  if (!name) return null;
  return loadBoundaryByName(name);
}



/** Load extracted boundary data, aligned to telemetry coordinate space if possible. */
export function loadExtractedBoundary(ordinal: number, gameId: string): TrackBoundary | null {
  if (gameId === "acc") {
    const name = getBundledTrackName("acc", ordinal);
    return name ? loadAccSvgBoundaryByName(name) : null;
  }
  const userExtracted = resolve(userGameDir(gameId), "extracted", `boundaries-${ordinal}.json`);
  const trackName = getBundledTrackName(gameId, ordinal);
  const bundledFile = trackName ? resolve(bundledGameDir(gameId), `${trackName}-boundaries.json`) : null;
  // AC Evo uses ACC SVG geometry only when no AC Evo-specific geometry exists.
  const accFallback = gameId === "ac-evo" && trackName ? loadAccSvgBoundaryByName(trackName) : null;
  const content = readDataFile(userExtracted) ?? (bundledFile ? readDataFile(bundledFile) : null);
  if (!content) {
    if (!accFallback) return null;
    const extContent = readUserOrBundled(gameId, `extracted/recorded-${ordinal}.csv`);
    const caName = computedAverageFileName(gameId, ordinal);
    const telContent = readDataFile(resolve(userGameDir(gameId), `${caName}.csv`));
    if (extContent && telContent) {
      const parseCSV = (c: string) => c.split("\n").filter(Boolean).slice(1).map(l => { const [x, z] = l.split(",").map(Number); return { x, z }; });
      const align = computeAlignment(parseCSV(extContent), parseCSV(telContent));
      if (align) return {
        ...accFallback,
        leftEdge: accFallback.leftEdge.map(p => applyAlignment(p, align)),
        rightEdge: accFallback.rightEdge.map(p => applyAlignment(p, align)),
        centerLine: accFallback.centerLine?.map(p => applyAlignment(p, align)),
        pitLane: accFallback.pitLane?.map(p => applyAlignment(p, align)) ?? null,
      };
    }
    return accFallback;
  }

  try {
    const data = JSON.parse(content);
    if (!data.leftEdge || !data.rightEdge || data.leftEdge.length < 10) return accFallback;
    let left: Point[] = data.leftEdge;
    let right: Point[] = data.rightEdge;
    let pit: Point[] | null = data.pitLane ?? null;

    // If alignment was poor, transform boundaries to match telemetry outline.
    // AC Evo may use a different world origin even when geometry came from ACC.
    const isPreAligned = gameId !== "ac-evo" && (data.aligned || data.coordSystem === "acc");
    if (!isPreAligned) {
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


/** Load altitude (elevation) array for a track from extracted game data. */
export function getTrackAltitudeByOrdinal(ordinal: number): number[] | null {
  const content = readUserOrBundled("fm-2023", `extracted/boundaries-${ordinal}.json`);
  if (!content) return null;
  try {
    const data = JSON.parse(content);
    return data.altitude && data.altitude.length > 0 ? data.altitude : null;
  } catch { return null; }
}
