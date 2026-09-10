import type { TrackBoundary } from "../../shared/racing/tracks/geometry/types";

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
  progress: number;
  lapNumber: number;
}

interface CalibrationHistoryEntry {
  sequence: number;
  lapNumber: number;
  transform: Transform;
  rmse: number | null;
  points: number;
}

interface AlignmentPair {
  source: Point;
  target: Point;
  targetProgress: number;
}

interface AlignmentResult {
  transform: Transform;
  rmse: number;
  points: number;
}

interface CalibrationState {
  transform: Transform | null;
  sourcePoints: Point[];     // bounded progress-bin representatives
  samplesByBin: Array<CalibrationSample | null>;
  lastLap: number;
  collecting: boolean;
  history: CalibrationHistoryEntry[];
  nextSequence: number;
}

function recordCalibration(
  state: CalibrationState,
  samples: CalibrationSample[],
  result: AlignmentResult
): void {
  state.history.push({
    sequence: state.nextSequence++,
    lapNumber: samples.reduce((max, sample) => Math.max(max, sample.lapNumber), 0),
    transform: { ...result.transform },
    rmse: result.rmse,
    points: result.points,
  });
  if (state.history.length > 12) state.history.splice(0, state.history.length - 12);
}

const PROGRESS_BIN_COUNT = 100;
const SOURCE_ARC_MIN_PROGRESS_SPAN = 0.8;
const FIT_RETAIN_FRACTION = 0.8;
const REFINEMENT_PROGRESS_WINDOW = 0.04;
const BOUNDARY_MARGIN_METERS = 0.5;

// One accepted live calibration per track session. Session reset clears it.
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
function hasEnoughSpatialCoverage(samples: readonly CalibrationSample[]): boolean {
  return collectSpatiallyDistinct(samples.map(sample => sample.point), MIN_POINT_SEPARATION_SQ).length >= MIN_CALIBRATION_POINTS;
}

