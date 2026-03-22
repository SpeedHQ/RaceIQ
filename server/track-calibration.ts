/**
 * Track calibration: aligns external track outlines (TUMFTM/OSM coordinates)
 * with Forza's in-game coordinate system using Procrustes alignment.
 *
 * When a player drives a lap, we collect their Forza positions and shape-match
 * against the known outline to compute a transform (scale + rotation + translation).
 * Once calibrated, we can project any live Forza position onto the outline.
 */

interface Point {
  x: number;
  z: number;
}

interface Transform {
  scale: number;
  rotation: number; // radians
  tx: number;
  tz: number;
}

interface CalibrationState {
  transform: Transform | null;
  forzaPoints: Point[];     // collected during driving
  lastLap: number;
  collecting: boolean;
}

// One calibration per track — persists for the server lifetime.
// Re-calibrates each time the player completes a full lap.
const calibrations = new Map<number, CalibrationState>();

/**
 * Find the closest point index on an outline for a given position.
 */
function closestPointIdx(outline: Point[], p: Point): number {
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < outline.length; i++) {
    const dx = outline[i].x - p.x;
    const dz = outline[i].z - p.z;
    const d = dx * dx + dz * dz;
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }
  return bestIdx;
}

/**
 * Compute centroid of a set of points.
 */
function centroid(points: Point[]): Point {
  let sx = 0, sz = 0;
  for (const p of points) { sx += p.x; sz += p.z; }
  return { x: sx / points.length, z: sz / points.length };
}

/**
 * Downsample points to a target count using uniform spacing.
 */
function downsample(points: Point[], target: number): Point[] {
  if (points.length <= target) return points;
  const step = points.length / target;
  const result: Point[] = [];
  for (let i = 0; i < target; i++) {
    result.push(points[Math.floor(i * step)]);
  }
  return result;
}

/**
 * Procrustes alignment: find best scale + rotation + translation
 * to map `source` points onto `target` points (both same length).
 * Returns the transform to apply to ALL source-space points.
 */
function procrustes(source: Point[], target: Point[]): Transform {
  const n = source.length;
  const cSrc = centroid(source);
  const cTgt = centroid(target);

  // Center both sets
  const srcC = source.map((p) => ({ x: p.x - cSrc.x, z: p.z - cSrc.z }));
  const tgtC = target.map((p) => ({ x: p.x - cTgt.x, z: p.z - cTgt.z }));

  // Optimal rotation via cross/dot product sums (closed-form 2D SVD).
  // num = sum of cross products (sine component), den = sum of dot products (cosine).
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += srcC[i].x * tgtC[i].z - srcC[i].z * tgtC[i].x;
    den += srcC[i].x * tgtC[i].x + srcC[i].z * tgtC[i].z;
  }
  const rotation = Math.atan2(num, den);

  // Compute scale
  let srcNorm = 0, tgtNorm = 0;
  for (let i = 0; i < n; i++) {
    srcNorm += srcC[i].x * srcC[i].x + srcC[i].z * srcC[i].z;
    tgtNorm += tgtC[i].x * tgtC[i].x + tgtC[i].z * tgtC[i].z;
  }
  const scale = srcNorm > 0 ? Math.sqrt(tgtNorm / srcNorm) : 1;

  // Translation: apply rotation + scale to source centroid, then offset to target centroid
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const tx = cTgt.x - scale * (cos * cSrc.x - sin * cSrc.z);
  const tz = cTgt.z - scale * (sin * cSrc.x + cos * cSrc.z);

  return { scale, rotation, tx, tz };
}

/**
 * Apply transform to a point (from Forza space to outline space).
 */
function applyTransform(p: Point, t: Transform): Point {
  const cos = Math.cos(t.rotation);
  const sin = Math.sin(t.rotation);
  return {
    x: t.scale * (cos * p.x - sin * p.z) + t.tx,
    z: t.scale * (sin * p.x + cos * p.z) + t.tz,
  };
}

/**
 * Invert a Procrustes transform (outline space → Forza space).
 * Used to project boundary/pit lane data from TUMFTM coords into Forza coords.
 */
