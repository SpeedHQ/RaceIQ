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

const calibrations = new Map<number, CalibrationState>(); // trackOrdinal -> state

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

  // Compute optimal rotation using SVD-like approach for 2D
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

  // Collect points (downsample by distance)
  if (state.collecting) {
    const last = state.forzaPoints[state.forzaPoints.length - 1];
    if (!last) {
      state.forzaPoints.push(forzaPos);
    } else {
      const dx = forzaPos.x - last.x;
      const dz = forzaPos.z - last.z;
      if (dx * dx + dz * dz > 25) { // ~5m spacing
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
} {
  const state = calibrations.get(trackOrdinal);
  return {
    calibrated: state?.transform != null,
    pointsCollected: state?.forzaPoints.length ?? 0,
  };
}
