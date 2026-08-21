import { filterOutlierPoints } from "./points";
import { loadLegacyBoundaryByOrdinal, loadLegacyOutlineByOrdinal } from "./legacy";
import type { Point, TrackBoundary } from "./types";
import { getTrackAssetIdentity } from "../storage/assets";
import { ttlCache } from "../storage/cache";

const outlineCache = ttlCache<Point[]>();
const boundaryCache = ttlCache<TrackBoundary>();

function projectGpsToMeters(points: Point[]): Point[] {
  if (points.length === 0) return points;
  let refLat = 0;
  let refLon = 0;
  for (const point of points) {
    refLon += point.x;
    refLat += point.z;
  }
  refLon /= points.length;
  refLat /= points.length;
  const latitudeRadians = (refLat * Math.PI) / 180;
  const metersPerDegreeLatitude = 111320;
  const metersPerDegreeLongitude = 111320 * Math.cos(latitudeRadians);
  return points.map((point) => ({
    x: (point.x - refLon) * metersPerDegreeLongitude,
    z: (point.z - refLat) * metersPerDegreeLatitude,
  }));
}

function normalizeLegacyOutline(factsSlug: string, data: Point[]): Point[] {
  if (outlineCache.has(factsSlug)) return outlineCache.get(factsSlug)!;
  let outline = data;
  const sample = outline.slice(0, 5);
  if (sample.length > 0 && sample.every((point) => Math.abs(point.x) < 200 && Math.abs(point.z) < 100)) {
    outline = projectGpsToMeters(outline);
  }
  if (outline.length > 1) outline = [outline[0], ...outline.slice(1).reverse()];
  outline = filterOutlierPoints(outline);
  outlineCache.set(factsSlug, outline);
  return outline;
}

/** Get the legacy baseline outline assigned to a Forza track ordinal. */
export function getBundledOutlineByOrdinal(ordinal: number): Point[] | null {
  const identity = getTrackAssetIdentity("fm-2023", ordinal);
  if (!identity?.factsSlug) return null;
  const raw = loadLegacyOutlineByOrdinal(ordinal, "fm-2023");
  return raw ? normalizeLegacyOutline(identity.factsSlug, raw) : null;
}

/** Get registry facts slug for a Forza track ordinal. */
export function getForzaSharedOutline(ordinal: number): string | undefined {
  return getTrackAssetIdentity("fm-2023", ordinal)?.factsSlug ?? undefined;
}
export function loadBoundaryByOrdinal(ordinal: number): TrackBoundary | null {
  const identity = getTrackAssetIdentity("fm-2023", ordinal);
  const factsSlug = identity?.factsSlug;
  if (!factsSlug) return null;
  if (boundaryCache.has(factsSlug)) return boundaryCache.get(factsSlug)!;
  const data = loadLegacyBoundaryByOrdinal(ordinal, "fm-2023");
  if (!data?.leftEdge || !data.rightEdge) return null;
  const boundary: TrackBoundary = {
    ...data,
    leftEdge: data.leftEdge.length > 1 ? [data.leftEdge[0], ...data.leftEdge.slice(1).reverse()] : data.leftEdge,
    rightEdge: data.rightEdge.length > 1 ? [data.rightEdge[0], ...data.rightEdge.slice(1).reverse()] : data.rightEdge,
    pitLane: data.pitLane?.length ? [data.pitLane[0], ...data.pitLane.slice(1).reverse()] : data.pitLane,
  };
  boundaryCache.set(factsSlug, boundary);
  return boundary;
}

export function hasBundledOutlineByOrdinal(ordinal: number): boolean {
  return getBundledOutlineByOrdinal(ordinal) !== null;
}

export function hasBundledBoundaryByOrdinal(ordinal: number): boolean {
  const identity = getTrackAssetIdentity("fm-2023", ordinal);
  return Boolean(identity?.factsSlug && loadLegacyBoundaryByOrdinal(ordinal, "fm-2023"));
}
