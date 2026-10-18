import { applyAlignment, computeAlignment } from "@raceiq/shared/racing/tracks/geometry/points";
import { createLapFractionProjector } from "@raceiq/shared/racing/tracks/path";
import { geographicPosition } from "../../wireframe/ScenePlacement";
import { semanticNumber, type Point, type SemanticAnalysisFrame, type TrackMapBoundaries, type TrackMapProps } from "./types";

const fresh = (frame: SemanticAnalysisFrame, id: string) => {
  const state = frame.states[id];
  const freshness = frame.freshness[id];
  return (state === undefined || state === "ok") && (freshness === undefined || freshness === "fresh")
    ? semanticNumber(frame, id as never)
    : null;
};

export function resolveTrackPositions(telemetry: SemanticAnalysisFrame[], outline: Point[] | null, gameId?: string): Point[] {
  if (gameId === "iracing") {
    const valid = telemetry.map((frame) => {
      const latitude = fresh(frame, "motion.latitude");
      const longitude = fresh(frame, "motion.longitude");
      return latitude !== null && longitude !== null && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180 && !(latitude === 0 && longitude === 0)
        ? { latitude, longitude }
        : null;
    });
    const originSample = telemetry.find((frame) => {
      const latitude = fresh(frame, "identity.track.latitude");
      const longitude = fresh(frame, "identity.track.longitude");
      return latitude !== null && longitude !== null && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180 && !(latitude === 0 && longitude === 0);
    });
    const origin = originSample
      ? { latitude: fresh(originSample, "identity.track.latitude")!, longitude: fresh(originSample, "identity.track.longitude")! }
      : valid.find((sample) => sample !== null);
    if (origin && valid.some((sample) => sample !== null)) return valid.map((sample) => sample ? geographicPosition(sample.latitude, sample.longitude, origin.latitude, origin.longitude) : { x: NaN, z: NaN });
  }
  const worldPositions = telemetry.map((frame) => ({
    x: semanticNumber(frame, "motion.position-x") ?? 0,
    z: semanticNumber(frame, "motion.position-z") ?? 0,
  }));
  if (worldPositions.some((point) => point.x !== 0 || point.z !== 0) || !outline || outline.length < 2) return worldPositions;

  const fractions = telemetry.map((frame) => semanticNumber(frame, "timing.lap-fraction"));
  if (fractions.some((fraction) => fraction === null)) return worldPositions;

  const project = createLapFractionProjector(outline);
  if (!project) return worldPositions;
  return fractions.map((fraction, index) => {
    const pose = project(fraction!);
    return pose ? { x: pose.x, z: pose.z } : worldPositions[index];
  });
}
export function alignOfficialReferenceToPositions(
  reference: Pick<TrackMapProps, "outline" | "mapLabels" | "pitLines" | "boundaries">,
  positions: Point[],
): typeof reference {
  const points = reference.outline ?? reference.boundaries?.centerLine;
  const target = positions.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.z));
  const alignment = points && points.length >= 5 && target.length >= 5 ? computeAlignment(points, target) : null;
  if (!alignment) return { outline: null, mapLabels: null, pitLines: null, boundaries: null };
  const align = (points: Point[]) => points.map((point) => applyAlignment(point, alignment));
  const boundaries = reference.boundaries;
  return {
    outline: reference.outline ? align(reference.outline) : null,
    mapLabels: reference.mapLabels?.map((label) => ({ ...label, ...applyAlignment(label, alignment) })),
    pitLines: reference.pitLines?.map((line) => ({ ...line, points: align(line.points) })),
    boundaries: boundaries ? {
      ...boundaries,
      leftEdge: align(boundaries.leftEdge),
      rightEdge: align(boundaries.rightEdge),
      centerLine: align(boundaries.centerLine),
      raceLine: boundaries.raceLine ? align(boundaries.raceLine) : boundaries.raceLine,
      pitLane: boundaries.pitLane ? align(boundaries.pitLane) : null,
      additionalSections: boundaries.additionalSections?.map((section) => ({
        leftEdge: align(section.leftEdge), rightEdge: align(section.rightEdge),
      })),
    } : null,
  };
}

