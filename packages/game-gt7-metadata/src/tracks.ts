import signaturesJson from "./track-signatures.json";
import tracksJson from "./tracks.json";

export interface GT7TrackLapSignature {
  lengthM: number;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  points: readonly (readonly [number, number])[];
}

interface TrackSignature {
  id: string;
  name: string;
  lengthM: number;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  path: readonly (readonly [number, number])[];
  reverseId: string | null;
  reverseName: string | null;
}
const signatures = signaturesJson.signatures as unknown as readonly TrackSignature[];
const trackNameById = new Map(tracksJson.tracks.map((track) => [track.id, track.name]));

export function gt7TrackName(id: string): string | undefined {
  return trackNameById.get(id);
}

function withinRatio(actual: number, expected: number, tolerance: number): boolean {
  return expected > 0 && Math.abs(actual - expected) / expected <= tolerance;
}

function nearestPathIndex(point: readonly [number, number], path: TrackSignature["path"]): number {
  let nearest = -1;
  let nearestDistanceSquared = Number.POSITIVE_INFINITY;
  for (let index = 0; index < path.length; index++) {
    const candidate = path[index]!;
    const dx = point[0] - candidate[0]!;
    const dz = point[1] - candidate[1]!;
    const distanceSquared = dx * dx + dz * dz;
    if (distanceSquared < nearestDistanceSquared) {
      nearest = index;
      nearestDistanceSquared = distanceSquared;
    }
  }
  return nearestDistanceSquared <= 40 * 40 ? nearest : -1;
}

function pathCoverage(points: GT7TrackLapSignature["points"], path: TrackSignature["path"]): number {
  if (points.length === 0 || path.length === 0) return 0;
  let matched = 0;
  for (const point of points) if (nearestPathIndex(point, path) >= 0) matched++;
  return matched / points.length;
}

/** Return direction confidence: positive means signature order, negative means reverse. */
function pathDirection(points: GT7TrackLapSignature["points"], path: TrackSignature["path"]): number {
  const indexes: number[] = [];
  for (const point of points) {
    const index = nearestPathIndex(point, path);
    if (index >= 0) indexes.push(index);
  }
  let forward = 0;
  let reverse = 0;
  for (let i = 1; i < indexes.length; i++) {
    let delta = indexes[i]! - indexes[i - 1]!;
    if (delta > path.length / 2) delta -= path.length;
    else if (delta < -path.length / 2) delta += path.length;
    if (delta > 0) forward++;
    else if (delta < 0) reverse++;
  }
  const total = forward + reverse;
  return total === 0 ? 0 : (forward - reverse) / total;
}

/**
 * Identify one complete lap using GT7 world position and shipped racing lines.
 * Integrated length breaks ties because rollout and packet timing can skew it.
 * Ambiguous or weak matches stay unnamed.
 */
export function identifyGT7Track(lap: GT7TrackLapSignature): string | null {
  if (!Number.isFinite(lap.lengthM) || lap.lengthM <= 0 || lap.points.length < 20) return null;
  const width = lap.maxX - lap.minX;
  const depth = lap.maxZ - lap.minZ;
  if (width <= 0 || depth <= 0) return null;
  const centerX = (lap.minX + lap.maxX) / 2;
  const centerZ = (lap.minZ + lap.maxZ) / 2;
  const candidates = signatures.filter((signature) => {
    if (Math.abs(centerX - (signature.minX + signature.maxX) / 2) > 120 ||
        Math.abs(centerZ - (signature.minZ + signature.maxZ) / 2) > 120) return false;
    return withinRatio(width, signature.maxX - signature.minX, 0.2) &&
      withinRatio(depth, signature.maxZ - signature.minZ, 0.2);
  });
  if (candidates.length === 0) return null;
  const ranked = candidates
    .map((signature) => ({
      signature,
      coverage: pathCoverage(lap.points, signature.path),
      lengthError: Math.abs(lap.lengthM - signature.lengthM) / signature.lengthM,
    }))
    .sort((a, b) => b.coverage - a.coverage || a.lengthError - b.lengthError);
  const best = ranked[0]!;
  if (best.coverage < 0.6 || (ranked[1] && best.coverage - ranked[1].coverage < 0.25)) return null;
  const direction = pathDirection(lap.points, best.signature.path);
  if (direction < -0.5) return best.signature.reverseId;
  if (direction > 0.5) return best.signature.id;
  return null;
}
