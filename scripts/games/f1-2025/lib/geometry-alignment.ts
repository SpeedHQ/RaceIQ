export interface Point {
  x: number;
  z: number;
}

export interface Transform {
  scale: number;
  rotation: number;
  tx: number;
  tz: number;
}

export interface Alignment {
  transform: Transform;
  flip: "" | "flipX" | "flipZ" | "flipXZ";
  error: number;
}

export function centroid(points: Point[]): Point {
  let sx = 0;
  let sz = 0;
  for (const point of points) {
    sx += point.x;
    sz += point.z;
  }
  return { x: sx / points.length, z: sz / points.length };
}

export function downsample(points: Point[], target: number): Point[] {
  if (points.length <= target) return points;
  const step = points.length / target;
  return Array.from({ length: target }, (_, i) => points[Math.floor(i * step)]);
}

export function procrustes(source: Point[], target: Point[]): Transform {
  const cSrc = centroid(source);
  const cTgt = centroid(target);
  const srcCentered = source.map((point) => ({ x: point.x - cSrc.x, z: point.z - cSrc.z }));
  const tgtCentered = target.map((point) => ({ x: point.x - cTgt.x, z: point.z - cTgt.z }));
  let numerator = 0;
  let denominator = 0;
  let sourceNorm = 0;
  let targetNorm = 0;
  for (let i = 0; i < source.length; i++) {
    numerator += srcCentered[i].x * tgtCentered[i].z - srcCentered[i].z * tgtCentered[i].x;
    denominator += srcCentered[i].x * tgtCentered[i].x + srcCentered[i].z * tgtCentered[i].z;
    sourceNorm += srcCentered[i].x ** 2 + srcCentered[i].z ** 2;
    targetNorm += tgtCentered[i].x ** 2 + tgtCentered[i].z ** 2;
  }
  const rotation = Math.atan2(numerator, denominator);
  const scale = sourceNorm > 0 ? Math.sqrt(targetNorm / sourceNorm) : 1;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  return {
    scale,
    rotation,
    tx: cTgt.x - scale * (cos * cSrc.x - sin * cSrc.z),
    tz: cTgt.z - scale * (sin * cSrc.x + cos * cSrc.z),
  };
}

export function applyTransform(point: Point, transform: Transform): Point {
  const cos = Math.cos(transform.rotation);
  const sin = Math.sin(transform.rotation);
  return {
    x: transform.scale * (cos * point.x - sin * point.z) + transform.tx,
    z: transform.scale * (sin * point.x + cos * point.z) + transform.tz,
  };
}

function sampleAtFractions(points: Point[], fractions: number[]): Point[] {
  const cumulative = [0];
  for (let i = 1; i < points.length; i++) {
    cumulative.push(cumulative[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z));
  }
  const total = cumulative[cumulative.length - 1];
  return fractions.map((fraction) => {
    const target = fraction * total;
    let segment = 0;
    for (let i = 1; i < cumulative.length; i++) {
      if (cumulative[i] >= target) {
        segment = i - 1;
        break;
      }
      segment = i - 1;
    }
    const length = cumulative[segment + 1] - cumulative[segment];
    const ratio = length > 0 ? (target - cumulative[segment]) / length : 0;
    return {
      x: points[segment].x + ratio * (points[segment + 1].x - points[segment].x),
      z: points[segment].z + ratio * (points[segment + 1].z - points[segment].z),
    };
  });
}

function closestPointError(a: Point[], b: Point[]): number {
  let total = 0;
  for (const point of a) {
    let best = Infinity;
    for (const other of b) best = Math.min(best, (point.x - other.x) ** 2 + (point.z - other.z) ** 2);
    total += best;
  }
  return Math.sqrt(total / a.length);
}

function flipPoint(point: Point, flip: Alignment["flip"]): Point {
  return {
    x: flip === "flipX" || flip === "flipXZ" ? -point.x : point.x,
    z: flip === "flipZ" || flip === "flipXZ" ? -point.z : point.z,
  };
}

export function applyAlignment(point: Point, alignment: Alignment): Point {
  return applyTransform(flipPoint(point, alignment.flip), alignment.transform);
}

/** Find best rigid/scaled alignment, including winding and axis flips. */
export function alignGeometry(source: Point[], target: Point[], sampleCount = 200): Alignment {
  const src = downsample(source, sampleCount);
  const tgt = downsample(target, sampleCount);
  const count = Math.min(src.length, tgt.length);
  const sourceSample = src.slice(0, count);
  const targetSample = tgt.slice(0, count);
  const identityError = closestPointError(sourceSample, targetSample);
  const identity: Transform = { scale: 1, rotation: 0, tx: 0, tz: 0 };
  let best: Alignment = { transform: identity, flip: "", error: identityError };
  const fractions = Array.from({ length: count }, (_, i) => i / count);
  const targetSampled = sampleAtFractions(targetSample, fractions);
  const step = Math.max(1, Math.floor(count / 50));
  const flips: Alignment["flip"][] = ["", "flipX", "flipZ", "flipXZ"];

  for (const flip of flips) {
    const flipped = sourceSample.map((point) => flipPoint(point, flip));
    for (const ordered of [flipped, [...flipped].reverse()]) {
      for (let offset = 0; offset < count; offset += step) {
        const shifted = fractions.map((fraction) => (fraction + offset / count) % 1);
        const sourceSampled = sampleAtFractions(ordered, shifted);
        const transform = procrustes(sourceSampled, targetSampled);
        const transformed = sourceSampled.map((point) => applyTransform(point, transform));
        let error = 0;
        for (let i = 0; i < count; i++) error += (transformed[i].x - targetSampled[i].x) ** 2 + (transformed[i].z - targetSampled[i].z) ** 2;
        error = Math.sqrt(error / count);
        if (error < best.error) best = { transform, flip, error };
      }
    }
  }

  const aligned = sourceSample.map((point) => applyAlignment(point, best));
  return { ...best, error: closestPointError(aligned, targetSample) };
}