function hasClosedLapCoverage(samples: readonly CalibrationSample[]): boolean {
  const progressByLap = new Map<number, { min: number; max: number }>();
  for (const sample of samples) {
    const coverage = progressByLap.get(sample.lapNumber);
    if (coverage) {
      coverage.min = Math.min(coverage.min, sample.progress);
      coverage.max = Math.max(coverage.max, sample.progress);
    } else {
      progressByLap.set(sample.lapNumber, { min: sample.progress, max: sample.progress });
    }
  }
  const minimumProgress = 2 / PROGRESS_BIN_COUNT;
  const maximumProgress = 1 - minimumProgress;
  return [...progressByLap.values()].some(coverage =>
    coverage.min <= minimumProgress && coverage.max >= maximumProgress);
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

function fitPairs(pairs: AlignmentPair[]): { transform: Transform; active: AlignmentPair[] } {
  let active = pairs;
  for (let pass = 0; pass < 2; pass++) {
    const transform = procrustes(active.map(pair => pair.source), active.map(pair => pair.target));
    if (active.length < 3) return { transform, active };
    active = active
      .map(pair => ({
        pair,
        error: squaredDistance(applyTransform(pair.source, transform), pair.target),
      }))
      .sort((a, b) => a.error - b.error)
      .slice(0, Math.max(3, Math.ceil(active.length * FIT_RETAIN_FRACTION)))
      .map(item => item.pair);
  }
  return {
    transform: procrustes(active.map(pair => pair.source), active.map(pair => pair.target)),
    active,
  };
}

function fitAllPairs(pairs: AlignmentPair[]): { transform: Transform; active: AlignmentPair[] } {
  return {
    transform: procrustes(pairs.map(pair => pair.source), pairs.map(pair => pair.target)),
    active: pairs,
  };
}

function sourceArcPairs(
  samples: CalibrationSample[],
  outline: Point[],
  deriveSourceArc: boolean
): AlignmentPair[] {
  const sorted = [...samples].sort((a, b) => a.progress - b.progress);
  const outlineArc = normalizedArcLengths(outline);
  const progressSpan = sorted.at(-1)!.progress - sorted[0]!.progress;
  if (!deriveSourceArc || progressSpan < SOURCE_ARC_MIN_PROGRESS_SPAN) {
    return sorted.map(sample => ({
      source: sample.point,
      target: interpolateAtFrac(outline, outlineArc, sample.progress),
      targetProgress: sample.progress,
    }));
  }

  const segmentLengths = sorted.slice(1).map((sample, index) =>
    Math.sqrt(squaredDistance(sorted[index]!.point, sample.point)));
  segmentLengths.push(Math.sqrt(squaredDistance(sorted.at(-1)!.point, sorted[0]!.point)));
  const rankedLengths = [...segmentLengths].sort((a, b) => a - b);
  const medianLength = rankedLengths[Math.floor(rankedLengths.length / 2)]!;
  const maximumSegmentLength = medianLength * 4;
  const cumulative = [0];
  for (let i = 1; i < sorted.length; i++) {
    cumulative.push(cumulative[i - 1]! + Math.min(segmentLengths[i - 1]!, maximumSegmentLength));
  }
  const total = cumulative.at(-1)! + Math.min(segmentLengths.at(-1)!, maximumSegmentLength);
  const phase = sorted[0]!.progress;
  return sorted.map((_, index) => {
    const arcProgress = index / sorted.length;
    const distance = arcProgress * total;
    let segment = 0;
    while (segment + 1 < cumulative.length && cumulative[segment + 1]! <= distance) segment++;
    const start = sorted[segment]!.point;
    const end = segment + 1 < sorted.length ? sorted[segment + 1]!.point : sorted[0]!.point;
    const segmentStart = cumulative[segment]!;
    const segmentLength = segment + 1 < sorted.length
      ? Math.min(segmentLengths[segment]!, maximumSegmentLength)
      : Math.min(segmentLengths.at(-1)!, maximumSegmentLength);
    const interpolation = segmentLength > 0
      ? Math.max(0, Math.min(1, (distance - segmentStart) / segmentLength))
      : 0;
    const source = {
      x: start.x + (end.x - start.x) * interpolation,
      z: start.z + (end.z - start.z) * interpolation,
    };
    const targetProgress = phase + arcProgress;
    return {
      source,
      target: interpolateAtFrac(outline, outlineArc, targetProgress),
      targetProgress,
    };
  });
}

function nearestOutlinePair(
  source: Point,
  mapped: Point,
  expectedProgress: number,
  minimumProgress: number,
  outline: Point[],
  outlineArc: number[]
): AlignmentPair | null {
  let best: AlignmentPair | null = null;
  let bestDistance = Infinity;
  for (let i = 0; i < outline.length - 1; i++) {
    const start = outline[i]!;
    const end = outline[i + 1]!;
    const dx = end.x - start.x;
    const dz = end.z - start.z;
    const lengthSq = dx * dx + dz * dz;
    const t = lengthSq > 0
      ? Math.max(0, Math.min(1, ((mapped.x - start.x) * dx + (mapped.z - start.z) * dz) / lengthSq))
      : 0;
    const targetProgress = outlineArc[i]! + (outlineArc[i + 1]! - outlineArc[i]!) * t;
    const unwrappedProgress = targetProgress + Math.round(expectedProgress - targetProgress);
    if (Math.abs(unwrappedProgress - expectedProgress) > REFINEMENT_PROGRESS_WINDOW ||
        unwrappedProgress < minimumProgress) continue;
    const target = { x: start.x + dx * t, z: start.z + dz * t };
    const distance = squaredDistance(mapped, target);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = { source, target, targetProgress: unwrappedProgress };
    }
  }
  return best;
}

function boundaryCenterline(boundary: TrackBoundary | undefined): Point[] | null {
  if (!boundary || boundary.leftEdge.length < 2 || boundary.rightEdge.length < 2) return null;
  const count = Math.min(
    500,
    Math.max(boundary.leftEdge.length, boundary.rightEdge.length)
  );
  const leftArc = normalizedArcLengths(boundary.leftEdge);
  const rightArc = normalizedArcLengths(boundary.rightEdge);
  return Array.from({ length: count }, (_, index) => {
    const progress = index / (count - 1);
    const left = interpolateAtFrac(boundary.leftEdge, leftArc, progress);
    const right = interpolateAtFrac(boundary.rightEdge, rightArc, progress);
    return { x: (left.x + right.x) / 2, z: (left.z + right.z) / 2 };
  });
}

