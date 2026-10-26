import type { GameId } from "@raceiq/shared/games/ids";
import type { TelemetryVariableId } from "@raceiq/shared/telemetry/catalog/generated/telemetry-catalog.types";
import { applyAlignment, computeAlignment } from "@raceiq/shared/racing/tracks/geometry/points";
import { createLapFractionProjector } from "@raceiq/shared/racing/tracks/path";
import { semanticNumber, type SemanticAnalysisFrame } from "@raceiq/scene-3d/semantic-frame";
export interface Point { x: number; z: number }
export interface SceneTrackBoundaries {
  leftEdge: Point[];
  rightEdge: Point[];
  centerLine: Point[];
  raceLine?: Point[] | null;
  pitLane: Point[] | null;
  coordSystem: string;
  additionalSections?: { leftEdge: Point[]; rightEdge: Point[] }[];
}

export interface ScenePose extends Point {
  y?: number;
  yaw: number;
  source: "native" | "lap-fraction" | "measured";
}
export interface TrackProjection {
  points: Point[];
  source: "official-svg";
  units: "m";
  start: "start-finish";
  direction: "forward";
  boundaries?: SceneTrackBoundaries | null;
}
export function alignProjectionToMeasured(projection: TrackProjection | null | undefined, poses: readonly (ScenePose | null)[]): TrackProjection | null {
  if (!projection || projection.points.length < 5) return null;
  const measured = poses.filter((pose): pose is ScenePose => pose?.source === "measured" && Number.isFinite(pose.x) && Number.isFinite(pose.z));
  const alignment = measured.length >= 5 ? computeAlignment(projection.points, measured) : null;
  if (!alignment) return null;
  const align = (points: Point[]) => points.map((point) => applyAlignment(point, alignment));
  const boundaries = projection.boundaries;
  return {
    ...projection,
    points: align(projection.points),
    boundaries: boundaries ? {
      ...boundaries,
      leftEdge: align(boundaries.leftEdge),
      rightEdge: align(boundaries.rightEdge),
      centerLine: align(boundaries.centerLine),
      raceLine: boundaries.raceLine ? align(boundaries.raceLine) : boundaries.raceLine,
      pitLane: boundaries.pitLane ? align(boundaries.pitLane) : boundaries.pitLane,
      additionalSections: boundaries.additionalSections?.map((section) => ({ leftEdge: align(section.leftEdge), rightEdge: align(section.rightEdge) })),
    } : null,
  };
}

const validGeo = (latitude: number | null, longitude: number | null) =>
  latitude !== null && longitude !== null && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180 && !(latitude === 0 && longitude === 0);

export function geographicPosition(latitude: number, longitude: number, originLatitude: number, originLongitude: number): Point {
  const radians = Math.PI / 180;
  return {
    x: (longitude - originLongitude) * radians * 6_378_137 * Math.cos(originLatitude * radians),
    z: (latitude - originLatitude) * radians * 6_378_137,
  };
}

function supportedNumber(frame: SemanticAnalysisFrame, id: TelemetryVariableId): number | null {
  const state = frame.states[id];
  const freshness = frame.freshness[id];
  return (state === undefined || state === "ok") && (freshness === undefined || freshness === "fresh") ? semanticNumber(frame, id) : null;
}

/** Visualization only: never publish derived geometry as native position or racing line. */
export function resolveScenePoses(gameId: GameId, frames: SemanticAnalysisFrame[], projection?: TrackProjection | null): (ScenePose | null)[] {
  const project = gameId === "iracing" && projection?.units === "m" && projection.start === "start-finish" && projection.direction === "forward"
    ? createLapFractionProjector(projection.points) : null;
  const measured = gameId === "iracing" && frames.some((frame) => validGeo(supportedNumber(frame, "motion.latitude"), supportedNumber(frame, "motion.longitude")));
  const originSample = frames.find((frame) => validGeo(
    supportedNumber(frame, "identity.track.latitude"),
    supportedNumber(frame, "identity.track.longitude"),
  ));
  const origin = measured
    ? originSample
      ? { latitude: supportedNumber(originSample, "identity.track.latitude")!, longitude: supportedNumber(originSample, "identity.track.longitude")! }
      : frames.map((frame) => ({ latitude: supportedNumber(frame, "motion.latitude"), longitude: supportedNumber(frame, "motion.longitude") }))
        .find((sample) => validGeo(sample.latitude, sample.longitude)) as { latitude: number; longitude: number }
    : null;
  const altitudeOriginFrame = originSample ?? frames.find((frame) => validGeo(
    supportedNumber(frame, "motion.latitude"),
    supportedNumber(frame, "motion.longitude"),
  ) && supportedNumber(frame, "motion.altitude") !== null);
  const altitudeOrigin = altitudeOriginFrame
    ? supportedNumber(altitudeOriginFrame, "identity.track.altitude") ?? supportedNumber(altitudeOriginFrame, "motion.altitude")
    : null;
  const positions = measured
    ? frames.map((frame) => {
        const latitude = supportedNumber(frame, "motion.latitude");
        const longitude = supportedNumber(frame, "motion.longitude");
        return validGeo(latitude, longitude) && origin
          ? geographicPosition(latitude!, longitude!, origin.latitude, origin.longitude)
          : null;
      })
    : [];
  const measuredHeading = (index: number): number => {
    const recorded = supportedNumber(frames[index]!, "motion.yaw-north");
    if (recorded !== null) return recorded;
    const current = positions[index];
    if (!current) return 0;
    const next = positions[index + 1];
    const previous = positions[index - 1];
    const nextDx = next ? next.x - current.x : 0;
    const nextDz = next ? next.z - current.z : 0;
    const dx = next && (nextDx !== 0 || nextDz !== 0)
      ? nextDx
      : previous ? current.x - previous.x : 0;
    const dz = next && (nextDx !== 0 || nextDz !== 0)
      ? nextDz
      : previous ? current.z - previous.z : 0;
    return dx !== 0 || dz !== 0 ? Math.atan2(dx, dz) : 0;
  };
  return frames.map((frame, index) => {
    if (measured) {
      const position = positions[index];
      if (!position) return null;
      const altitude = supportedNumber(frame, "motion.altitude");
      return { ...position, ...(altitude === null || altitudeOrigin === null ? {} : { y: altitude - altitudeOrigin }), yaw: measuredHeading(index), source: "measured" };
    }
    const x = supportedNumber(frame, "motion.position-x");
    const z = supportedNumber(frame, "motion.position-z");
    const yaw = supportedNumber(frame, "motion.yaw");
    if (x !== null && z !== null && yaw !== null) return { x, z, yaw, source: "native" };
    const fraction = supportedNumber(frame, "timing.lap-fraction");
    const pose = fraction !== null ? project?.(fraction) : null;
    return pose ? { ...pose, source: "lap-fraction" } : null;
  });
}

