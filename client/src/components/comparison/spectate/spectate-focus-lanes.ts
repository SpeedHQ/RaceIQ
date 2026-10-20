export type FocusCenterPoint = { x: number; z: number; tx: number; tz: number };
type Point = { x: number; z: number };

/** Project samples onto centerline with travel-oriented unit tangents. */
export function projectFocusCenterline(samples: readonly Point[], centerLine: readonly Point[]): (FocusCenterPoint | null)[] {
  const segments: { x: number; z: number; dx: number; dz: number; length2: number; tx: number; tz: number }[] = [];
  for (let i = 1; i < centerLine.length; i++) {
    const p = centerLine[i - 1], q = centerLine[i];
    const dx = q.x - p.x, dz = q.z - p.z, length2 = dx * dx + dz * dz;
    if (!Number.isFinite(length2) || length2 <= 0) continue;
    const length = Math.sqrt(length2);
    segments.push({ x: p.x, z: p.z, dx, dz, length2, tx: dx / length, tz: dz / length });
  }
  let travelX = 0, travelZ = 0;
  for (let i = 1; i < samples.length; i++) {
    const dx = samples[i].x - samples[i - 1].x, dz = samples[i].z - samples[i - 1].z;
    if (Number.isFinite(dx) && Number.isFinite(dz) && dx * dx + dz * dz > 1e-16) {
      travelX = dx; travelZ = dz;
      break;
    }
  }
  return samples.map((sample, i) => {
    if (!Number.isFinite(sample.x) || !Number.isFinite(sample.z)) return null;
    let best = Infinity, px = 0, pz = 0, tx = 0, tz = 0;
    for (const segment of segments) {
      const t = Math.max(0, Math.min(1, ((sample.x - segment.x) * segment.dx + (sample.z - segment.z) * segment.dz) / segment.length2));
      const x = segment.x + segment.dx * t, z = segment.z + segment.dz * t;
      const distance = (x - sample.x) ** 2 + (z - sample.z) ** 2;
      if (distance < best) { best = distance; px = x; pz = z; tx = segment.tx; tz = segment.tz; }
    }
    if (!Number.isFinite(best)) return null;
    const next = samples[i + 1], prior = samples[i - 1];
    const dx = next ? next.x - sample.x : prior ? sample.x - prior.x : 0;
    const dz = next ? next.z - sample.z : prior ? sample.z - prior.z : 0;
    if (Number.isFinite(dx) && Number.isFinite(dz) && dx * dx + dz * dz > 1e-16) {
      travelX = dx; travelZ = dz;
    }
    if (tx * travelX + tz * travelZ < 0) { tx = -tx; tz = -tz; }
    return { x: px, z: pz, tx, tz };
  });
}

/** Set a point offset in camera plane along projected perpendicular, oriented to world left. */
export function offsetFocusLane(out: { x: number; y: number; z: number }, tangent: { tx: number; tz: number }, right: { x: number; y: number; z: number }, up: { x: number; y: number; z: number }, signedOffsetPixels: number, worldPerPixel: number): void {
  const sx = tangent.tx * right.x + tangent.tz * right.z;
  const sy = tangent.tx * up.x + tangent.tz * up.z;
  let nx = -sy, ny = sx;
  if (Math.hypot(nx, ny) < 1e-8) {
    nx = -tangent.tz * right.x + tangent.tx * right.z;
    ny = -tangent.tz * up.x + tangent.tx * up.z;
  }
  let dx = right.x * nx + up.x * ny, dy = right.y * nx + up.y * ny, dz = right.z * nx + up.z * ny;
  const length = Math.hypot(dx, dy, dz);
  if (!Number.isFinite(length) || length < 1e-8 || !Number.isFinite(signedOffsetPixels) || !Number.isFinite(worldPerPixel) || worldPerPixel < 0) {
    out.x = out.y = out.z = 0;
    return;
  }
  if (-dx * tangent.tz + dz * tangent.tx > 0) { dx = -dx; dy = -dy; dz = -dz; }
  const amount = signedOffsetPixels * worldPerPixel / length;
  out.x = dx * amount; out.y = dy * amount; out.z = dz * amount;
}

export type TimedFocusPoint = { x: number; y: number; z: number; time: number; endTime: number; distance?: number; endDistance?: number };

/** Sample the rendered lane itself; stationary spans hold position and gaps stay empty. */
export function sampleFocusLane(out: { x: number; y: number; z: number }, runs: readonly (readonly TimedFocusPoint[])[], position: number, coordinate: "time" | "distance" = "time"): boolean {
  if (!Number.isFinite(position)) return false;
  const end = coordinate === "time" ? "endTime" : "endDistance";
  for (let r = 0; r < runs.length; r++) {
    const run = runs[r];
    if (!run.length) continue;
    const first = run[0], last = run[run.length - 1];
    const startPosition = first[coordinate] ?? NaN, endPosition = last[end] ?? NaN;
    if (!Number.isFinite(startPosition) || !Number.isFinite(endPosition)) return false;
    if (position < startPosition && r > 0) return false;
    if (position > endPosition && r < runs.length - 1) continue;
    let low = 0, high = run.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if ((run[mid][coordinate] ?? NaN) <= position) low = mid;
      else high = mid - 1;
    }
    const a = run[low], b = run[Math.min(low + 1, run.length - 1)];
    const aEnd = a[end] ?? NaN, bStart = b[coordinate] ?? NaN;
    const t = bStart > aEnd ? Math.max(0, Math.min(1, (position - aEnd) / (bStart - aEnd))) : 0;
    out.x = a.x + (b.x - a.x) * t;
    out.y = a.y + (b.y - a.y) * t;
    out.z = a.z + (b.z - a.z) * t;
    return true;
  }
  return false;
}

export const FOCUS_ZOOM_NEAR = 48;
export const FOCUS_ZOOM_FAR = 16;
export const FOCUS_ZOOM_SNAP_OUT = 8;
export const FOCUS_ZOOM_SNAP_ZONE_END = Math.log(FOCUS_ZOOM_NEAR / FOCUS_ZOOM_FAR) / Math.log(FOCUS_ZOOM_NEAR / FOCUS_ZOOM_SNAP_OUT);

/** Threefold zoom interval, eased at both ends and reversible without animation lag. */
export function focusZoomBlend(modelPixels: number): number {
  const t = Math.max(0, Math.min(1, Math.log(FOCUS_ZOOM_NEAR / Math.max(Number.MIN_VALUE, modelPixels)) / Math.log(FOCUS_ZOOM_NEAR / FOCUS_ZOOM_FAR)));
  return t * t * (3 - 2 * t);
}

export function zoomIndicatorPosition(modelPixels: number): number {
  return Math.max(0, Math.min(1, Math.log(FOCUS_ZOOM_NEAR / Math.max(Number.MIN_VALUE, modelPixels)) / Math.log(FOCUS_ZOOM_NEAR / FOCUS_ZOOM_SNAP_OUT)));
}

export function focusLaneWidth(baseWidth: number, modelPixels: number): number {
  return baseWidth * Math.max(0.25, Math.min(1, modelPixels / FOCUS_ZOOM_FAR));
}
