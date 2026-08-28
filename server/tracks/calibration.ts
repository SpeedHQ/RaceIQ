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

interface CalibrationSample {
  point: Point;
  lapNumber: number;
}

interface CalibrationState {
  transform: Transform | null;
  sourcePoints: Point[];     // bounded progress-bin representatives
  samplesByBin: Array<CalibrationSample | null>;
  lastLap: number;
  collecting: boolean;
}

const PROGRESS_BIN_COUNT = 100;

// One calibration per track — persists for the server lifetime.
// Re-calibrates each time the player completes a full lap.
const calibrations = new Map<number, CalibrationState>();
// Cache for static transforms (TUMFTM center-line → recorded source outline)
const staticTransforms = new Map<number, Transform>();
// Tracks which ordinals have been curb-refined to avoid re-running
const curbRefined = new Set<number>();

const MIN_POINT_SEPARATION_SQ = 25; // 5m squared
const MIN_CALIBRATION_POINTS = 50;
const STATIC_ALIGNMENT_SAMPLES = 500;
const STATIC_ALIGNMENT_OFFSET_STEPS = 36;
const CURB_ALIGNMENT_SAMPLES = 300;
const CURB_ALIGNMENT_OFFSET_STEPS = 36;
const CURB_OFFSET_CHECK_SAMPLES = 50;
const CURB_ANCHOR_WEIGHT = 3;
const CURB_ANCHOR_MAX_DIST = 50;

/**
 * Keep points that are at least `minSeparationSq` away from the previous kept point.
 */
function pushIfFarEnough(points: Point[], point: Point, minSeparationSq: number): void {
  const last = points[points.length - 1];
  if (!last) {
    points.push(point);
    return;
  }

  const dx = point.x - last.x;
  const dz = point.z - last.z;
  if (dx * dx + dz * dz > minSeparationSq) points.push(point);
}

/**
 * Filter zero points and downsample by fixed spatial spacing.
 */
function collectSpatiallyDistinct(points: Point[], minSeparationSq: number): Point[] {
  const filtered: Point[] = [];
  for (const p of points) {
    if (p.x === 0 && p.z === 0) continue;
    pushIfFarEnough(filtered, p, minSeparationSq);
  }
  return filtered;
}

function squaredDistance(a: Point, b: Point): number {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return dx * dx + dz * dz;
}

/**
 * Find the closest point index on an outline for a given position.
 */
function closestPointIdx(outline: Point[], p: Point): number {
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < outline.length; i++) {
    const dist = squaredDistance(outline[i], p);
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = i;
    }
  }
  return bestIdx;
}

/**
 * Build transform from bounded source evidence paired to outline by normalized arc position.
 * Iteratively trims largest residuals so isolated telemetry outliers cannot dominate.
 */
/**
 * Build transform from bounded source evidence paired to outline by normalized
 * evidence order. This avoids assuming source and outline share coordinates.
 * Iteratively trims largest residuals so isolated telemetry outliers cannot dominate.
 */