function withinBoundary(
  mapped: Point,
  progress: number,
  boundary: TrackBoundary | undefined,
  leftArc: number[] | undefined,
  rightArc: number[] | undefined
): boolean {
  if (!boundary || !leftArc || !rightArc) return true;
  const left = interpolateAtFrac(boundary.leftEdge, leftArc, progress);
  const right = interpolateAtFrac(boundary.rightEdge, rightArc, progress);
  const center = { x: (left.x + right.x) / 2, z: (left.z + right.z) / 2 };
  const halfWidth = Math.sqrt(squaredDistance(left, right)) / 2;
  return squaredDistance(mapped, center) <= (halfWidth + BOUNDARY_MARGIN_METERS) ** 2;
}


function fitBoundarySeededPairs(
  pairs: AlignmentPair[],
  boundary: TrackBoundary,
  leftArc: number[],
  rightArc: number[]
): { transform: Transform; active: AlignmentPair[] } {
  const fullTransform = procrustes(
    pairs.map(pair => pair.source),
    pairs.map(pair => pair.target)
  );
  const fullInliers = pairs.filter(pair =>
    withinBoundary(
      applyTransform(pair.source, fullTransform),
      pair.targetProgress,
      boundary,
      leftArc,
      rightArc
    ));
  if (fullInliers.length >= pairs.length * 0.8) return fitAllPairs(pairs);
  const windowSize = Math.max(3, Math.ceil(pairs.length * 0.2));
  const stride = Math.max(1, Math.floor(windowSize / 2));
  const candidateTransforms = [fullTransform];
  for (let start = 0; start + windowSize <= pairs.length; start += stride) {
    const window = pairs.slice(start, start + windowSize);
    candidateTransforms.push(
      procrustes(window.map(pair => pair.source), window.map(pair => pair.target))
    );
  }
  let bestInliers: AlignmentPair[] = [];
  let bestError = Infinity;
  for (const transform of candidateTransforms) {
    const inliers = pairs.filter(pair =>
      withinBoundary(
        applyTransform(pair.source, transform),
        pair.targetProgress,
        boundary,
        leftArc,
        rightArc
      ));
    const error = inliers.reduce((sum, pair) =>
      sum + squaredDistance(applyTransform(pair.source, transform), pair.target), 0);
    if (inliers.length > bestInliers.length ||
        (inliers.length === bestInliers.length && error < bestError)) {
      bestInliers = inliers;
      bestError = error;
    }
  }
  return bestInliers.length >= 3 ? fitAllPairs(bestInliers) : fitPairs(pairs);
}

