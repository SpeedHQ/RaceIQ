import { applyAlignment, computeAlignment } from "@raceiq/shared/racing/tracks/geometry/points";
import type { Point, TrackMapBoundaries } from "./types";

type Alignment = Parameters<typeof applyAlignment>[1];

const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.z - b.z);

function cleanLap(points: readonly Point[]): Point[] {
  const result: Point[] = [];
  for (const point of points) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.z)) continue;
    if (!result.length || distance(point, result[result.length - 1]) > 0.5) result.push(point);
  }
  if (result.length < 20) return [];
  const gaps: number[] = [];
  for (let i = 1; i < result.length; i++) gaps.push(distance(result[i - 1], result[i]));
  const sorted = [...gaps].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const threshold = Math.max(30, median * 8);
  const filtered: Point[] = [result[0]];
  for (let i = 1; i < result.length; i++) {
    if (distance(filtered[filtered.length - 1], result[i]) <= threshold) {
      filtered.push(result[i]);
    } else if (i + 1 < result.length && distance(result[i], result[i + 1]) <= threshold) {
      // Skip isolated teleport, then resume at the following spatial sample.
      filtered.push(result[i + 1]);
      i++;
    }
  }
  const lapLength = filtered.reduce((sum, point, i) => sum + (i ? distance(filtered[i - 1], point) : 0), 0);
  const extent = Math.max(...filtered.map(p => p.x)) - Math.min(...filtered.map(p => p.x)) + Math.max(...filtered.map(p => p.z)) - Math.min(...filtered.map(p => p.z));
  return lapLength > 100 && extent > 5 ? filtered : [];
}
function length(points: readonly Point[]): number {
  return points.reduce((sum, point, i) => sum + (i ? distance(points[i - 1], point) : 0), 0);
}

function atDistance(points: readonly Point[], dist: number): Point {
  let walked = 0;
  for (let i = 1; i < points.length; i++) {
    const segment = distance(points[i - 1], points[i]);
    if (walked + segment >= dist) {
      const t = segment ? (dist - walked) / segment : 0;
      return { x: points[i - 1].x + (points[i].x - points[i - 1].x) * t, z: points[i - 1].z + (points[i].z - points[i - 1].z) * t };
    }
    walked += segment;
  }
  return points[points.length - 1];
}

function apply(boundaries: TrackMapBoundaries, alignment: Alignment): TrackMapBoundaries {
  const transform = (points: Point[]) => points.map(point => applyAlignment(point, alignment));
  return { ...boundaries, leftEdge: transform(boundaries.leftEdge), rightEdge: transform(boundaries.rightEdge), centerLine: transform(boundaries.centerLine), raceLine: boundaries.raceLine ? transform(boundaries.raceLine) : boundaries.raceLine, pitLane: boundaries.pitLane ? transform(boundaries.pitLane) : null, additionalSections: boundaries.additionalSections?.map(section => ({ leftEdge: transform(section.leftEdge), rightEdge: transform(section.rightEdge) })) };
}

/** Align circuit geometry once from robust, spatially sampled evidence across a session's laps. */
export function alignTrackBoundariesToSession(boundaries: TrackMapBoundaries | null, laps: readonly (readonly Point[])[]): TrackMapBoundaries | null {
  if (!boundaries || boundaries.centerLine.length < 20) return boundaries;
  const trackLength = length(boundaries.centerLine);
  if (!Number.isFinite(trackLength) || trackLength <= 0) return boundaries;
  const usable = laps.map(cleanLap).filter(lap => lap.length >= 20);
  const complete = usable.filter(lap => length(lap) / trackLength >= 0.7);
  if (!complete.length) return boundaries;
  complete.sort((a, b) => length(b) - length(a));
  const source = Array.from({ length: 100 }, (_, i) => atDistance(boundaries.centerLine, trackLength * i / 100));
  let initial: Alignment | null = null;
  let seed: Point[] | null = null;
  let bestResidual = Infinity;
  for (const lap of complete) {
    const lapLength = length(lap);
    const samples = Array.from({ length: 100 }, (_, i) => atDistance(lap, lapLength * i / 100));
    const candidate = computeAlignment(boundaries.centerLine, samples);
    if (!candidate || !Number.isFinite(candidate.scale) || candidate.scale < 0.85 || candidate.scale > 1.15) continue;
    const mapped = source.map(point => applyAlignment(point, candidate));
    const residuals = mapped.map(point => Math.min(...samples.map(sample => distance(point, sample)))).sort((a, b) => a - b);
    const residual = residuals[Math.floor(residuals.length / 2)];
    if (residual < bestResidual) {
      bestResidual = residual;
      initial = candidate;
      seed = lap;
    }
  }
  if (!initial || !seed || bestResidual > Math.max(40, trackLength * 0.08)) return boundaries;
  const reference = source.map(point => applyAlignment(point, initial));
  const lapBins: Point[][] = [];
  const median = (values: number[]) => {
    values.sort((a, b) => a - b);
    return values[Math.floor(values.length / 2)];
  };
  for (const lap of usable) {
    const lapLength = length(lap);
    const sampleCount = Math.max(20, Math.min(500, Math.ceil(lapLength / 5)));
    const bins: Point[][] = Array.from({ length: 100 }, () => []);
    for (let i = 0; i < sampleCount; i++) {
      const point = atDistance(lap, lapLength * i / sampleCount);
      let nearest = 0;
      let nearestDistance = Infinity;
      for (let bin = 0; bin < reference.length; bin++) {
        const candidateDistance = distance(point, reference[bin]);
        if (candidateDistance < nearestDistance) {
          nearest = bin;
          nearestDistance = candidateDistance;
        }
      }
      if (nearestDistance <= 75) bins[nearest].push(point);
    }
    lapBins.push(bins.map(points => {
      if (!points.length) return { x: NaN, z: NaN };
      return { x: median(points.map(point => point.x)), z: median(points.map(point => point.z)) };
    }));
  }
  const target: Point[] = [];
  for (let bin = 0; bin < 100; bin++) {
    const evidence = lapBins.map(lap => lap[bin]).filter(point => Number.isFinite(point.x) && Number.isFinite(point.z));
    if (!evidence.length) {
      target.push(reference[bin]);
    } else {
      target.push({ x: median(evidence.map(point => point.x)), z: median(evidence.map(point => point.z)) });
    }
  }
  const alignment = computeAlignment(source, target);
  if (!alignment || !Number.isFinite(alignment.scale) || alignment.scale < 0.85 || alignment.scale > 1.15) return boundaries;
  const aligned = source.map(point => applyAlignment(point, alignment));
  const rms = Math.sqrt(aligned.reduce((sum, point, i) => sum + distance(point, target[i]) ** 2, 0) / aligned.length);
  if (!Number.isFinite(rms) || rms > Math.max(40, trackLength * 0.08)) return boundaries;
  return apply(boundaries, alignment);
}
