import { bundledLegacyGeometryPath, getTrackAssetIdentity, legacyGeometryOwnerIdentity, type TrackAssetIdentity } from "../storage/assets";
import { readDataFile } from "../storage/files";
import type { Point } from "./types";

export type LegacyBoundaryData = {
  leftEdge: Point[];
  rightEdge: Point[];
  centerLine?: Point[];
  pitLane: Point[] | null;
  coordSystem?: string;
};

const outlineCache = new Map<string, Point[] | null>();
const boundaryCache = new Map<string, LegacyBoundaryData | null>();

function legacyAssetContent(identity: TrackAssetIdentity, kind: "centerline" | "boundaries"): string | null {
  const owner = identity.factsSlug ? legacyGeometryOwnerIdentity(identity.factsSlug) : null;
  return owner ? readDataFile(bundledLegacyGeometryPath(owner, kind)) : null;
}

function loadOutline(identity: TrackAssetIdentity): Point[] | null {
  const factsSlug = identity.factsSlug;
  if (!factsSlug) return null;
  const cached = outlineCache.get(factsSlug);
  if (cached !== undefined) return cached;
  const content = legacyAssetContent(identity, "centerline");
  if (!content) {
    outlineCache.set(factsSlug, null);
    return null;
  }
  try {
    const points = content
      .split(/\r?\n/)
      .slice(1)
      .filter(Boolean)
      .map((line) => {
        const [x, z] = line.split(",").map(Number);
        return { x, z };
      });
    const result = points.length > 10 ? points : null;
    outlineCache.set(factsSlug, result);
    return result;
  } catch {
    outlineCache.set(factsSlug, null);
    return null;
  }
}

export function loadLegacyOutlineByOrdinal(ordinal: number, gameId: string): Point[] | null {
  const identity = getTrackAssetIdentity(gameId, ordinal);
  return identity ? loadOutline(identity) : null;
}

function loadBoundary(identity: TrackAssetIdentity): LegacyBoundaryData | null {
  const factsSlug = identity.factsSlug;
  if (!factsSlug) return null;
  const cached = boundaryCache.get(factsSlug);
  if (cached !== undefined) return cached;
  const content = legacyAssetContent(identity, "boundaries");
  if (!content) {
    boundaryCache.set(factsSlug, null);
    return null;
  }
  try {
    const parsed = JSON.parse(content) as Partial<LegacyBoundaryData>;
    const result = Array.isArray(parsed.leftEdge) && Array.isArray(parsed.rightEdge) ? { ...parsed, leftEdge: parsed.leftEdge, rightEdge: parsed.rightEdge, pitLane: parsed.pitLane ?? null } : null;
    boundaryCache.set(factsSlug, result);
    return result;
  } catch {
    boundaryCache.set(factsSlug, null);
    return null;
  }
}

export function loadLegacyBoundaryByOrdinal(ordinal: number, gameId: string): LegacyBoundaryData | null {
  const identity = getTrackAssetIdentity(gameId, ordinal);
  return identity ? loadBoundary(identity) : null;
}