function buildAlignmentTransform(sourcePoints: Point[], outline: Point[]): Transform {
  const arc = normalizedArcLengths(outline);
  const paired = sourcePoints.map((point, index) => ({
    source: point,
    target: interpolateAtFrac(outline, arc, index / Math.max(1, sourcePoints.length)),
  }));
  let active = paired;
  for (let pass = 0; pass < 2; pass++) {
    const transform = procrustes(active.map(pair => pair.source), active.map(pair => pair.target));
    if (active.length < 3) return transform;
    const ranked = active.map(pair => {
      const mapped = applyTransform(pair.source, transform);
      return { pair, error: squaredDistance(mapped, pair.target) };
    }).sort((a, b) => a.error - b.error);
    active = ranked.slice(0, Math.max(3, Math.ceil(ranked.length * 0.8))).map(item => item.pair);
  }
  return procrustes(active.map(pair => pair.source), active.map(pair => pair.target));
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
 * Procrustes alignment: find best scale + rotation + translation
 * to map `source` points onto `target` points (both same length).
 * Returns the transform to apply to ALL source-space points.
 */
function procrustes(source: Point[], target: Point[]): Transform {
  const n = source.length;
  const cSrc = centroid(source);
  const cTgt = centroid(target);

  // Center values inline: avoids allocating two point arrays for every fit.
  // Each accumulator retains the same point order as the expanded formulation.
  let num = 0, den = 0;
  let srcNorm = 0, tgtNorm = 0;
  for (let i = 0; i < n; i++) {
    const srcX = source[i].x - cSrc.x;
    const srcZ = source[i].z - cSrc.z;
    const tgtX = target[i].x - cTgt.x;
    const tgtZ = target[i].z - cTgt.z;
    num += srcX * tgtZ - srcZ * tgtX;
    den += srcX * tgtX + srcZ * tgtZ;
    srcNorm += srcX * srcX + srcZ * srcZ;
    tgtNorm += tgtX * tgtX + tgtZ * tgtZ;
  }
  const rotation = Math.atan2(num, den);
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
 * Sample points on a closed polygon by normalized arc-length fraction.
 */
function sampleByArc(points: Point[], arcLens: number[], sampleCount: number, fractionOffset = 0): Point[] {
  const out: Point[] = new Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    out[i] = interpolateAtFrac(points, arcLens, i / sampleCount + fractionOffset);
  }
  return out;
}

/**
 * Compute sum of squared distance between transformed source samples and target samples.
 */
function alignmentErrorFromSamples(sourceSamples: Point[], targetSamples: Point[], transform: Transform): number {
  let error = 0;
  for (let i = 0; i < sourceSamples.length; i++) {
    const mapped = applyTransform(sourceSamples[i], transform);
    const dx = mapped.x - targetSamples[i].x;
    const dz = mapped.z - targetSamples[i].z;
    error += dx * dx + dz * dz;
  }
  return error;
}

/**
 * Compute alignment error at a rotation-offset on arc-length fractions.
 */
function alignmentErrorAtOffset(
  source: Point[],
  sourceArc: number[],
  target: Point[],
  targetArc: number[],
  transform: Transform,
  sampleCount: number,
  fractionOffset: number,
  sampleLimit: number
): number {
  let error = 0;
  const limit = Math.min(sampleCount, sampleLimit);
  for (let i = 0; i < limit; i++) {
    const mapped = applyTransform(
      interpolateAtFrac(source, sourceArc, i / sampleCount),
      transform
    );
    const targetPoint = interpolateAtFrac(target, targetArc, i / sampleCount + fractionOffset);
    const dx = mapped.x - targetPoint.x;
    const dz = mapped.z - targetPoint.z;
    error += dx * dx + dz * dz;
  }
  return error;
}

function hasUsableOutline(outline: Point[]): boolean {
  if (outline.length < 2 || outline.some(point => !Number.isFinite(point.x) || !Number.isFinite(point.z))) {
    return false;
  }
  return normalizedArcLengths(outline).some((value, index, values) => index > 0 && value > values[index - 1]!);
}

/**
 * Feed a telemetry position. Collects points and auto-calibrates after a lap.
 */
export function feedCalibrationPosition(
  trackOrdinal: number,
  sourcePos: Point,
  lapNumber: number,
  outline: Point[],
  normalizedProgress?: number
): void {
  if (!Number.isFinite(sourcePos.x) || !Number.isFinite(sourcePos.z) ||
      (sourcePos.x === 0 && sourcePos.z === 0) || !hasUsableOutline(outline)) return;

  let state = calibrations.get(trackOrdinal);
  if (!state) {
    state = {
      transform: null,
      sourcePoints: [],
      samplesByBin: Array(PROGRESS_BIN_COUNT).fill(null),
      lastLap: lapNumber,
      collecting: true,
    };
    calibrations.set(trackOrdinal, state);
  }
  const geometricProgress = normalizedArcLengths(outline)[closestPointIdx(outline, sourcePos)];
  const progress = Number.isFinite(normalizedProgress)
    ? Math.max(0, Math.min(1, normalizedProgress!))
    : geometricProgress;
  if (!Number.isFinite(progress) || progress < 0 || progress > 1) return;
  const bin = Math.min(PROGRESS_BIN_COUNT - 1, Math.floor(progress * PROGRESS_BIN_COUNT));
  const previous = state.samplesByBin[bin];
  if (!previous || lapNumber > previous.lapNumber) {
    state.samplesByBin[bin] = { point: sourcePos, lapNumber };
    state.sourcePoints = state.samplesByBin
      .filter((sample): sample is CalibrationSample => sample !== null)
      .map(sample => sample.point);
  }

  // Trigger calibration at lap boundary without discarding session evidence.
  if (lapNumber > state.lastLap && state.sourcePoints.length > MIN_CALIBRATION_POINTS) {
    calibrate(trackOrdinal, outline);
    state.collecting = true;
  }
  state.lastLap = Math.max(state.lastLap, lapNumber);
}

/**
 * Run Procrustes calibration using collected source points vs outline.
 */
function calibrate(trackOrdinal: number, outline: Point[]): void {
  const state = calibrations.get(trackOrdinal);
  if (!state || state.sourcePoints.length < MIN_CALIBRATION_POINTS) return;
  const transform = buildAlignmentTransform(state.sourcePoints, outline);
  state.transform = transform;
  state.collecting = false;
}

export function calibrateFromPositions(
  trackOrdinal: number,
  positions: Point[],
  outline: Point[]
): boolean {
  if (!hasUsableOutline(outline)) return false;
  const validPositions = positions.filter(point =>
    Number.isFinite(point.x) && Number.isFinite(point.z) && !(point.x === 0 && point.z === 0)
  );
  const filtered = collectSpatiallyDistinct(validPositions, MIN_POINT_SEPARATION_SQ);
  if (filtered.length < MIN_CALIBRATION_POINTS) return false;
  const samplesByBin: Array<CalibrationSample | null> = Array(PROGRESS_BIN_COUNT).fill(null);
  for (let index = 0; index < filtered.length; index++) {
    const bin = Math.min(PROGRESS_BIN_COUNT - 1, Math.floor(index * PROGRESS_BIN_COUNT / filtered.length));
    if (!samplesByBin[bin]) samplesByBin[bin] = { point: filtered[index]!, lapNumber: 0 };
  }
  const sourcePoints = samplesByBin
    .filter((sample): sample is CalibrationSample => sample !== null)
    .map(sample => sample.point);
  if (sourcePoints.length < MIN_CALIBRATION_POINTS) return false;
  const transform = buildAlignmentTransform(sourcePoints, outline);
  calibrations.set(trackOrdinal, {
    transform,
    sourcePoints,
    samplesByBin,
    lastLap: 0,
    collecting: false,
  });
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
  const liveTransform = calibrations.get(trackOrdinal)?.transform;
  const transform = liveTransform
    ? invertTransform(liveTransform)
    : staticTransforms.get(trackOrdinal);
  return transform ? points.map((point) => applyTransform(point, transform)) : null;
}


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
  for (let i = 0; i < dists.length; i++) dists[i] /= total;
  return dists;
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
  const N = Math.min(tumftmOutline.length, STATIC_ALIGNMENT_SAMPLES);
  const srcSampled = sampleByArc(tumftmOutline, srcArc, N);

  // Try different rotational offsets to find the best start-point alignment.
  // Test fixed rotational offsets and pick the one with lowest error.
  let bestTransform: Transform | null = null;
  let bestError = Infinity;

  for (let oi = 0; oi < STATIC_ALIGNMENT_OFFSET_STEPS; oi++) {
    const offset = oi / STATIC_ALIGNMENT_OFFSET_STEPS;
    const tgtSampled = sampleByArc(sourceOutline, tgtArc, N, offset);
    const transform = procrustes(srcSampled, tgtSampled);
    const error = alignmentErrorFromSamples(srcSampled, tgtSampled, transform);

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
  let baseline = staticTransforms.get(trackOrdinal);
  if (!baseline) {
    computeStaticAlignment(trackOrdinal, tumftmOutline, sourceOutline);
    baseline = staticTransforms.get(trackOrdinal);
  }
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
      const distLeft = Math.sqrt(squaredDistance(
        tumftmBoundaries.leftEdge[nearestIdxLeft],
        approxTumftm
      ));
      const distRight = Math.sqrt(squaredDistance(
        tumftmBoundaries.rightEdge[nearestIdxRight],
        approxTumftm
      ));
      const useLeft = distLeft <= distRight;
      const boundary = useLeft ? tumftmBoundaries.leftEdge : tumftmBoundaries.rightEdge;
      const nearestIdx = useLeft ? nearestIdxLeft : nearestIdxRight;
      const nearestDist = useLeft ? distLeft : distRight;

      // Only use if reasonably close to avoid mismatches.
      if (nearestDist < CURB_ANCHOR_MAX_DIST) {
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
  const N = Math.min(tumftmOutline.length, CURB_ALIGNMENT_SAMPLES);

  // Find the offset producing the lowest error with the current transform.
  let bestOffset = 0;
  let bestOffsetError = Infinity;
  for (let oi = 0; oi < CURB_ALIGNMENT_OFFSET_STEPS; oi++) {
    const offset = oi / CURB_ALIGNMENT_OFFSET_STEPS;
    const error = alignmentErrorAtOffset(
      tumftmOutline,
      srcArc,
      sourceOutline,
      tgtArc,
      baseline,
      N,
      offset,
      CURB_OFFSET_CHECK_SAMPLES
    );
    if (error < bestOffsetError) {
      bestOffsetError = error;
      bestOffset = offset;
    }
  }

  // Sample center-line correspondences.
  const centerSrc = sampleByArc(tumftmOutline, srcArc, N);
  const centerTgt = sampleByArc(sourceOutline, tgtArc, N, bestOffset);
  const combinedSrc = centerSrc.slice();
  const combinedTgt = centerTgt.slice();

  // Weight curb anchors without constructing repeated temporary arrays.
  for (let w = 0; w < CURB_ANCHOR_WEIGHT; w++) {
    combinedSrc.push(...srcPoints);
    combinedTgt.push(...tgtPoints);
  }

  // Step 4: Run refined Procrustes
  const refinedTransform = procrustes(combinedSrc, combinedTgt);

  const rmse = Math.sqrt(
    alignmentErrorFromSamples(centerSrc, centerTgt, refinedTransform) / N
  );

  const oldTransform = staticTransforms.get(trackOrdinal);
  const oldRmse = oldTransform
    ? Math.sqrt(alignmentErrorFromSamples(centerSrc, centerTgt, oldTransform) / N)
    : Infinity;

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

