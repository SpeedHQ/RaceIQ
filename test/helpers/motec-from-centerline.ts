/**
 * Turns a real track centerline into MoTeC channels, so the transcoder's
 * dead-reckoning can be checked against known geometry.
 *
 * The reference `.ld` export is a driver's own telemetry and is not in the repo,
 * which leaves the reconstruction in `server/motec/to-ac-evo.ts` without
 * anything real to be wrong against. Synthetic circles prove the integrator
 * runs; they do not prove it produces the *right* track, and in particular they
 * cannot catch a mirrored map — the failure mode the track-segment
 * visualisations exist to catch (see `test/track-segment-viz.test.ts`).
 *
 * So we go the other way: take a committed centerline, differentiate it into the
 * speed and yaw-rate channels a logger would have recorded while driving it, and
 * feed those through the real transcoder. If the reconstruction comes back
 * mirrored, rotated wrongly, or scaled, it no longer matches the centerline it
 * was derived from, and the comparison fails.
 */

import type { LdFileSpec } from "./motec-ld";

export interface Point {
  x: number;
  z: number;
}

/** Wrap an angle difference into (-π, π] so a heading crossing ±π is a small step. */
function wrapAngle(radians: number): number {
  let a = radians;
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a <= -Math.PI) a += 2 * Math.PI;
  return a;
}

/**
 * Heading of the segment from `a` to `b`, measured from +Z toward +X.
 *
 * Must match the convention in `deadReckonPath` (`x = sin θ`, `z = cos θ`).
 * Using atan2(dz, dx) here instead would silently transpose the axes and make
 * the comparison pass against a wrong reconstruction.
 */
function headingOf(a: Point, b: Point): number {
  return Math.atan2(b.x - a.x, b.z - a.z);
}

/** Resample a polyline at a fixed arc-length step. */
export function resampleByArcLength(points: Point[], step: number): Point[] {
  const out: Point[] = [];
  if (points.length < 2 || step <= 0) return points.slice();

  out.push(points[0]!);
  let carry = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const segLen = Math.hypot(b.x - a.x, b.z - a.z);
    if (segLen === 0) continue;

    let travelled = step - carry;
    while (travelled <= segLen) {
      const t = travelled / segLen;
      out.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
      travelled += step;
    }
    carry = segLen - (travelled - step);
  }
  return out;
}

/**
 * Express a path in the frame the transcoder reconstructs into: first point at
 * the origin, first segment pointing along +Z (heading 0).
 *
 * Absolute position and orientation are unknowable from speed and yaw alone, so
 * a fair comparison has to remove both from the reference too. What remains —
 * shape, scale and handedness — is exactly what the reconstruction must get
 * right.
 */
export function normalizeToOriginHeading(points: Point[]): Point[] {
  if (points.length < 2) return points.slice();
  const origin = points[0]!;
  const theta0 = headingOf(points[0]!, points[1]!);
  // Rotate by -theta0 in the (x across, z along) frame.
  const cos = Math.cos(-theta0);
  const sin = Math.sin(-theta0);
  return points.map((p) => {
    const dx = p.x - origin.x;
    const dz = p.z - origin.z;
    return { x: dx * cos + dz * sin, z: -dx * sin + dz * cos };
  });
}

/**
 * Signed area via the shoelace formula. Its *sign* is the path's handedness —
 * the single number that flips when a reconstruction comes out mirrored.
 */
export function signedArea(points: Point[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    sum += a.x * b.z - b.x * a.z;
  }
  return sum / 2;
}

export interface CenterlineStint {
  spec: LdFileSpec;
  beacons: number[];
  /** The reference path, resampled and normalised, one point per synthesized frame. */
  reference: Point[];
  lapSeconds: number;
  lapLengthM: number;
}

/**
 * Build a MoTeC log describing `laps` laps driven around `centerline`.
 *
 * Speed is held constant so that a fixed time step is a fixed arc-length step;
 * the interesting channel is `ROTY`, which is the centerline's own curvature
 * expressed as a yaw rate. Everything else is filler to keep the transcoder's
 * channel lookups satisfied.
 */
export function centerlineToStint(
  centerline: Point[],
  opts: { laps: number; hz: number; speedKmh?: number },
): CenterlineStint {
  const { laps, hz } = opts;
  const speedKmh = opts.speedKmh ?? 160;
  const v = speedKmh / 3.6;
  const dt = 1 / hz;
  const step = v * dt;

  const lapPath = resampleByArcLength(centerline, step);
  const normalized = normalizeToOriginHeading(lapPath);
  const perLap = lapPath.length;
  const lapSeconds = perLap * dt;
  const lapLengthM = perLap * step;

  // Yaw rate per frame: how fast heading changes along the resampled path. The
  // last frame of a lap reuses the previous rate, having no successor segment.
  const yaw: number[] = [];
  for (let i = 0; i < perLap; i++) {
    if (i + 2 >= perLap) {
      yaw.push(yaw[yaw.length - 1] ?? 0);
      continue;
    }
    const h0 = headingOf(lapPath[i]!, lapPath[i + 1]!);
    const h1 = headingOf(lapPath[i + 1]!, lapPath[i + 2]!);
    yaw.push(wrapAngle(h1 - h0) / dt);
  }

  const total = perLap * laps;
  const repeat = <T,>(source: T[]): T[] =>
    Array.from({ length: total }, (_, i) => source[i % perLap]!);

  const speed = new Array(total).fill(speedKmh);
  const roty = repeat(yaw);
  // Lateral G consistent with the yaw the car is actually carrying, so the
  // ROTY-absent fallback path is exercised against the same geometry.
  const gLat = roty.map((w) => (w * v) / 9.80665);

  const ch = (name: string, samples: number[], unit?: string) => ({
    name,
    freq: hz,
    samples,
    unit,
  });

  return {
    spec: {
      venue: "spa",
      vehicleId: "mercedes_amg_gt3_evo",
      channels: [
        ch("SPEED", speed, "kmh"),
        ch("THROTTLE", new Array(total).fill(1)),
        ch("BRAKE", new Array(total).fill(0)),
        ch("STEERANGLE", roty.map((w) => w * 40), "deg"),
        ch("RPMS", new Array(total).fill(7000)),
        ch("GEAR", new Array(total).fill(5)),
        ch("G_LAT", gLat),
        ch("G_LON", new Array(total).fill(0)),
        ch("ROTY", roty, "rad/s"),
      ],
    },
    beacons: Array.from({ length: laps - 1 }, (_, i) => (i + 1) * lapSeconds),
    reference: normalized,
    lapSeconds,
    lapLengthM,
  };
}
