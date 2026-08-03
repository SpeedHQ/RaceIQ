import { resolve } from "node:path";
import { bundledTrackDir as bundledGameDir, computedAverageFileName, getBundledTrackName, readUserOrBundled } from "../resolve-name";
import { readDataFile, userGameDir } from "../storage/files";
import { applyAlignment, computeAlignment } from "./points";
import { getTrackNameByOrdinal, hasBundledBoundaryByOrdinal, loadBoundaryByName } from "./outlines";
import type { Point, TrackBoundary } from "./types";

export function getTrackBoundariesByOrdinal(ordinal: number, gameId: string): TrackBoundary | null {
  // Try extracted boundaries first (game-specific)
  const extracted = loadExtractedBoundary(ordinal, gameId);
  if (extracted) return extracted;

  // Shared boundaries are in real-world coordinates — only usable for Forza
  // which has calibration transforms. F1/ACC use their own coordinate spaces.
  if (gameId !== "fm-2023") return null;

  if (!hasBundledBoundaryByOrdinal(ordinal)) return null;
  const name = getTrackNameByOrdinal(ordinal);
  if (!name) return null;
  return loadBoundaryByName(name);
}


/** Load extracted boundary data, aligned to telemetry coordinate space if possible. */
export function loadExtractedBoundary(ordinal: number, gameId: string): TrackBoundary | null {
  const userExtracted = resolve(userGameDir(gameId), "extracted", `boundaries-${ordinal}.json`);
  const trackName = getBundledTrackName(gameId, ordinal);
  const bundledFile = trackName ? resolve(bundledGameDir(gameId), `${trackName}-boundaries.json`) : null;
  // AC Evo and ACC share the same Kunos coord space and the same track geometry
  // for common layouts. Reuse ACC's bundled boundary files for AC Evo when we
  // don't have an AC Evo-specific file.
  const accFallback = gameId === "ac-evo" && trackName ? resolve(bundledGameDir("acc"), `${trackName}-boundaries.json`) : null;
  const content = readDataFile(userExtracted)
    ?? (bundledFile ? readDataFile(bundledFile) : null)
    ?? (accFallback ? readDataFile(accFallback) : null);
  if (!content) return null;
  try {
    const data = JSON.parse(content);
    if (!data.leftEdge || !data.rightEdge || data.leftEdge.length < 10) return null;
    let left: Point[] = data.leftEdge;
    let right: Point[] = data.rightEdge;
    let pit: Point[] | null = data.pitLane ?? null;

    // If alignment was poor, transform boundaries to match telemetry outline.
    // ACC's extracted boundaries are already in telemetry coordinate space.
    // AC Evo reuses ACC boundary files but may have a different world origin,
    // so it must NOT be marked pre-aligned — it needs Procrustes alignment.
    const isPreAligned = data.aligned || data.coordSystem === "acc" || gameId === "acc";
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
