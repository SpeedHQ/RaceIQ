import { resolve } from "node:path";
import { computedAverageFileName, loadBundledPointCsv } from "../resolve-name";
import { bundledGeometryPath, bundledSharedAccGeometryPath, getTrackAssetIdentity, sharedAccGeometrySlug, usesAccGeometryFallback, type TrackAssetIdentity } from "../storage/assets";
import { readDataFile, userGameDir } from "../storage/files";
import { applyAlignment, computeAlignment } from "./points";
import { hasBundledBoundaryByOrdinal, loadBoundaryByOrdinal } from "./outlines";
import type { Point, TrackBoundary } from "./types";

export function getTrackBoundariesByOrdinal(ordinal: number, gameId: string): TrackBoundary | null {
  // Try extracted boundaries first (game-specific)
  const extracted = loadExtractedBoundary(ordinal, gameId);
  if (extracted) return extracted;

  // Shared boundaries are in real-world coordinates — only usable for Forza
  // which has calibration transforms. F1/ACC use their own coordinate spaces.
  if (gameId !== "fm-2023") return null;

  return hasBundledBoundaryByOrdinal(ordinal) ? loadBoundaryByOrdinal(ordinal) : null;
}

/** Load extracted boundary data, aligned to telemetry coordinate space if possible. */
export function loadExtractedBoundary(ordinal: number, gameId: string): TrackBoundary | null {
  const userExtracted = resolve(userGameDir(gameId), "extracted", `boundaries-${ordinal}.json`);
  const identity = getTrackAssetIdentity(gameId, ordinal);
  let content = readDataFile(userExtracted);
  if (!content && identity) {
    content = readDataFile(bundledGeometryPath(identity, "boundaries"));
  }
  const accSlug = identity ? sharedAccGeometrySlug(identity) : null;
  if (!content && identity && accSlug) {
    const sharedPath = bundledSharedAccGeometryPath(identity, accSlug, "boundaries");
    content = sharedPath ? readDataFile(sharedPath) : null;
  }
  const fallbackSlug = identity?.factsSlug ?? null;
  if (!content && identity && fallbackSlug && usesAccGeometryFallback(identity, fallbackSlug)) {
    const accIdentity: TrackAssetIdentity = { ...identity, gameId: "acc" };
    content = readDataFile(bundledGeometryPath(accIdentity, "boundaries"));
    if (!content) {
      const sharedPath = bundledSharedAccGeometryPath(identity, fallbackSlug, "boundaries");
      content = sharedPath ? readDataFile(sharedPath) : null;
    }
  }
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
    const isPreAligned = data.aligned || gameId === "acc";
    if (!isPreAligned) {
      const parseCsv = (csv: string) =>
        csv
          .split("\n")
          .filter(Boolean)
          .slice(1)
          .map((line) => {
            const [x, z] = line.split(",").map(Number);
            return { x, z };
          });
      const recorded = readDataFile(resolve(userGameDir(gameId), "extracted", `recorded-${ordinal}.csv`));
      const extCenter = recorded ? parseCsv(recorded) : loadBundledPointCsv(ordinal, gameId, "centerline");
      const caName = computedAverageFileName(gameId, ordinal);
      const telContent = readDataFile(resolve(userGameDir(gameId), `${caName}.csv`));
      const telCenter = telContent ? parseCsv(telContent) : null;
      if (extCenter && telCenter) {
        const align = computeAlignment(extCenter, telCenter);
        if (align) {
          left = left.map((p) => applyAlignment(p, align));
          right = right.map((p) => applyAlignment(p, align));
          if (pit) pit = pit.map((p) => applyAlignment(p, align));
        }
      }
    }

    return { leftEdge: left, rightEdge: right, pitLane: pit };
  } catch {
    return null;
  }
}

/** Load altitude (elevation) array for a track from extracted game data. */
export function getTrackAltitudeByOrdinal(ordinal: number): number[] | null {
  const identity = getTrackAssetIdentity("fm-2023", ordinal);
  const content = readDataFile(resolve(userGameDir("fm-2023"), "extracted", `boundaries-${ordinal}.json`)) ?? (identity ? readDataFile(bundledGeometryPath(identity, "boundaries")) : null);
  if (!content) return null;
  try {
    const data = JSON.parse(content);
    return data.altitude && data.altitude.length > 0 ? data.altitude : null;
  } catch {
    return null;
  }
}
