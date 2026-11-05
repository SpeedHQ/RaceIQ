import type { SpectateLap } from "../contracts";
import type { DistanceRange } from "./corner-focus";

export type CornerTimeBand = { start: number; end: number };

type ProgressPoint = { time: number; distance: number; run: number };

/**
 * Monotonic distance samples for chart bands. Mirrors the controller's
 * progress index: first arrival wins and distance regressions are ignored.
 */
function progressPoints(lap: SpectateLap): ProgressPoint[] {
  const points: ProgressPoint[] = [];
  for (const sample of lap.motionSamples ?? lap.samples) {
    if (!Number.isFinite(sample.distance)) continue;
    const previous = points.at(-1);
    if (previous && (sample.time <= previous.time || sample.distance < previous.distance)) continue;
    points.push({ time: sample.time, distance: sample.distance, run: sample.run });
  }
  return points;
}

function arrivalAt(points: readonly ProgressPoint[], target: number): number | null {
  const first = points[0];
  const last = points.at(-1);
  if (!first || !last) return null;
  if (target <= first.distance) return first.time;
  if (target >= last.distance) return last.time;
  let low = 0;
  let high = points.length - 1;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (points[middle]!.distance < target) low = middle + 1;
    else high = middle;
  }
  const right = points[low]!;
  if (right.distance === target) return right.time;
  const left = points[low - 1];
  if (!left || left.run !== right.run) return null;
  const span = right.distance - left.distance;
  if (!(span > 0)) return left.time;
  return left.time + ((right.time - left.time) * (target - left.distance)) / span;
}

/** Map a replay distance range to the recorded time interval used by charts. */
export function distanceRangeToTimeRange(lap: SpectateLap, range: DistanceRange): CornerTimeBand | null {
  if (!(range.end > range.start)) return null;
  const points = progressPoints(lap);
  const start = arrivalAt(points, range.start);
  const end = arrivalAt(points, range.end);
  if (start === null || end === null || !(end > start)) return null;
  return { start, end };
}