function buildAlignmentTransform(
  samples: CalibrationSample[],
  outline: Point[],
  boundary?: TrackBoundary,
  deriveSourceArc = true
): AlignmentResult {
  const targetOutline = boundaryCenterline(boundary) ?? outline;
  let pairs = sourceArcPairs(samples, targetOutline, deriveSourceArc);
  const outlineArc = normalizedArcLengths(targetOutline);
  const leftArc = boundary?.leftEdge.length && boundary.leftEdge.length > 1
    ? normalizedArcLengths(boundary.leftEdge)
    : undefined;
  const rightArc = boundary?.rightEdge.length && boundary.rightEdge.length > 1
    ? normalizedArcLengths(boundary.rightEdge)
    : undefined;
  let fitted = boundary && leftArc && rightArc
    ? fitBoundarySeededPairs(pairs, boundary, leftArc, rightArc)
    : fitPairs(pairs);
  for (let pass = 0; pass < (boundary ? 0 : 2); pass++) {
    let minimumProgress = -Infinity;
    const refined: AlignmentPair[] = [];
    for (const pair of pairs) {
      const mapped = applyTransform(pair.source, fitted.transform);
      const match = nearestOutlinePair(
        pair.source,
        mapped,
        pair.targetProgress,
        minimumProgress,
        targetOutline,
        outlineArc
      );
      if (!match || !withinBoundary(mapped, match.targetProgress, boundary, leftArc, rightArc)) continue;
      refined.push(match);
      minimumProgress = match.targetProgress;
    }
    if (refined.length < 3) break;
    pairs = refined;
    fitted = boundary ? fitAllPairs(pairs) : fitPairs(pairs);
  }
  const squaredError = fitted.active.reduce((sum, pair) =>
    sum + squaredDistance(applyTransform(pair.source, fitted.transform), pair.target), 0);
  return {
    transform: fitted.transform,
    rmse: Math.sqrt(squaredError / fitted.active.length),
    points: samples.length,
  };
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
  normalizedProgress?: number,
  boundary?: TrackBoundary
): void {
  if (!Number.isFinite(sourcePos.x) || !Number.isFinite(sourcePos.z) ||
      (sourcePos.x === 0 && sourcePos.z === 0) || !hasUsableOutline(outline)) return;

  let state = calibrations.get(trackOrdinal);
  if (state && lapNumber < state.lastLap) {
    state = { transform: null, sourcePoints: [], samplesByBin: Array(PROGRESS_BIN_COUNT).fill(null),
      lastLap: lapNumber, collecting: true, history: [], nextSequence: 1 };
    calibrations.set(trackOrdinal, state);
  }
  if (!state) {
    state = { transform: null, sourcePoints: [], samplesByBin: Array(PROGRESS_BIN_COUNT).fill(null),
      lastLap: lapNumber, collecting: true, history: [], nextSequence: 1 };
    calibrations.set(trackOrdinal, state);
  }
  if (state.transform) {
    state.lastLap = Math.max(state.lastLap, lapNumber);
    return;
  }
  const progress = Number.isFinite(normalizedProgress)
    ? Math.max(0, Math.min(1, normalizedProgress!))
    : normalizedArcLengths(outline)[closestPointIdx(outline, sourcePos)];
  if (!Number.isFinite(progress) || progress < 0 || progress > 1) return;
  const bin = Math.min(PROGRESS_BIN_COUNT - 1, Math.floor(progress * PROGRESS_BIN_COUNT));
  const previous = state.samplesByBin[bin];
  if (!previous || lapNumber > previous.lapNumber) {
    state.samplesByBin[bin] = { point: sourcePos, progress, lapNumber };
    state.sourcePoints = state.samplesByBin
      .filter((sample): sample is CalibrationSample => sample !== null)
      .map(sample => sample.point);
  }

  // Trigger calibration at lap boundary without discarding session evidence.
  if (lapNumber > state.lastLap && state.sourcePoints.length > MIN_CALIBRATION_POINTS) {
    calibrate(trackOrdinal, outline, boundary);
  }
  state.lastLap = Math.max(state.lastLap, lapNumber);
}

/**
 * Run Procrustes calibration using collected source points vs outline.
 */
function calibrate(trackOrdinal: number, outline: Point[], boundary?: TrackBoundary): void {
  const state = calibrations.get(trackOrdinal);
  if (!state || state.transform) return;
  const samples = state.samplesByBin.filter((sample): sample is CalibrationSample => sample !== null);
  if (samples.length < MIN_CALIBRATION_POINTS ||
      !hasEnoughSpatialCoverage(samples) ||
      !hasClosedLapCoverage(samples)) return;
  const result = buildAlignmentTransform(samples, outline, boundary);
  state.transform = result.transform;
  recordCalibration(state, samples, result);
  state.collecting = false;
}

