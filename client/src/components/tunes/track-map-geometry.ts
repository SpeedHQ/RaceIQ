import { makeTrackProjection } from "@shared/track-projection";
import type { TelemetryPacket } from "@shared/types";

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
  times: [number, number, number];
  s1Idx: number;
  s2Idx: number;
}

export interface Geometry {
  allPoints: string;
  segments: [string, string, string];
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
    head: [
      `${tipX},${tipY}`,
      `${tipX - nx * wing * 2 + ny * wing},${tipY - ny * wing * 2 - nx * wing}`,
      `${tipX - nx * wing * 2 - ny * wing},${tipY - ny * wing * 2 + nx * wing}`,
    ].join(" "),
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
 * 0..VIEW SVG viewbox, split into three sector-colored polyline segments.
 * Downsamples the driven line to ~TARGET_POINTS while keeping each point's
 * original telemetry index so hover/lookup can find the real frame.
 */
export function buildGeometry(telemetry: TelemetryPacket[], sectorTimes: SectorTimesLite | null, edges: { left: Pt[]; right: Pt[] } | null): Geometry | null {
  if (telemetry.length < 10) return null;

  const step = Math.max(1, Math.floor(telemetry.length / TARGET_POINTS));
  const line: { p: Pt; idx: number }[] = [];
  for (let i = 0; i < telemetry.length; i += step) line.push({ p: { x: telemetry[i].PositionX, z: telemetry[i].PositionZ }, idx: i });
  const rawS1 = sectorTimes && sectorTimes.s1Idx > 0 ? Math.floor(sectorTimes.s1Idx / step) : Math.floor(line.length / 3);
  const rawS2 = sectorTimes && sectorTimes.s2Idx > 0 ? Math.floor(sectorTimes.s2Idx / step) : Math.floor((2 * line.length) / 3);

  // Orientation lives in @shared/track-projection so the e2e segment renderer
  // draws the same track the same way up. Do not reintroduce local axis math.
  const boundsPts: Pt[] = line.map((l) => l.p);
  if (edges) {
    for (const p of edges.left) boundsPts.push(p);
    for (const p of edges.right) boundsPts.push(p);
  }
  const projection = makeTrackProjection(boundsPts, { width: VIEW, height: VIEW, padPx: PAD });
  if (!projection) return null;

  const px = (p: Pt) => projection.project(p).x;
  const py = (p: Pt) => projection.project(p).y;
  const str = (p: Pt) => `${px(p).toFixed(1)},${py(p).toFixed(1)}`;
  const polyline = (ps: Pt[]) => ps.map(str).join(" ");

  const projPts: ProjPt[] = line.map((l) => ({ x: px(l.p), y: py(l.p), idx: l.idx }));
  const pline = line.map((l) => l.p);

  const n = line.length;
  const s1 = Math.min(Math.max(rawS1, 1), n - 2);
  const s2 = Math.min(Math.max(rawS2, s1 + 1), n - 1);

  return {
    allPoints: polyline(pline),
    segments: [polyline(pline.slice(0, s1 + 1)), polyline(pline.slice(s1, s2 + 1)), polyline(pline.slice(s2))],
    leftEdge: edges ? polyline(edges.left) : null,
    rightEdge: edges ? polyline(edges.right) : null,
    pts: projPts,
  };
}

/** Project a single world-space point into the same viewbox as `buildGeometry`,
 *  given the min/max bounds computed from the same telemetry+edges inputs.
 *  Used by consumers that need to place markers (corners, issues) at an
 *  arbitrary point not already in the downsampled line. */
export function projectPoint(p: Pt, telemetry: TelemetryPacket[], edges: { left: Pt[]; right: Pt[] } | null): { x: number; y: number } | null {
  if (telemetry.length === 0) return null;
  const boundsPts: Pt[] = telemetry.map((t) => ({ x: t.PositionX, z: t.PositionZ }));
  if (edges) {
    for (const e of edges.left) boundsPts.push(e);
    for (const e of edges.right) boundsPts.push(e);
  }
  // Same projection as buildGeometry — shared so markers land on the line.
  const projection = makeTrackProjection(boundsPts, { width: VIEW, height: VIEW, padPx: PAD });
  if (!projection) return null;
  return projection.project(p);
}
