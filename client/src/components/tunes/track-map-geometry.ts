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

  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  const acc = (p: Pt) => {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
  };
  for (const l of line) acc(l.p);
  if (edges) {
    for (const p of edges.left) acc(p);
    for (const p of edges.right) acc(p);
  }

  const spanX = maxX - minX;
  const spanZ = maxZ - minZ;
  const span = Math.max(spanX, spanZ);
  if (!(span > 0)) return null;

  const scale = (VIEW - PAD * 2) / span;
  const offX = (VIEW - spanX * scale) / 2;
  const offZ = (VIEW - spanZ * scale) / 2;
  const px = (p: Pt) => offX + (p.x - minX) * scale;
  // Flip Z so the map isn't drawn upside-down relative to screen space.
  const py = (p: Pt) => VIEW - (offZ + (p.z - minZ) * scale);
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
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  const acc = (q: Pt) => {
    if (q.x < minX) minX = q.x;
    if (q.x > maxX) maxX = q.x;
    if (q.z < minZ) minZ = q.z;
    if (q.z > maxZ) maxZ = q.z;
  };
  for (const t of telemetry) acc({ x: t.PositionX, z: t.PositionZ });
  if (edges) {
    for (const e of edges.left) acc(e);
    for (const e of edges.right) acc(e);
  }
  const spanX = maxX - minX;
  const spanZ = maxZ - minZ;
  const span = Math.max(spanX, spanZ);
  if (!(span > 0)) return null;
  const scale = (VIEW - PAD * 2) / span;
  const offX = (VIEW - spanX * scale) / 2;
  const offZ = (VIEW - spanZ * scale) / 2;
  return { x: offX + (p.x - minX) * scale, y: VIEW - (offZ + (p.z - minZ) * scale) };
}
