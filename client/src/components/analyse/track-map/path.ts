import { lapPath } from "@shared/racing/tracks/path";
import type { TelemetryPacket } from "../../../../../shared/telemetry/types";
import type { Point } from "./types";

export function resolveTrackPositions(telemetry: TelemetryPacket[], outline: Point[] | null): Point[] {
  const path = lapPath(telemetry, outline);
  return telemetry.map((_, index) => ({ x: path.x[index], z: path.z[index] }));
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
