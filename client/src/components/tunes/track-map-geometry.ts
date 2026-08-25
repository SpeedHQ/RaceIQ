import { makeTrackProjection } from "@shared/racing/tracks/projection";
import type { SemanticTuneSample } from "./semantic-tune";

export interface Pt {
  x: number;
  z: number;
}

export interface ProjPt {
  x: number;
  y: number;
  idx: number;
}

export interface SectorTimesLite {
  times: number[];
  boundaryIndices: number[];
}

export interface Geometry {
  allPoints: string;
  segments: string[];
  leftEdge: string | null;
  rightEdge: string | null;
  pts: ProjPt[];
}

export const VIEW = 300;
export const PAD = 14;
export const TARGET_POINTS = 600;

export interface StartMarker {
  x: number;
  y: number;
  tipX: number;
  tipY: number;
  /** Arrowhead triangle, as an SVG `points` string. */
  head: string;
}

/**
 * Start/finish dot + direction arrow for a projected driven line, matching the
 * canvas renderer in `lib/canvas/draw-track.ts` (TrackDetail) so every map —
 * ACC, AC Evo, Forza, F1 — shows the same marker in the same place. The heading
 * is taken ~0.5% of the lap ahead of the start point, i.e. a few meters, so it
 * follows the track rather than a long chord.
 */
export function buildStartMarker(pts: ProjPt[] | null | undefined, arrowLen = 14, wing = 4): StartMarker | null {
  if (!pts || pts.length < 4) return null;
  const s = pts[0];
  const aheadIdx = Math.min(Math.max(2, Math.floor(pts.length * 0.005)), pts.length - 1);
  const a = pts[aheadIdx];
  const dx = a.x - s.x;
  const dy = a.y - s.y;
  const len = Math.hypot(dx, dy);
  if (!(len > 0.5)) return null;
  const nx = dx / len;
  const ny = dy / len;
  const tipX = s.x + nx * arrowLen;
  const tipY = s.y + ny * arrowLen;
  return {
    x: s.x,
    y: s.y,
    tipX,
    tipY,
    head: [`${tipX},${tipY}`, `${tipX - nx * wing * 2 + ny * wing},${tipY - ny * wing * 2 - nx * wing}`, `${tipX - nx * wing * 2 - ny * wing},${tipY - ny * wing * 2 + nx * wing}`].join(" "),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function extractEdges(bounds: any): { left: Pt[]; right: Pt[] } | null {
  if (!bounds || bounds.error) return null;
  const left = bounds.leftEdge;
  const right = bounds.rightEdge;
  if (!Array.isArray(left) || !Array.isArray(right) || left.length < 2 || right.length < 2) return null;
  return { left, right };
}

/**
 * Project a lap's driven line (and optional track edges) into a shared
 * 0..VIEW SVG viewbox, split into source-defined sector polyline segments.
 * Downsamples the driven line to ~TARGET_POINTS while keeping each point's
 * original telemetry index so hover/lookup can find the real frame.
 */
export function buildGeometry(telemetry: SemanticTuneSample[], sectorTimes: SectorTimesLite | null, edges: { left: Pt[]; right: Pt[] } | null): Geometry | null {
  const positioned = telemetry.flatMap((sample, index) => (sample.positionM ? [{ point: sample.positionM, index }] : []));
  if (positioned.length < 10) return null;

  const step = Math.max(1, Math.floor(positioned.length / TARGET_POINTS));
  const line = positioned.filter((_, index) => index % step === 0).map(({ point, index }) => ({ p: point, idx: index }));
  const boundsPoints: Pt[] = line.map((entry) => entry.p);
  if (edges) {
    boundsPoints.push(...edges.left, ...edges.right);
  }
  const projection = makeTrackProjection(boundsPoints, { width: VIEW, height: VIEW, padPx: PAD });
  if (!projection) return null;

  const projectedX = (point: Pt) => projection.project(point).x;
  const projectedY = (point: Pt) => projection.project(point).y;
  const pointString = (point: Pt) => `${projectedX(point).toFixed(1)},${projectedY(point).toFixed(1)}`;
  const polyline = (points: Pt[]) => points.map(pointString).join(" ");
  const projectedPoints: ProjPt[] = line.map((entry) => ({ x: projectedX(entry.p), y: projectedY(entry.p), idx: entry.idx }));
  const drivenLine = line.map((entry) => entry.p);
  const sectorCount = sectorTimes?.times.length && sectorTimes.times.length >= 2 ? sectorTimes.times.length : 3;
  const rawBoundaries =
    sectorTimes?.boundaryIndices.length === sectorCount - 1
      ? sectorTimes.boundaryIndices.map((boundary) => {
          const index = line.findIndex((entry) => entry.idx >= boundary);
          return index < 0 ? line.length - 1 : index;
        })
      : Array.from({ length: sectorCount - 1 }, (_, index) => Math.floor(((index + 1) * line.length) / sectorCount));
  const boundaries: number[] = [];
  for (let index = 0; index < rawBoundaries.length; index++) {
    const previous = boundaries[index - 1] ?? 0;
    const remaining = rawBoundaries.length - index;
    boundaries.push(Math.min(Math.max(rawBoundaries[index], previous + 1), line.length - remaining));
  }
  const sliceBounds = [0, ...boundaries, line.length - 1];
  const segments = Array.from({ length: sectorCount }, (_, index) => polyline(drivenLine.slice(sliceBounds[index], sliceBounds[index + 1] + 1)));

  return {
    allPoints: polyline(drivenLine),
    segments,
    leftEdge: edges ? polyline(edges.left) : null,
    rightEdge: edges ? polyline(edges.right) : null,
    pts: projectedPoints,
  };
}

/** Project a single world-space point into the same viewbox as `buildGeometry`,
 *  given the min/max bounds computed from the same telemetry+edges inputs.
 *  Used by consumers that need to place markers (corners, issues) at an
 *  arbitrary point not already in the downsampled line. */
export function projectPoint(point: Pt, telemetry: SemanticTuneSample[], edges: { left: Pt[]; right: Pt[] } | null): { x: number; y: number } | null {
  const boundsPoints = telemetry.flatMap((sample) => (sample.positionM ? [sample.positionM] : []));
  if (boundsPoints.length === 0) return null;
  if (edges) boundsPoints.push(...edges.left, ...edges.right);
  const projection = makeTrackProjection(boundsPoints, { width: VIEW, height: VIEW, padPx: PAD });
  return projection?.project(point) ?? null;
}
