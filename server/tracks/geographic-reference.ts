import type { GameId } from "../../shared/games/ids";
import { applyAlignment, computeAlignment, trackAlignmentRmse } from "../../shared/racing/tracks/geometry/points";
import { getAllIRacingTracks, getIRacingTrack, type IRacingCatalogTrack } from "../../shared/racing/tracks/catalogs/iracing";
import { geographicTrackImageryPointFromEnu, type TrackImageryGeographicPoint, type TrackImageryPoint } from "../../shared/racing/tracks/imagery";
import { listTrackVenueFamilyConfigurations, loadCanonicalTrackPeer } from "./configuration";
import { resolveTrackSharedName } from "./identity";

export type TrackGeographicReferenceMatch = "game-id" | "assigned-identity" | "venue-identity" | "shared-name";

export interface ResolvedTrackGeographicCatalogSource {
  track: IRacingCatalogTrack;
  match: TrackGeographicReferenceMatch;
}

const MIN_ALIGNMENT_SCALE = 0.2;
const MAX_ALIGNMENT_SCALE = 5;
const MAX_ALIGNMENT_RMSE_M = 25;

function hasGeographicLocation(track: IRacingCatalogTrack | undefined): track is IRacingCatalogTrack {
  return (
    !!track &&
    Number.isFinite(track.latitude) &&
    Number.isFinite(track.longitude) &&
    Math.abs(track.latitude) <= 90 &&
    Math.abs(track.longitude) <= 180 &&
    (track.latitude !== 0 || track.longitude !== 0)
  );
}

/** Resolve authoritative venue coordinates from one deterministic iRacing anchor per configured venue path. */
export function resolveTrackGeographicCatalogSource(gameId: GameId, trackOrdinal: number): ResolvedTrackGeographicCatalogSource | null {
  const direct = gameId === "iracing" ? getIRacingTrack(trackOrdinal) : undefined;
  const assignedPeer = loadCanonicalTrackPeer(gameId, trackOrdinal, "iracing");
  const assigned = assignedPeer ? getIRacingTrack(assignedPeer.trackOrdinal) : undefined;

  let venueReference: IRacingCatalogTrack | undefined;
  for (const configuration of listTrackVenueFamilyConfigurations(gameId, trackOrdinal, "iracing")) {
    const candidate = getIRacingTrack(configuration.trackOrdinal);
    if (hasGeographicLocation(candidate)) {
      venueReference = candidate;
      break;
    }
  }

  const exact = hasGeographicLocation(direct) ? direct : hasGeographicLocation(assigned) ? assigned : undefined;
  if (venueReference && venueReference.ordinal !== exact?.ordinal) {
    return { track: venueReference, match: "venue-identity" };
  }
  if (hasGeographicLocation(direct)) return { track: direct, match: "game-id" };
  if (hasGeographicLocation(assigned)) return { track: assigned, match: "assigned-identity" };
  if (venueReference) return { track: venueReference, match: "venue-identity" };

  const sharedName = resolveTrackSharedName(trackOrdinal, gameId)?.trim().toLowerCase();
  if (!sharedName) return null;
  const shared = getAllIRacingTracks()
    .filter((track) => track.commonTrackName.trim().toLowerCase() === sharedName)
    .sort((a, b) => a.ordinal - b.ordinal)
    .find(hasGeographicLocation);
  return shared ? { track: shared, match: "shared-name" } : null;
}

export function alignTrackOutlineToReference(
  target: readonly TrackImageryPoint[],
  reference: readonly TrackImageryPoint[],
): { points: TrackImageryPoint[]; rmseM: number } | null {
  const targetPoints = target.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.z));
  const referencePoints = reference.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.z));
  if (targetPoints.length < 5 || referencePoints.length < 5) return null;

  const alignment = computeAlignment(targetPoints, referencePoints);
  if (!alignment || !Number.isFinite(alignment.scale) || alignment.scale < MIN_ALIGNMENT_SCALE || alignment.scale > MAX_ALIGNMENT_SCALE) return null;
  const rmseM = trackAlignmentRmse(targetPoints, referencePoints, alignment);
  if (!Number.isFinite(rmseM) || rmseM > MAX_ALIGNMENT_RMSE_M) return null;
  return {
    points: targetPoints.map((point) => applyAlignment(point, alignment)),
    rmseM,
  };
}

function closedOutlineLength(points: readonly TrackImageryPoint[]): number {
  let length = 0;
  for (let index = 0; index < points.length; index++) {
    const next = points[(index + 1) % points.length]!;
    const point = points[index]!;
    length += Math.hypot(next.x - point.x, next.z - point.z);
  }
  return length;
}

/** Center and meter-scale one catalog outline around authoritative venue coordinates. */
export function trackGeographicReferencePositions(outline: readonly TrackImageryPoint[] | null, center: TrackImageryGeographicPoint, trackLengthKm: number): TrackImageryGeographicPoint[] {
  let points = (outline ?? []).filter((point) => Number.isFinite(point.x) && Number.isFinite(point.z));
  if (points.length < 3) {
    const halfExtentM = Math.max(500, Math.min(5_000, (Number.isFinite(trackLengthKm) ? trackLengthKm : 0) * 250));
    points = [
      { x: -halfExtentM, z: -halfExtentM },
      { x: halfExtentM, z: -halfExtentM },
      { x: halfExtentM, z: halfExtentM },
      { x: -halfExtentM, z: halfExtentM },
    ];
  }

  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minZ = Math.min(minZ, point.z);
    maxZ = Math.max(maxZ, point.z);
  }
  const centerX = (minX + maxX) / 2;
  const centerZ = (minZ + maxZ) / 2;
  const rawLength = closedOutlineLength(points);
  const expectedLengthM = Number.isFinite(trackLengthKm) && trackLengthKm > 0 ? trackLengthKm * 1_000 : rawLength;
  const scale = rawLength > 0 ? expectedLengthM / rawLength : 1;
  const stride = Math.max(1, Math.ceil(points.length / 1_500));
  const centered = points.filter((_, index) => index % stride === 0).map((point) => ({ x: (point.x - centerX) * scale, z: (point.z - centerZ) * scale }));
  if (centered.length > 0) centered.push(centered[0]!);
  return centered.map((point) => geographicTrackImageryPointFromEnu(point, center.latitudeDeg, center.longitudeDeg));
}
