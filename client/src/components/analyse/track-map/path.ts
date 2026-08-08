import type { Point, SemanticAnalysisFrame } from "./types";

const number = (frame: SemanticAnalysisFrame, id: string) => {
  const value = frame.values[id];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

export function resolveTrackPositions(telemetry: SemanticAnalysisFrame[], _outline: Point[] | null): Point[] {
  return telemetry.map((frame) => ({ x: number(frame, "motion.position-x") ?? 0, z: number(frame, "motion.position-z") ?? 0 }));
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
