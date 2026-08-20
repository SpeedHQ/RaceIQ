import type { Point } from "./types";

/**
 * Remove outlier points where the distance to the next point is abnormally large.
 * This catches pit lane teleports, rewind jumps, and other glitches.
 * Uses median spacing * 5 as the threshold — anything larger is a jump.
 */
export function filterOutlierPoints(points: Point[]): Point[] {
  if (points.length < 10) return points;

  // Compute all consecutive distances
  const dists: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const dx = points[i].x - points[i - 1].x;
    const dz = points[i].z - points[i - 1].z;
    dists.push(Math.sqrt(dx * dx + dz * dz));
  }

  // Median distance
  const sorted = [...dists].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const threshold = Math.max(median * 5, 20); // at least 20m to avoid filtering tight corners

  // Keep points where the gap FROM the previous point is reasonable
  const filtered: Point[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    if (dists[i - 1] <= threshold) {
      filtered.push(points[i]);
    }
  }

  return filtered;
}

export interface TrackAlignment {
  scale: number;
  cos: number;
  sin: number;
  tx: number;
  tz: number;
  flipZ: boolean;
  flipX: boolean;
}

export interface ComputeAlignmentOptions {
  /** Reversed traversal is useful for shape-only outlines, but invalid when each point carries directional data. */
  allowReverse?: boolean;
  /** Maximum arc-length samples used by fit. Higher values trade CPU for precision. */
  sampleCount?: number;
  /** Inputs already contain matching equal-arc samples, avoiding another lossy interpolation pass. */
  inputsAreArcSamples?: boolean;
}

/** Compute Procrustes transform (scale + rotation + translation) from src to tgt.
 *  Tries both normal and Z-flipped source, picks whichever has lower error. */
export function computeAlignment(src: readonly Point[], tgt: readonly Point[], options: ComputeAlignmentOptions = {}): TrackAlignment | null {
  if (src.length < 5 || tgt.length < 5) return null;
  const n = Math.min(options.sampleCount ?? 100, Math.min(src.length, tgt.length));

  // Sample target at equal fractional distances
  function cumDist(pts: readonly Point[]): number[] {
    const d = [0];
    for (let i = 1; i < pts.length; i++)
      d.push(d[i - 1] + Math.sqrt((pts[i].x - pts[i - 1].x) ** 2 + (pts[i].z - pts[i - 1].z) ** 2));
    return d;
  }
  function sampleAtFracs(pts: readonly Point[], fracs: readonly number[]): Point[] {
    const cd = cumDist(pts);
    const total = cd[cd.length - 1];
    return fracs.map(f => {
      const target = f * total;
      let lo = 0;
      for (let i = 1; i < cd.length; i++) { if (cd[i] >= target) { lo = i - 1; break; } }
      if (lo >= pts.length - 1) return pts[pts.length - 1];
      const seg = cd[lo + 1] - cd[lo];
      const t2 = seg > 0 ? (target - cd[lo]) / seg : 0;
      return { x: pts[lo].x + t2 * (pts[lo + 1].x - pts[lo].x), z: pts[lo].z + t2 * (pts[lo + 1].z - pts[lo].z) };
    });
  }

  const fracs = Array.from({ length: n }, (_, i) => i / n);
  const tSampled = options.inputsAreArcSamples ? tgt.slice(0, n) : sampleAtFracs(tgt, fracs);
  const sampleSourceAtOffset = (points: readonly Point[], offset: number): Point[] =>
    options.inputsAreArcSamples
      ? Array.from({ length: n }, (_, index) => points[(index + offset) % n])
      : sampleAtFracs(points, fracs.map(fraction => (fraction + offset / n) % 1));

  function procrustes(s: readonly Point[], t2: readonly Point[]) {
    const cs = { x: s.reduce((a, p) => a + p.x, 0) / n, z: s.reduce((a, p) => a + p.z, 0) / n };
    const ct = { x: t2.reduce((a, p) => a + p.x, 0) / n, z: t2.reduce((a, p) => a + p.z, 0) / n };
    let num = 0, den = 0, sn2 = 0, tn2 = 0;
    for (let i = 0; i < n; i++) {
      const sx = s[i].x - cs.x, sz = s[i].z - cs.z;
      const tx = t2[i].x - ct.x, tz = t2[i].z - ct.z;
      num += sx * tz - sz * tx; den += sx * tx + sz * tz;
      sn2 += sx * sx + sz * sz; tn2 += tx * tx + tz * tz;
    }
    const rot = Math.atan2(num, den);
    const sc = sn2 > 0 ? Math.sqrt(tn2 / sn2) : 1;
    const co = Math.cos(rot), si = Math.sin(rot);
    const result = { scale: sc, cos: co, sin: si, tx: ct.x - sc * (co * cs.x - si * cs.z), tz: ct.z - sc * (si * cs.x + co * cs.z) };
    let err = 0;
    for (let i = 0; i < n; i++) {
      const ax = sc * (co * s[i].x - si * s[i].z) + result.tx;
      const az = sc * (si * s[i].x + co * s[i].z) + result.tz;
      err += (ax - t2[i].x) ** 2 + (az - t2[i].z) ** 2;
    }
    return { ...result, err };
  }

  // Try all flip combinations × multiple starting offsets along the track
  type Candidate = TrackAlignment & { err: number };
  let best: Candidate | null = null;
  const offsets = 1; // test every possible starting offset for best alignment

  for (const [flipX, flipZ] of [[false, false], [false, true], [true, false], [true, true]] as [boolean, boolean][]) {
    const flipped = src.map(p => ({ x: flipX ? -p.x : p.x, z: flipZ ? -p.z : p.z }));
    // Try multiple starting offsets
    for (let off = 0; off < n; off += offsets) {
      const sSampled = sampleSourceAtOffset(flipped, off);
      const r = procrustes(sSampled, tSampled);
      if (!best || r.err < best.err) {
        best = { ...r, flipX, flipZ };
      }
    }
    if (options.allowReverse !== false) {
      const revFlipped = [...flipped].reverse();
      for (let off = 0; off < n; off += offsets) {
        const sSampled = sampleSourceAtOffset(revFlipped, off);
        const r = procrustes(sSampled, tSampled);
        if (!best || r.err < best.err) {
          best = { ...r, flipX, flipZ };
        }
      }
    }
  }

  return best ? { scale: best.scale, cos: best.cos, sin: best.sin, tx: best.tx, tz: best.tz, flipZ: best.flipZ, flipX: best.flipX } : null;
}

export function applyAlignment(p: Point, a: TrackAlignment): Point {
  const px = a.flipX ? -p.x : p.x;
  const pz = a.flipZ ? -p.z : p.z;
  return { x: a.scale * (a.cos * px - a.sin * pz) + a.tx, z: a.scale * (a.sin * px + a.cos * pz) + a.tz };
}

export function trackAlignmentRmse(source: readonly Point[], target: readonly Point[], alignment: TrackAlignment): number {
  const mapped = source.map((point) => applyAlignment(point, alignment));
  const nearestSquared = (point: Point, candidates: readonly Point[]): number => {
    let best = Infinity;
    for (const candidate of candidates) {
      const dx = candidate.x - point.x;
      const dz = candidate.z - point.z;
      best = Math.min(best, dx * dx + dz * dz);
    }
    return best;
  };
  let squared = 0;
  for (const point of mapped) squared += nearestSquared(point, target);
  for (const point of target) squared += nearestSquared(point, mapped);
  return Math.sqrt(squared / (mapped.length + target.length));
}