function invertTransform(t: Transform): Transform {
  const invScale = 1 / t.scale;
  const invRotation = -t.rotation;
  const cos = Math.cos(invRotation);
  const sin = Math.sin(invRotation);
  return {
    scale: invScale,
    rotation: invRotation,
    tx: invScale * (cos * -t.tx - sin * -t.tz),
    tz: invScale * (sin * -t.tx + cos * -t.tz),
  };
}

/**
 * Feed a telemetry position. Collects points and auto-calibrates after a lap.
 */
export function feedPosition(
  trackOrdinal: number,
  forzaPos: Point,
  lapNumber: number,
  outline: Point[]
): void {
  let state = calibrations.get(trackOrdinal);
  if (!state) {
    state = { transform: null, forzaPoints: [], lastLap: lapNumber, collecting: true };
    calibrations.set(trackOrdinal, state);
  }

  // Skip zero positions
  if (forzaPos.x === 0 && forzaPos.z === 0) return;

  // Detect lap boundary — trigger calibration
  if (lapNumber > state.lastLap && state.forzaPoints.length > 50) {
    calibrate(trackOrdinal, outline);
    state.forzaPoints = [];
    state.collecting = true;
  }
  state.lastLap = lapNumber;

  // Spatial downsampling: only keep points >5m apart to avoid
  // clustering at slow corners and gaps on straights
  if (state.collecting) {
    const last = state.forzaPoints[state.forzaPoints.length - 1];
    if (!last) {
      state.forzaPoints.push(forzaPos);
    } else {
      const dx = forzaPos.x - last.x;
      const dz = forzaPos.z - last.z;
      if (dx * dx + dz * dz > 25) { // 25 = 5m squared
        state.forzaPoints.push(forzaPos);
      }
    }
  }
}

/**
 * Run Procrustes calibration using collected Forza points vs outline.
 */
function calibrate(trackOrdinal: number, outline: Point[]): void {
  const state = calibrations.get(trackOrdinal);
  if (!state || state.forzaPoints.length < 50) return;

  // Downsample both to same count for alignment
  const n = Math.min(state.forzaPoints.length, outline.length, 200);
  const srcSampled = downsample(state.forzaPoints, n);
  const tgtSampled = downsample(outline, n);

  const transform = procrustes(srcSampled, tgtSampled);
  state.transform = transform;
  state.collecting = false;

  console.log(
    `[Calibration] Track ${trackOrdinal} calibrated: scale=${transform.scale.toFixed(3)} rot=${(transform.rotation * 180 / Math.PI).toFixed(1)}°`
  );
}

/**
 * Get the normalized position (0-1) of a Forza position along the outline.
 * Returns null if not calibrated.
 */
export function getNormalizedPosition(
  trackOrdinal: number,
  forzaPos: Point,
  outline: Point[]
): number | null {
  const state = calibrations.get(trackOrdinal);
  if (!state?.transform) return null;

  const mapped = applyTransform(forzaPos, state.transform);
  const idx = closestPointIdx(outline, mapped);
  return idx / outline.length;
}

/**
 * Check if a track is calibrated.
 */
export function isCalibrated(trackOrdinal: number): boolean {
  return calibrations.get(trackOrdinal)?.transform != null;
}

/**
 * Get calibration state for API.
 */
export function getCalibrationStatus(trackOrdinal: number): {
  calibrated: boolean;
  pointsCollected: number;
  transform: Transform | null;
} {
  const state = calibrations.get(trackOrdinal);
  return {
    calibrated: state?.transform != null,
    pointsCollected: state?.forzaPoints.length ?? 0,
    transform: state?.transform ?? null,
  };
}

/**
 * Transform an array of points from outline/TUMFTM space to Forza space.
 * Uses live calibration if available, otherwise falls back to static alignment
 * computed from known point sets.
 * Returns null if no transform is available.
 */
export function transformToForzaSpace(
  trackOrdinal: number,
  points: Point[]
): Point[] | null {
  // Try live calibration first
  const state = calibrations.get(trackOrdinal);
  if (state?.transform) {
    const inv = invertTransform(state.transform);
    return points.map((p) => applyTransform(p, inv));
  }

  // Try static alignment
  const staticTransform = staticTransforms.get(trackOrdinal);
  if (staticTransform) {
    return points.map((p) => applyTransform(p, staticTransform));
  }

  return null;
}

