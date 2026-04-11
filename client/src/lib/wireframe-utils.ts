import * as THREE from "three";
import { COLORS_HEX, tireState } from "./vehicle-dynamics";

// ── Geometry ──────────────────────────────────────────────────────────

/**
 * Pre-rotated wheel geometries — baked orientation, no runtime Euler nesting.
 * rotateX(PI/2) stands geometries upright: axis Y → Z (car lateral axle).
 */
export function makeWheelGeometries(radius: number, width: number) {
  const rimRadius = radius * 0.67;
  const tire = new THREE.CylinderGeometry(radius, radius, width, 16, 1, true);
  tire.rotateX(Math.PI / 2);
  const rim = new THREE.CylinderGeometry(rimRadius, rimRadius, width * 0.8, 8, 1, true);
  rim.rotateX(Math.PI / 2);
  return { tire, rim };
}

// ── Color helpers ─────────────────────────────────────────────────────

// Pre-allocated color objects to avoid GC pressure
export const SLIP_GREEN = new THREE.Color("#34d399");
export const SLIP_AMBER = new THREE.Color("#fbbf24");
export const SLIP_RED = new THREE.Color("#ef4444");
export const BRAKE_MIN = new THREE.Color("#ff9933");
export const BRAKE_MAX = new THREE.Color("#cc0000");
const _brakeTemp = new THREE.Color();

export function brakeColor(brake: number): THREE.Color {
  // Smooth lerp from light orange (10) to deep red (255)
  const t = Math.min(1, Math.max(0, (brake - 10) / 245));
  return _brakeTemp.copy(BRAKE_MIN).lerp(BRAKE_MAX, t).clone();
}

export function trailColorObj(slip: number, brake: number, isSmallScale?: boolean): THREE.Color {
  // Braking overrides slip color with brake trail
  if (brake > 10) return brakeColor(brake);
  const warn = isSmallScale ? 0.03 : 0.3;
  const crit = isSmallScale ? 0.08 : 0.8;
  if (slip < warn) return SLIP_GREEN;
  if (slip < crit) return SLIP_AMBER;
  return SLIP_RED;
}

// Pre-allocated THREE.Color objects keyed by hex — sourced from vehicle-dynamics COLORS_HEX.
// No threshold logic here: that lives solely in tireState() in vehicle-dynamics.ts.
const TRACTION_COLORS = new Map<string, THREE.Color>([
  [COLORS_HEX.green,  new THREE.Color(COLORS_HEX.green)],
  [COLORS_HEX.yellow, new THREE.Color(COLORS_HEX.yellow)],
  [COLORS_HEX.orange, new THREE.Color(COLORS_HEX.orange)],
  [COLORS_HEX.red,    new THREE.Color(COLORS_HEX.red)],
  [COLORS_HEX.gray,   new THREE.Color(COLORS_HEX.gray)],
]);

/** Returns a pre-allocated THREE.Color driven by tireState() — single source of truth. */
export function trailColorFromState(wheelStateLabel: string, slipRatio: number, slipAngleRad: number): THREE.Color {
  return TRACTION_COLORS.get(tireState(wheelStateLabel, slipRatio, slipAngleRad).hex) ?? TRACTION_COLORS.get(COLORS_HEX.green)!;
}

// ── Input overlay colors ─────────────────────────────────────────────

export const THROTTLE_COLOR = new THREE.Color("#34d399").convertSRGBToLinear();  // emerald-400 sRGB → linear
export const BRAKE_COLOR = new THREE.Color("#ef4444").convertSRGBToLinear();     // red-500 sRGB → linear

export const SUSP_HEX_COLORS = ["#3b82f6", "#34d399", "#facc15", "#ef4444"];

export function suspHexColor(suspTravel: number, thresholds: number[]): string {
  const pct = suspTravel * 100;
  for (let i = 0; i < thresholds.length; i++) {
    if (pct < thresholds[i]) return SUSP_HEX_COLORS[i] ?? SUSP_HEX_COLORS[0];
  }
  return SUSP_HEX_COLORS[thresholds.length] ?? SUSP_HEX_COLORS[SUSP_HEX_COLORS.length - 1];
}

// ── Geometry filtering ────────────────────────────────────────────────

export const DIST_AHEAD = 80;   // meters ahead of car
export const DIST_BEHIND = 20;  // meters behind car
export const DIST_LATERAL = 30; // meters to the side

/**
 * Filter world-space points by directional distance from car — shows more
 * track ahead than behind, based on car's forward direction.
 */
