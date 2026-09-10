import type { Point, SemanticAnalysisFrame } from "./types";

const number = (frame: SemanticAnalysisFrame, id: keyof SemanticAnalysisFrame["values"]) => {
  const value = frame.values[id];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

const worldPosition = (frame: SemanticAnalysisFrame): Point => ({
  x: number(frame, "motion.position-x") ?? 0,
  z: number(frame, "motion.position-z") ?? 0,
});

export function resolveTrackPositions(telemetry: SemanticAnalysisFrame[], outline: Point[] | null): Point[] {
  const worldPositions = telemetry.map(worldPosition);
  if (worldPositions.some((point) => point.x !== 0 || point.z !== 0) || !outline || outline.length < 2) return worldPositions;

  const fractions = telemetry.map((frame) => number(frame, "timing.lap-fraction"));
  if (fractions.some((fraction) => fraction === null)) return worldPositions;

  const cumulative = [0];
  for (let index = 1; index < outline.length; index++) {
    cumulative.push(cumulative[index - 1] + Math.hypot(outline[index].x - outline[index - 1].x, outline[index].z - outline[index - 1].z));
  }
  const total = cumulative.at(-1) ?? 0;
  if (total <= 0) return worldPositions;

  return fractions.map((fraction) => {
    const target = Math.max(0, Math.min(1, fraction!)) * total;
    let low = 1;
    let high = cumulative.length - 1;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (cumulative[middle] < target) low = middle + 1;
      else high = middle;
    }
    const start = Math.max(0, low - 1);
    const segmentLength = cumulative[low] - cumulative[start];
    const amount = segmentLength > 0 ? (target - cumulative[start]) / segmentLength : 0;
    return {
      x: outline[start].x + (outline[low].x - outline[start].x) * amount,
      z: outline[start].z + (outline[low].z - outline[start].z) * amount,
    };
  });
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

export function resolveFrameDirection(
  frame: SemanticAnalysisFrame,
  pathDirection: [number, number] | null,
): [number, number] | null {
  const yaw = number(frame, "motion.yaw");
  const state = frame.states["motion.yaw"];
  const freshness = frame.freshness["motion.yaw"];
  if (yaw !== null && (state === undefined || state === "ok") && (freshness === undefined || freshness === "fresh")) {
    return [Math.sin(yaw), Math.cos(yaw)];
  }
  return pathDirection;
}