// Cache for static transforms (TUMFTM center-line → recorded Forza outline)
const staticTransforms = new Map<number, Transform>();

/**
 * Compute cumulative arc length for a closed polygon, normalized to [0, 1].
 */
function normalizedArcLengths(pts: Point[]): number[] {
  const dists = [0];
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i].x - pts[i - 1].x;
    const dz = pts[i].z - pts[i - 1].z;
    dists.push(dists[i - 1] + Math.sqrt(dx * dx + dz * dz));
  }
  const total = dists[dists.length - 1];
  if (total === 0) return dists;
  return dists.map(d => d / total);
}

/**
 * Interpolate a point on a polyline at a given normalized arc length fraction.
 */
function interpolateAtFrac(pts: Point[], arcLens: number[], frac: number): Point {
  // Wrap fraction to [0, 1)
  const f = ((frac % 1) + 1) % 1;
  // Binary search for the segment
  let lo = 0, hi = arcLens.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (arcLens[mid] <= f) lo = mid; else hi = mid;
  }
  const segLen = arcLens[hi] - arcLens[lo];
  const t = segLen > 0 ? (f - arcLens[lo]) / segLen : 0;
  return {
    x: pts[lo].x + (pts[hi].x - pts[lo].x) * t,
    z: pts[lo].z + (pts[hi].z - pts[lo].z) * t,
  };
}

/**
 * Compute and cache a static transform from TUMFTM coords to Forza coords
 * using arc-length correspondence. Both outlines trace the same closed track,
 * so we match points by their normalized distance around the loop. We also
 * search for the best rotational offset (where on the loop each outline starts).
 */
export function computeStaticAlignment(
  trackOrdinal: number,
  tumftmOutline: Point[],
  forzaOutline: Point[]
): void {
  if (staticTransforms.has(trackOrdinal)) return; // already computed
  if (tumftmOutline.length < 20 || forzaOutline.length < 20) return;

  const srcArc = normalizedArcLengths(tumftmOutline);
  const tgtArc = normalizedArcLengths(forzaOutline);

  // Sample N evenly spaced points from the source (TUMFTM)
  const N = Math.min(tumftmOutline.length, 500);
  const srcSampled: Point[] = [];
  for (let i = 0; i < N; i++) {
    srcSampled.push(interpolateAtFrac(tumftmOutline, srcArc, i / N));
  }

  // Try different rotational offsets to find the best start-point alignment.
  // Test 36 offsets (every 10% of the track) and pick the one with lowest error.
  let bestTransform: Transform | null = null;
  let bestError = Infinity;
  const offsets = 36;

  for (let oi = 0; oi < offsets; oi++) {
    const offset = oi / offsets;

    // Sample target points at corresponding arc-length fractions + offset
    const tgtSampled: Point[] = [];
    for (let i = 0; i < N; i++) {
      tgtSampled.push(interpolateAtFrac(forzaOutline, tgtArc, i / N + offset));
    }

    const transform = procrustes(srcSampled, tgtSampled);

    // Compute alignment error (sum of squared distances after transform)
    let error = 0;
    for (let i = 0; i < N; i++) {
      const mapped = applyTransform(srcSampled[i], transform);
      const dx = mapped.x - tgtSampled[i].x;
      const dz = mapped.z - tgtSampled[i].z;
      error += dx * dx + dz * dz;
    }

    if (error < bestError) {
      bestError = error;
      bestTransform = transform;
    }
  }

  if (bestTransform) {
    staticTransforms.set(trackOrdinal, bestTransform);
    const rmse = Math.sqrt(bestError / N);
    console.log(
      `[Calibration] Static alignment for track ${trackOrdinal}: scale=${bestTransform.scale.toFixed(3)} rot=${(bestTransform.rotation * 180 / Math.PI).toFixed(1)}° RMSE=${rmse.toFixed(1)}m`
    );
  }
}
