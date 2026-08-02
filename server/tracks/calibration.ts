/**
 * Track calibration: aligns external track outlines (TUMFTM/OSM coordinates)
 * with source coordinate space using Procrustes alignment.
 *
 * When a player drives a lap, we collect source positions and shape-match
 * against the known outline to compute a transform (scale + rotation + translation).
 * Once calibrated, we can project any live source position onto the outline.
 */
interface Point {
  x: number;
  z: number;
}

export interface Transform {
  scale: number;
  rotation: number; // radians
  tx: number;
  tz: number;
}

interface CalibrationState {
  transform: Transform | null;
  sourcePoints: Point[];     // collected during driving
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
 * Apply transform to a point (from source space to outline space).
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
 * Invert a Procrustes transform (outline space → source space).
 * Used to project boundary/pit lane data from TUMFTM coords into source coords.
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
export function feedCalibrationPosition(
  trackOrdinal: number,
  sourcePos: Point,
  lapNumber: number,
  outline: Point[]
): void {
  let state = calibrations.get(trackOrdinal);
  if (!state) {
    state = { transform: null, sourcePoints: [], lastLap: lapNumber, collecting: true };
    calibrations.set(trackOrdinal, state);
  }

  // Skip zero positions
  if (sourcePos.x === 0 && sourcePos.z === 0) return;

  // Detect lap boundary — trigger calibration
  if (lapNumber > state.lastLap && state.sourcePoints.length > 50) {
    calibrate(trackOrdinal, outline);
    state.sourcePoints = [];
    state.collecting = true;
  }
  state.lastLap = lapNumber;

  // Spatial downsampling: only keep points >5m apart to avoid
  // clustering at slow corners and gaps on straights
  if (state.collecting) {
    const last = state.sourcePoints[state.sourcePoints.length - 1];
    if (!last) {
      state.sourcePoints.push(sourcePos);
    } else {
      const dx = sourcePos.x - last.x;
      const dz = sourcePos.z - last.z;
      if (dx * dx + dz * dz > 25) { // 25 = 5m squared
        state.sourcePoints.push(sourcePos);
      }
    }
  }
}

/**
 * Run Procrustes calibration using collected source points vs outline.
 */
function calibrate(trackOrdinal: number, outline: Point[]): void {
  const state = calibrations.get(trackOrdinal);
  if (!state || state.sourcePoints.length < 50) return;

  // Downsample both to same count for alignment
  const n = Math.min(state.sourcePoints.length, outline.length, 200);
  const srcSampled = downsample(state.sourcePoints, n);
  const tgtSampled = downsample(outline, n);

  const transform = procrustes(srcSampled, tgtSampled);
  state.transform = transform;
  state.collecting = false;

  console.log(
    `[Calibration] Track ${trackOrdinal} calibrated: scale=${transform.scale.toFixed(3)} rot=${(transform.rotation * 180 / Math.PI).toFixed(1)}°`
  );
}


/**
 * Calibrate from an array of source positions (e.g. from a stored lap).
 * Applies the same spatial downsampling and Procrustes alignment as live calibration.
 * Returns true if calibration succeeded.
 */
export function calibrateFromPositions(
  trackOrdinal: number,
  positions: Point[],
  outline: Point[]
): boolean {
  // Filter zero positions and spatially downsample (>5m apart)
  const filtered: Point[] = [];
  for (const p of positions) {
    if (p.x === 0 && p.z === 0) continue;
    const last = filtered[filtered.length - 1];
    if (!last) {
      filtered.push(p);
    } else {
      const dx = p.x - last.x;
      const dz = p.z - last.z;
      if (dx * dx + dz * dz > 25) {
        filtered.push(p);
      }
    }
  }

  if (filtered.length < 50) return false;

  // Set up calibration state with collected points
  let state = calibrations.get(trackOrdinal);
  if (!state) {
    state = { transform: null, sourcePoints: [], lastLap: 0, collecting: false };
    calibrations.set(trackOrdinal, state);
  }
  state.sourcePoints = filtered;

  // Run Procrustes alignment
  const n = Math.min(filtered.length, outline.length, 200);
  const srcSampled = downsample(filtered, n);
  const tgtSampled = downsample(outline, n);

  const transform = procrustes(srcSampled, tgtSampled);
  state.transform = transform;
  state.collecting = false;

  console.log(
    `[Calibration] Track ${trackOrdinal} calibrated from stored lap: scale=${transform.scale.toFixed(3)} rot=${(transform.rotation * 180 / Math.PI).toFixed(1)}° (${filtered.length} points)`
  );
  return true;
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
    pointsCollected: state?.sourcePoints.length ?? 0,
    transform: state?.transform ?? null,
  };
}

