import type { GameId } from "@shared/games/ids";
import { applyAlignment, computeAlignment } from "@shared/racing/tracks/geometry/points";
import type { Point, SemanticAnalysisFrame } from "./types";
const ALIGNMENT_SAMPLE_LIMIT = 240;

const number = (frame: SemanticAnalysisFrame, id: keyof SemanticAnalysisFrame["values"]) => {
  const value = frame.values[id];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

const worldPosition = (frame: SemanticAnalysisFrame): Point => ({
  x: number(frame, "motion.position-x") ?? 0,
  z: number(frame, "motion.position-z") ?? 0,
});

export function resolveTrackPositions(telemetry: SemanticAnalysisFrame[], outline: Point[] | null, gameId?: GameId): Point[] {
  const positions = telemetry.map(worldPosition);
  if (!outline || outline.length < 2) return positions;

  let nonZeroCount = 0;
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (const point of positions) {
    if (point.x !== 0 || point.z !== 0) nonZeroCount++;
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minZ = Math.min(minZ, point.z);
    maxZ = Math.max(maxZ, point.z);
  }

  if (nonZeroCount === 0) {
    const fractions = telemetry.map((frame) => number(frame, "timing.lap-fraction"));
    if (fractions.some((fraction) => fraction === null)) return positions;

    const cumulative = [0];
    for (let index = 1; index < outline.length; index++) {
      cumulative.push(cumulative[index - 1] + Math.hypot(outline[index].x - outline[index - 1].x, outline[index].z - outline[index - 1].z));
    }
    const total = cumulative.at(-1) ?? 0;
    if (total <= 0) return positions;

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

  if (gameId !== "iracing" || outline.length < 5 || nonZeroCount < 5) return positions;
  if (Math.hypot(maxX - minX, maxZ - minZ) < 10) return positions;

  const alignmentSource =
    positions.length <= ALIGNMENT_SAMPLE_LIMIT
      ? positions
      : Array.from({ length: ALIGNMENT_SAMPLE_LIMIT }, (_, index) => positions[Math.round((index * (positions.length - 1)) / (ALIGNMENT_SAMPLE_LIMIT - 1))]);
  const alignment = computeAlignment(alignmentSource, outline);
  return alignment ? positions.map((point) => applyAlignment(point, alignment)) : positions;
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