export function filterByDistance(
  pts: { x: number; z: number }[],
  cx: number,
  cz: number,
  yaw: number,
  y: number,
  ahead = DIST_AHEAD,
  behind = DIST_BEHIND,
  lateral = DIST_LATERAL,
): [number, number, number][][] {
  const s = Math.sin(yaw);
  const c = Math.cos(yaw);
  const segments: [number, number, number][][] = [];
  let current: [number, number, number][] = [];

  if (!Array.isArray(pts)) return [];
  for (const p of pts) {
    const dx = p.x - cx;
    const dz = p.z - cz;
    // Transform to car-local: forward/lateral
    const localFwd = dx * s + dz * c;
    const localLat = dx * c - dz * s;
    const dist2 = dx * dx + dz * dz;
    const maxDist = ahead * ahead; // cap total straight-line distance
    const inRange = dist2 <= maxDist &&
                    localFwd >= -behind && localFwd <= ahead &&
                    Math.abs(localLat) <= lateral;
    if (inRange) {
      current.push([localFwd, y, localLat]);
    } else if (current.length > 1) {
      segments.push(current);
      current = [];
    } else {
      current = [];
    }
  }
  if (current.length > 1) segments.push(current);
  return segments;
}

// ── Pre-allocated wall geometry ──────────────────────────────────────
// Used by TrackBoundaryEdges to avoid creating a new BufferGeometry +
// Float32Array every cursor move. Allocate once per wall with a
// generous max-vertex capacity, mutate the position / index buffers in
// place on update, and use setDrawRange to tell Three.js how many
// triangles are live.

// 4096 vertices × 3 floats × 4 bytes = 48 KB per wall.
// Realistic usage for a 100 m × 60 m window with 2 m point spacing is
// well under 200 vertices — 10×+ overhead for safety.
const MAX_WALL_VERTICES = 4096;
const MAX_WALL_INDICES = MAX_WALL_VERTICES * 3;

/**
 * Allocate a BufferGeometry with pre-sized position + index buffers for
 * an extruded wall. Callers should dispose it on unmount.
 */
export function createWallGeometry(): THREE.BufferGeometry {
  const geom = new THREE.BufferGeometry();
  geom.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array(MAX_WALL_VERTICES * 3), 3),
  );
  geom.setIndex(
    new THREE.BufferAttribute(new Uint16Array(MAX_WALL_INDICES), 1),
  );
  // Start empty — updateWallGeometry will bump drawRange as segments arrive.
  geom.setDrawRange(0, 0);
  return geom;
}

/**
 * Fill a pre-allocated wall BufferGeometry's buffers in place from a
 * list of ground-plane segments. Each segment is extruded upward by
 * `wallHeight`. Marks the buffers dirty and updates the draw range.
 */
export function updateWallGeometry(
  geom: THREE.BufferGeometry,
  segments: [number, number, number][][],
  wallHeight: number,
): void {
  const positions = geom.attributes.position.array as Float32Array;
  const indexAttr = geom.index;
  if (!indexAttr) return;
  const indices = indexAttr.array as Uint16Array;

  let vPtr = 0;
  let iPtr = 0;
  let vertexOffset = 0;

  for (const seg of segments) {
    if (seg.length < 2) continue;
    // Ensure we don't overflow the pre-allocated buffers. If a track
    // ever has more wall geometry in the window than we planned for,
    // drop the remainder — better than a GPU buffer overrun.
    const vertsNeeded = seg.length * 2;
    const indicesNeeded = (seg.length - 1) * 6;
    if (vPtr + vertsNeeded * 3 > positions.length) break;
    if (iPtr + indicesNeeded > indices.length) break;

    for (const pt of seg) {
      positions[vPtr++] = pt[0];
      positions[vPtr++] = pt[1];
      positions[vPtr++] = pt[2];
      positions[vPtr++] = pt[0];
      positions[vPtr++] = pt[1] + wallHeight;
      positions[vPtr++] = pt[2];
    }
    for (let i = 0; i < seg.length - 1; i++) {
      const b = vertexOffset + i * 2;
      indices[iPtr++] = b;
      indices[iPtr++] = b + 1;
      indices[iPtr++] = b + 2;
      indices[iPtr++] = b + 1;
      indices[iPtr++] = b + 3;
      indices[iPtr++] = b + 2;
    }
    vertexOffset += seg.length * 2;
  }

  geom.attributes.position.needsUpdate = true;
  indexAttr.needsUpdate = true;
  geom.setDrawRange(0, iPtr);
  // Recompute bounds so frustum culling works correctly; cheap for our sizes.
  geom.computeBoundingSphere();
}