export function calibrateFromPositions(
  trackOrdinal: number,
  positions: Point[],
  outline: Point[],
  boundary?: TrackBoundary
): boolean {
  if (!hasUsableOutline(outline)) return false;
  const filtered = collectSpatiallyDistinct(positions.filter(point =>
    Number.isFinite(point.x) && Number.isFinite(point.z) && !(point.x === 0 && point.z === 0)
  ), MIN_POINT_SEPARATION_SQ);
  if (filtered.length < MIN_CALIBRATION_POINTS) return false;
  const samplesByBin: Array<CalibrationSample | null> = Array(PROGRESS_BIN_COUNT).fill(null);
  for (let index = 0; index < filtered.length; index++) {
    const progress = index / filtered.length;
    const bin = Math.min(PROGRESS_BIN_COUNT - 1, Math.floor(progress * PROGRESS_BIN_COUNT));
    if (!samplesByBin[bin]) samplesByBin[bin] = { point: filtered[index]!, progress, lapNumber: 0 };
  }
  const samples = samplesByBin.filter((sample): sample is CalibrationSample => sample !== null);
  if (samples.length < MIN_CALIBRATION_POINTS) return false;
  const result = buildAlignmentTransform(samples, outline, boundary, false);
  const previous = calibrations.get(trackOrdinal);
  const state: CalibrationState = { transform: result.transform, sourcePoints: samples.map(sample => sample.point), samplesByBin,
    lastLap: 0, collecting: false, history: previous?.history ?? [], nextSequence: previous?.nextSequence ?? 1 };
  recordCalibration(state, samples, result);
  calibrations.set(trackOrdinal, state);
  return true;
}
export interface LapFitResult {
  transform: Transform;
  rmse: number;
  points: number;
}

/**
 * Fit an ordered lap to a closed track outline.
 *
 * Unlike live calibration, the lap may begin anywhere on the circuit. The
 * source is sampled by its own driven arc length and the target is searched
 * across cyclic outline offsets before robust Procrustes fitting.
 */
export function fitLapToTrack(
  positions: Point[],
  outline: Point[],
): LapFitResult | null {
  if (!hasUsableOutline(outline)) return null;
  const source = collectSpatiallyDistinct(positions.filter(point =>
    Number.isFinite(point.x) && Number.isFinite(point.z) &&
    !(point.x === 0 && point.z === 0)
  ), MIN_POINT_SEPARATION_SQ);
  if (source.length < MIN_CALIBRATION_POINTS) return null;

  const sampleCount = Math.min(300, source.length, outline.length);
  const sourceArc = normalizedArcLengths(source);
  const targetArc = normalizedArcLengths(outline);
  const sourceSamples = sampleByArc(source, sourceArc, sampleCount);
  let best: LapFitResult | null = null;
  const offsetSteps = STATIC_ALIGNMENT_OFFSET_STEPS * 4;
  for (let offsetIndex = 0; offsetIndex < offsetSteps; offsetIndex++) {
    const offset = offsetIndex / offsetSteps;
    const targetSamples = sampleByArc(outline, targetArc, sampleCount, offset);
    const pairs = sourceSamples.map((point, index) => ({
      source: point,
      target: targetSamples[index]!,
      targetProgress: index / sampleCount + offset,
    }));
    const fitted = fitPairs(pairs);
    const squaredError = fitted.active.reduce((sum, pair) =>
      sum + squaredDistance(applyTransform(pair.source, fitted.transform), pair.target), 0);
    const rmse = Math.sqrt(squaredError / fitted.active.length);
    if (!best || rmse < best.rmse) {
      best = { transform: fitted.transform, rmse, points: fitted.active.length };
    }
  }
  return best;
}


/**
 * Get calibration state for API.
 */
export function getCalibrationStatus(trackOrdinal: number): {
  calibrated: boolean;
  collecting: boolean;
  pointsCollected: number;
  transform: Transform | null;
} {
  const state = calibrations.get(trackOrdinal);
  return {
    calibrated: state?.transform != null,
    collecting: state?.collecting ?? false,
    pointsCollected: state?.sourcePoints.length ?? 0,
    transform: state?.transform ?? null,
  };
}

export function getCalibrationComparison(trackOrdinal: number): {
  calibrated: boolean;
  pointsCollected: number;
  current: Transform | null;
  history: CalibrationHistoryEntry[];
} {
  const status = getCalibrationStatus(trackOrdinal);
  const state = calibrations.get(trackOrdinal);
  return { calibrated: status.calibrated, pointsCollected: status.pointsCollected, current: status.transform,
    history: state?.history.map(entry => ({ ...entry, transform: { ...entry.transform } })) ?? [] };
}

/**
 * Transform an array of points from outline/TUMFTM space to source space.
 * Uses live calibration if available, otherwise falls back to static alignment.
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
 * Clear live calibration evidence for a track without evicting static alignment.
 * Call when starting an independent telemetry session/import.
 */
export function resetLiveCalibration(trackOrdinal: number): void {
  calibrations.delete(trackOrdinal);
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

