import {
  bundledSharedGeometryPath,
  getTrackAssetIdentity,
  getTrackAssetIdentityForFactsSlug,
} from "../storage/assets";
import { readDataFile } from "../storage/files";
import type { Point } from "./types";

/** Load a TUMFTM shared outline by registry facts slug. */
const sharedOutlineCache = new Map<string, Point[] | null>();
export function loadSharedOutline(factsSlug: string): Point[] | null {
  if (!factsSlug) return null;
  const cached = sharedOutlineCache.get(factsSlug);
  if (cached !== undefined) return cached;
  const identity = getTrackAssetIdentityForFactsSlug(factsSlug);
  const path = identity && bundledSharedGeometryPath(identity, "tumftm", factsSlug, "centerline");
  const content = path ? readDataFile(path) : null;
  if (!content) {
    sharedOutlineCache.set(factsSlug, null);
    return null;
  }
  try {
    const lines = content.split("\n").filter(Boolean);
    const data: Point[] = lines.slice(1).map((line) => {
      const [x, z] = line.split(",").map(Number);
      return { x, z };
    });
    const result = data.length > 10 ? data : null;
    sharedOutlineCache.set(factsSlug, result);
    return result;
  } catch {
    sharedOutlineCache.set(factsSlug, null);
    return null;
  }
}

/** Load shared TUMFTM outline for one canonical game-track assignment. */
export function loadSharedOutlineByOrdinal(ordinal: number, gameId: string): Point[] | null {
  const factsSlug = getTrackAssetIdentity(gameId, ordinal)?.factsSlug;
  return factsSlug ? loadSharedOutline(factsSlug) : null;
}

/** Load shared TUMFTM boundaries by registry facts slug. */
export type SharedBoundaryData = { leftEdge: Point[]; rightEdge: Point[]; centerLine: Point[]; pitLane: Point[] | null; coordSystem: string };
const sharedBoundaryCache = new Map<string, SharedBoundaryData | null>();
export function loadSharedBoundary(factsSlug: string): SharedBoundaryData | null {
  if (!factsSlug) return null;
  const cached = sharedBoundaryCache.get(factsSlug);
  if (cached !== undefined) return cached;
  const identity = getTrackAssetIdentityForFactsSlug(factsSlug);
  const path = identity && bundledSharedGeometryPath(identity, "tumftm", factsSlug, "boundaries");
  const content = path ? readDataFile(path) : null;
  if (!content) {
    sharedBoundaryCache.set(factsSlug, null);
    return null;
  }
  try {
    const data = JSON.parse(content) as SharedBoundaryData;
    sharedBoundaryCache.set(factsSlug, data);
    return data;
  } catch {
    sharedBoundaryCache.set(factsSlug, null);
    return null;
  }
}

/** Load shared TUMFTM boundaries for one canonical game-track assignment. */
export function loadSharedBoundaryByOrdinal(ordinal: number, gameId: string): SharedBoundaryData | null {
  const factsSlug = getTrackAssetIdentity(gameId, ordinal)?.factsSlug;
  return factsSlug ? loadSharedBoundary(factsSlug) : null;
}