// ── Chunk-AABB spatial index ─────────────────────────────────────────
// Splits the point list into sequential chunks and records each chunk's
// world-space AABB. The render-time filter can then skip whole chunks
// whose AABB doesn't overlap the query window, bringing cost from O(n)
// to roughly O(k) where k is the number of points actually near the car.
// Chunk ordering is preserved so the original segment-stitching logic
// still works unchanged.

interface TrackChunk {
  start: number;   // inclusive index into pts
  end: number;     // exclusive
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface TrackIndex {
  pts: ReadonlyArray<{ x: number; z: number }>;
  chunks: ReadonlyArray<TrackChunk>;
}

/**
 * Build a chunk-AABB index over a point list. One-time O(n) cost per
 * outline load — the result is stable as long as `pts` is stable, so
 * callers should wrap in `useMemo([pts])`.
 *
 * `chunkSize` trades off pre-filter test count (more chunks = more AABB
 * tests) against per-chunk wasted work when a chunk passes (bigger chunks
 * = more points scanned inside). 64 is a good default for track-scale
 * data sampled every few meters.
 */
export function buildTrackIndex(
  pts: ReadonlyArray<{ x: number; z: number }>,
  chunkSize = 64,
): TrackIndex {
  const chunks: TrackChunk[] = [];
  if (!Array.isArray(pts) || pts.length === 0) return { pts, chunks };
  const size = Math.max(1, chunkSize);
  for (let start = 0; start < pts.length; start += size) {
    const end = Math.min(start + size, pts.length);
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let i = start; i < end; i++) {
      const p = pts[i];
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.z < minZ) minZ = p.z;
      if (p.z > maxZ) maxZ = p.z;
    }
    chunks.push({ start, end, minX, maxX, minZ, maxZ });
  }
  return { pts, chunks };
}

/**
 * Filter world-space points by directional distance from car, using a
 * pre-built `TrackIndex` to skip chunks that can't possibly overlap the
 * query window. Output is identical to `filterByDistance` for the same
 * input points and parameters.
 *
 * The chunk pre-filter uses a loose world-space square around the car
 * (invariant of yaw, since chunks are fixed), then falls through to the
 * exact rotated-window check per point.
 */
export function filterByDistanceIndexed(
  index: TrackIndex,
  cx: number,
  cz: number,
  yaw: number,
  y: number,
  ahead = DIST_AHEAD,
  behind = DIST_BEHIND,
  lateral = DIST_LATERAL,
): [number, number, number][][] {
  const pts = index.pts;
  if (!Array.isArray(pts) || pts.length === 0) return [];

  // Loose world-space query AABB: the rotated car-local window fits inside
  // a square of radius max(ahead, behind) + lateral (+small margin).
  const r = Math.max(ahead, behind) + lateral;
  const qMinX = cx - r;
  const qMaxX = cx + r;
  const qMinZ = cz - r;
  const qMaxZ = cz + r;

  const s = Math.sin(yaw);
  const c = Math.cos(yaw);
  const maxDist = ahead * ahead;
  const segments: [number, number, number][][] = [];
  let current: [number, number, number][] = [];

  for (const chunk of index.chunks) {
    // Skip entire chunk if its AABB doesn't overlap the query window.
    // A skipped chunk is equivalent to a run of out-of-range points, so
    // any open segment must be closed here (mirroring the per-point
    // "else" branches below).
    if (
      chunk.maxX < qMinX || chunk.minX > qMaxX ||
      chunk.maxZ < qMinZ || chunk.minZ > qMaxZ
    ) {
      if (current.length > 1) segments.push(current);
      current = [];
      continue;
    }

    for (let i = chunk.start; i < chunk.end; i++) {
      const p = pts[i];
      const dx = p.x - cx;
      const dz = p.z - cz;
      const localFwd = dx * s + dz * c;
      const localLat = dx * c - dz * s;
      const dist2 = dx * dx + dz * dz;
      const inRange = dist2 <= maxDist &&
                      localFwd >= -behind && localFwd <= ahead &&
                      Math.abs(localLat) <= lateral;
      if (inRange) {
        current.push([localFwd, y, localLat]);
      } else if (current.length > 1) {
        segments.push(current);
        current = [];
      } else {
        current = [];
      }
    }
  }
  if (current.length > 1) segments.push(current);
  return segments;
}

import type { CarModelEnrichment } from "../data/car-models";

export function getWheelOffsets(m: CarModelEnrichment): [number, number][] {
  return [
    [m.halfWheelbase, -m.halfFrontTrack],   // FL
    [m.halfWheelbase, m.halfFrontTrack],     // FR
    [-m.halfWheelbase, -m.halfRearTrack],    // RL
    [-m.halfWheelbase, m.halfRearTrack],     // RR
  ];
}
