import { resolve } from "node:path";
import { bundledTrackDir as bundledGameDir, computedAverageFileName, getBundledTrackName, readUserOrBundled } from "../resolve-name";
import { readDataFile, userGameDir } from "../storage/files";
import { applyAlignment, computeAlignment } from "./points";
import { getTrackNameByOrdinal, hasBundledBoundaryByOrdinal, loadBoundaryByName } from "./outlines";
import { loadAccSvgBoundaryByName } from "./acc-svg";
import type { Point, TrackBoundary } from "./types";

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
