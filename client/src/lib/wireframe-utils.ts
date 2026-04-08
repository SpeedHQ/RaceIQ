import * as THREE from "three";
import { COLORS_HEX, tireState } from "./vehicle-dynamics";

// ── Geometry ──────────────────────────────────────────────────────────

/**
 * Pre-rotated wheel geometries — baked orientation, no runtime Euler nesting.
 * rotateX(PI/2) stands geometries upright: axis Y → Z (car lateral axle).
 */
export function makeWheelGeometries(radius: number, width: number) {
  const rimRadius = radius * 0.67;
  const tire = new THREE.CylinderGeometry(radius, radius, width, 16, 1, false);
  tire.rotateX(Math.PI / 2);
  const rim = new THREE.CylinderGeometry(rimRadius, rimRadius, width * 0.8, 8, 1, true);
  rim.rotateX(Math.PI / 2);
  const hub = new THREE.CircleGeometry(rimRadius, 5);
  hub.rotateX(Math.PI / 2);
  return { tire, rim, hub };
}

// ── Color helpers ─────────────────────────────────────────────────────

export function brakeTempColor(temp: number): string {
  if (temp < 200) return "#3b82f6";  // cold — blue
  if (temp < 400) return "#6ee7b7";  // warming — green
  if (temp < 700) return "#fbbf24";  // optimal — amber
  if (temp < 900) return "#f97316";  // hot — orange
  return "#ef4444";                   // critical — red
}

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
export function trailColorFromState(wheelStateLabel: string, combinedSlip: number): THREE.Color {
  return TRACTION_COLORS.get(tireState(wheelStateLabel, combinedSlip).hex) ?? TRACTION_COLORS.get(COLORS_HEX.green)!;
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

import type { CarModelEnrichment } from "../data/car-models";

export function getWheelOffsets(m: CarModelEnrichment): [number, number][] {
  return [
    [m.halfWheelbase, -m.halfFrontTrack],   // FL
    [m.halfWheelbase, m.halfFrontTrack],     // FR
    [-m.halfWheelbase, -m.halfRearTrack],    // RL
    [-m.halfWheelbase, m.halfRearTrack],     // RR
  ];
}