export function alignTrackBoundariesToPositions(
  boundaries: TrackMapBoundaries | null,
  positions: Point[],
): TrackMapBoundaries | null {
  if (!boundaries || boundaries.centerLine.length < 20) return boundaries;
  const target = positions.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.z));
  if (
    target.length < 20
    || !target.some((point) => point.x !== target[0].x || point.z !== target[0].z)
  ) {
    return boundaries;
  }
  const alignment = computeAlignment(boundaries.centerLine, target);
  if (!alignment) return boundaries;
  const align = (points: Point[]) => points.map((point) => applyAlignment(point, alignment));
  return {
    ...boundaries,
    leftEdge: align(boundaries.leftEdge),
    rightEdge: align(boundaries.rightEdge),
    centerLine: align(boundaries.centerLine),
    raceLine: boundaries.raceLine ? align(boundaries.raceLine) : boundaries.raceLine,
    pitLane: boundaries.pitLane ? align(boundaries.pitLane) : null,
  };
}



export function projectPointOntoPath(point: Point, path: readonly Point[]): Point | null {
  if (path.length < 2) return null;
  let bestDistance = Number.POSITIVE_INFINITY;
  let bestPoint: Point | null = null;
  for (let index = 1; index < path.length; index++) {
    const start = path[index - 1];
    const end = path[index];
    const dx = end.x - start.x;
    const dz = end.z - start.z;
    const lengthSquared = dx * dx + dz * dz;
    const amount = lengthSquared > 1e-12 ? Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.z - start.z) * dz) / lengthSquared)) : 0;
    const projected = { x: start.x + dx * amount, z: start.z + dz * amount };
    const distance = (point.x - projected.x) ** 2 + (point.z - projected.z) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      bestPoint = projected;
    }
  }
  return bestPoint;
}

export function pathForwardOffsets(points: readonly Point[]): ([number, number] | null)[] {
  const segments: ([number, number] | null)[] = Array(Math.max(0, points.length - 1)).fill(null);
  for (let index = 0; index < segments.length; index++) {
    const dx = points[index + 1].x - points[index].x;
    const dz = points[index + 1].z - points[index].z;
    const length = Math.hypot(dx, dz);
    if (length > 1e-6) segments[index] = [dx / length, dz / length];
  }

  const before: ([number, number] | null)[] = Array(points.length).fill(null);
  let lastDirection: [number, number] | null = null;
  for (let index = 0; index < points.length; index++) {
    if (index > 0 && segments[index - 1]) lastDirection = segments[index - 1];
    before[index] = lastDirection;
  }

  const directions: ([number, number] | null)[] = Array(points.length).fill(null);
  let nextDirection: [number, number] | null = null;
  for (let index = points.length - 1; index >= 0; index--) {
    if (index < segments.length && segments[index]) nextDirection = segments[index];
    const previousDirection = before[index];
    if (!previousDirection) {
      directions[index] = nextDirection;
      continue;
    }
    if (!nextDirection) {
      directions[index] = previousDirection;
      continue;
    }
    const dx = previousDirection[0] + nextDirection[0];
    const dz = previousDirection[1] + nextDirection[1];
    const length = Math.hypot(dx, dz);
    directions[index] = length > 1e-6 ? [dx / length, dz / length] : nextDirection;
  }
  return directions;
}

export function resolveFrameDirection(frame: SemanticAnalysisFrame, pathDirection: [number, number] | null): [number, number] | null {
  const nativeNorthYaw = semanticNumber(frame, "motion.yaw-north");
  // iRacing replay positions are measured or projected onto the track; use that map-space tangent
  // instead of simulator yaw, whose reference frame does not match projected replay positions.
  if (nativeNorthYaw !== null && pathDirection) return pathDirection;
  const hasGeographicPose = fresh(frame, "motion.latitude") !== null && fresh(frame, "motion.longitude") !== null;
  const yawId = hasGeographicPose ? "motion.yaw-north" : "motion.yaw";
  const yaw = semanticNumber(frame, yawId as never);
  const state = frame.states[yawId];
  const freshness = frame.freshness[yawId];
  if (yaw !== null && (state === undefined || state === "ok") && (freshness === undefined || freshness === "fresh")) {
    return [Math.sin(yaw), Math.cos(yaw)];
  }
  return pathDirection;
}