/**
 * Transform an array of points from outline/TUMFTM space to source space.
 * Uses live calibration if available, otherwise falls back to static alignment
 * computed from known point sets.
 * Returns null if no transform is available.
 */
export function transformToSourceSpace(
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

// Cache for static transforms (TUMFTM center-line → recorded source outline)
const staticTransforms = new Map<number, Transform>();
// Tracks which ordinals have been curb-refined to avoid re-running
const curbRefined = new Set<number>();

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
 * Compute and cache a static transform from TUMFTM coords to source coords
 * using arc-length correspondence. Both outlines trace the same closed track,
 * so we match points by their normalized distance around the loop. We also
 * search for the best rotational offset (where on the loop each outline starts).
 */
export function computeStaticAlignment(
  trackOrdinal: number,
  tumftmOutline: Point[],
  sourceOutline: Point[]
): void {
  if (staticTransforms.has(trackOrdinal)) return; // already computed
  if (tumftmOutline.length < 20 || sourceOutline.length < 20) return;

  const srcArc = normalizedArcLengths(tumftmOutline);
  const tgtArc = normalizedArcLengths(sourceOutline);

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
      tgtSampled.push(interpolateAtFrac(sourceOutline, tgtArc, i / N + offset));
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

/**
 * Refine the static alignment using curb data as boundary anchor points.
 * Curb positions are ground-truth source-space locations of track edges.
 * We match them to the nearest TUMFTM boundary points and re-run Procrustes
 * with both center-line and boundary correspondences for a more accurate fit.
 */
export function refineAlignmentWithCurbs(
  trackOrdinal: number,
  tumftmOutline: Point[],
  sourceOutline: Point[],
  tumftmBoundaries: { leftEdge: Point[]; rightEdge: Point[] },
  curbSegments: { points: Point[]; side: "left" | "right" | "both" }[]
): void {
  if (tumftmOutline.length < 20 || sourceOutline.length < 20) return;
  if (curbSegments.length === 0) return;
  if (curbRefined.has(trackOrdinal)) return; // already refined

  // Step 1: Get existing static alignment as starting point
  const existing = staticTransforms.get(trackOrdinal);
  if (!existing) {
    // Need baseline alignment first
    computeStaticAlignment(trackOrdinal, tumftmOutline, sourceOutline);
  }
  const baseline = staticTransforms.get(trackOrdinal);
  if (!baseline) return;

  // Step 2: Collect curb positions in source space and find corresponding TUMFTM boundary points
  // Use inverse baseline to map source curb positions to approximate TUMFTM space,
  // then find closest boundary point for each
  const inv = invertTransform(baseline);
  const srcPoints: Point[] = []; // TUMFTM boundary points
  const tgtPoints: Point[] = []; // Source curb positions

  for (const seg of curbSegments) {
    // Downsample each curb segment to avoid over-weighting long curbs
    const step = Math.max(1, Math.floor(seg.points.length / 5));
    for (let i = 0; i < seg.points.length; i += step) {
      const sourcePt = seg.points[i];

      // Map source curb position back to approximate TUMFTM space
      const approxTumftm = applyTransform(sourcePt, inv);

      // Match against whichever boundary edge is closer (don't rely on side field)
      const nearestIdxLeft = closestPointIdx(tumftmBoundaries.leftEdge, approxTumftm);
      const nearestIdxRight = closestPointIdx(tumftmBoundaries.rightEdge, approxTumftm);
      const distLeft = Math.sqrt(
        (tumftmBoundaries.leftEdge[nearestIdxLeft].x - approxTumftm.x) ** 2 +
        (tumftmBoundaries.leftEdge[nearestIdxLeft].z - approxTumftm.z) ** 2
      );
      const distRight = Math.sqrt(
        (tumftmBoundaries.rightEdge[nearestIdxRight].x - approxTumftm.x) ** 2 +
        (tumftmBoundaries.rightEdge[nearestIdxRight].z - approxTumftm.z) ** 2
      );
      const boundary = distLeft <= distRight ? tumftmBoundaries.leftEdge : tumftmBoundaries.rightEdge;
      const nearestIdx = distLeft <= distRight ? nearestIdxLeft : nearestIdxRight;
      const nearestDist = Math.sqrt(
        (boundary[nearestIdx].x - approxTumftm.x) ** 2 +
        (boundary[nearestIdx].z - approxTumftm.z) ** 2
      );

      // Only use if reasonably close (within ~50m in TUMFTM space) to avoid mismatches
      if (nearestDist < 50) {
        srcPoints.push(boundary[nearestIdx]);
        tgtPoints.push(sourcePt);
      }
    }
  }

  if (srcPoints.length < 5) {
    console.log(`[Calibration] Not enough curb anchors for track ${trackOrdinal}: ${srcPoints.length} points`);
    return;
  }

  // Step 3: Combine center-line correspondences with curb anchor correspondences
  const srcArc = normalizedArcLengths(tumftmOutline);
  const tgtArc = normalizedArcLengths(sourceOutline);

  // Use existing alignment's offset to get the right start-point matching
  const N = Math.min(tumftmOutline.length, 300);

  // Find the best offset from the existing transform by testing which offset
  // gives the lowest error with the current transform
  let bestOffset = 0;
  let bestOffsetError = Infinity;
  for (let oi = 0; oi < 36; oi++) {
    const offset = oi / 36;
    let error = 0;
    for (let i = 0; i < Math.min(N, 50); i++) {
      const src = interpolateAtFrac(tumftmOutline, srcArc, i / N);
      const tgt = interpolateAtFrac(sourceOutline, tgtArc, i / N + offset);
      const mapped = applyTransform(src, baseline);
      const dx = mapped.x - tgt.x;
      const dz = mapped.z - tgt.z;
      error += dx * dx + dz * dz;
    }
    if (error < bestOffsetError) {
      bestOffsetError = error;
      bestOffset = offset;
    }
  }

  // Sample center-line correspondences
  const combinedSrc: Point[] = [];
  const combinedTgt: Point[] = [];
  for (let i = 0; i < N; i++) {
    combinedSrc.push(interpolateAtFrac(tumftmOutline, srcArc, i / N));
    combinedTgt.push(interpolateAtFrac(sourceOutline, tgtArc, i / N + bestOffset));
  }

  // Add curb anchor points (weighted: add each 3x to give boundary data more influence)
  const CURB_WEIGHT = 3;
  for (let w = 0; w < CURB_WEIGHT; w++) {
    combinedSrc.push(...srcPoints);
    combinedTgt.push(...tgtPoints);
  }

  // Step 4: Run refined Procrustes
  const refinedTransform = procrustes(combinedSrc, combinedTgt);

  // Compute RMSE for the refined transform
  let error = 0;
  for (let i = 0; i < N; i++) {
    const mapped = applyTransform(
      interpolateAtFrac(tumftmOutline, srcArc, i / N),
      refinedTransform
    );
    const tgt = interpolateAtFrac(sourceOutline, tgtArc, i / N + bestOffset);
    const dx = mapped.x - tgt.x;
    const dz = mapped.z - tgt.z;
    error += dx * dx + dz * dz;
  }
  const rmse = Math.sqrt(error / N);

  // Only adopt the refined transform if it's actually better
  const oldTransform = staticTransforms.get(trackOrdinal);
  let oldRmse = Infinity;
  if (oldTransform) {
    let oldError = 0;
    for (let i = 0; i < N; i++) {
      const mapped = applyTransform(
        interpolateAtFrac(tumftmOutline, srcArc, i / N),
        oldTransform
      );
      const tgt = interpolateAtFrac(sourceOutline, tgtArc, i / N + bestOffset);
      const dx = mapped.x - tgt.x;
      const dz = mapped.z - tgt.z;
      oldError += dx * dx + dz * dz;
    }
    oldRmse = Math.sqrt(oldError / N);
  }

  console.log(
    `[Calibration] Curb-refined alignment for track ${trackOrdinal}: ` +
    `${srcPoints.length} curb anchors, ` +
    `RMSE ${oldRmse.toFixed(1)}m → ${rmse.toFixed(1)}m, ` +
    `scale=${refinedTransform.scale.toFixed(4)} rot=${(refinedTransform.rotation * 180 / Math.PI).toFixed(2)}°`
  );

  // Always adopt curb-refined since it accounts for lateral offset
  staticTransforms.set(trackOrdinal, refinedTransform);
  curbRefined.add(trackOrdinal);
}

/**
 * Clear curb refinement cache for a track so it re-runs on next request.
 */
export function clearCurbRefinement(trackOrdinal: number): void {
  curbRefined.delete(trackOrdinal);
  staticTransforms.delete(trackOrdinal);
}

