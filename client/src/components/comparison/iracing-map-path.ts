import type { IRacingTrackMapTelemetry } from "@/hooks/laps";
import { createLapFractionProjector } from "@raceiq/shared/racing/tracks/path";
import { geographicPosition } from "../wireframe/ScenePlacement";
import type { Point } from "../analyse/track-map/types";

type GeographicOrigin = { latitude: number; longitude: number };
type Replay = IRacingTrackMapTelemetry | undefined;

type GeographicPosition = { latitude: number | null; longitude: number | null };

function validGeographicPosition(position: GeographicPosition): position is { latitude: number; longitude: number } {
  return position.latitude !== null && position.longitude !== null
    && Math.abs(position.latitude) <= 90 && Math.abs(position.longitude) <= 180
    && !(position.latitude === 0 && position.longitude === 0);
}

function geographicOrigin(replays: readonly Replay[]): GeographicOrigin | null {
  for (const replay of replays) {
    const origin = replay?.trackOrigin;
    if (origin && validGeographicPosition(origin)) return origin;
  }
  for (const replay of replays) {
    const sample = replay?.samples.find(validGeographicPosition);
    if (sample?.latitude != null && sample.longitude != null) return { latitude: sample.latitude, longitude: sample.longitude };
  }
  return null;
}

interface ProgressPoint {
  progress: number;
  point: Point | null;
}

function progressPoints(replay: IRacingTrackMapTelemetry, origin: GeographicOrigin): ProgressPoint[] | null {
  if (replay.samples.length < 5) return null;
  const result: ProgressPoint[] = [];
  let offset = 0;
  let previousRaw: number | null = null;
  let previousProgress = Number.NEGATIVE_INFINITY;
  let measuredCount = 0;
  for (const sample of replay.samples) {
    const point = validGeographicPosition(sample)
      ? geographicPosition(sample.latitude, sample.longitude, origin.latitude, origin.longitude)
      : null;
    if (point) measuredCount++;
    const rawFraction = sample.fraction;
    if (rawFraction === null || !Number.isFinite(rawFraction) || rawFraction < 0 || rawFraction > 1) continue;
    if (previousRaw !== null && rawFraction + offset < previousProgress - 0.5) offset += 1;
    const progress = Math.max(previousProgress, rawFraction + offset);
    previousRaw = rawFraction;
    previousProgress = progress;
    result.push({ progress, point });
  }
  if (measuredCount < 5 || result.length < 2 || !(result.at(-1)!.progress > result[0]!.progress)) return null;
  const first = result[0]!.progress;
  const span = result.at(-1)!.progress - first;
  return result.map((item) => ({ ...item, progress: (item.progress - first) / span }));
}

function sampleProgressPath(source: ProgressPoint[], distances: readonly number[]): (Point | null)[] | null {
  const start = distances[0];
  const end = distances.at(-1);
  if (start === undefined || end === undefined || !Number.isFinite(start) || !Number.isFinite(end) || !(end > start)) return null;
  const path: (Point | null)[] = [];
  let upper = 0;
  for (const distance of distances) {
    if (!Number.isFinite(distance)) return null;
    const target = Math.max(0, Math.min(1, (distance - start) / (end - start)));
    while (upper < source.length && source[upper]!.progress < target) upper++;
    if (upper === 0) {
      path.push(source[0]!.point);
      continue;
    }
    if (upper >= source.length) {
      path.push(source.at(-1)!.point);
      continue;
    }
    const right = source[upper]!;
    const left = source[upper - 1]!;
    if (right.progress === target) {
      path.push(right.point);
      continue;
    }
    if (!left.point || !right.point) {
      path.push(null);
      continue;
    }
    const amount = (target - left.progress) / (right.progress - left.progress);
    path.push({
      x: left.point.x + (right.point.x - left.point.x) * amount,
      z: left.point.z + (right.point.z - left.point.z) * amount,
    });
  }
  return path.filter((point) => point !== null).length >= 5 ? path : null;
}

/** Project iRacing GPS replay positions onto the shared comparison distance grid. */
export function buildIRacingMeasuredMapPaths(
  replays: readonly Replay[],
  distances: readonly number[],
): ((Point | null)[] | null)[] {
  const origin = geographicOrigin(replays);
  if (!origin) return replays.map(() => null);
  return replays.map((replay) => {
    if (!replay) return null;
    const source = progressPoints(replay, origin);
    return source ? sampleProgressPath(source, distances) : null;
  });
}

/** iRacing's live SDK supplies lap progress, not world positions; map it onto official track geometry. */
export function projectIRacingDistanceToOutline(distances: readonly number[], outline: readonly Point[]): (Point | null)[] | null {
  const start = distances[0];
  const end = distances.at(-1);
  const project = createLapFractionProjector(outline);
  if (!project || start === undefined || end === undefined || !Number.isFinite(start) || !Number.isFinite(end) || !(end > start)) return null;
  return distances.map((distance) => {
    if (!Number.isFinite(distance)) return null;
    const fraction = Math.max(0, Math.min(1, (distance - start) / (end - start)));
    const pose = project(fraction);
    return pose ? { x: pose.x, z: pose.z } : null;
  });
}
