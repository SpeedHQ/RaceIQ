import type { CornerDelta } from "../../shared/racing/comparison/types";
import type { SemanticTelemetrySample } from "../../shared/telemetry/replay/contracts";
import type { Corner } from "./corners";

export type { CornerDelta } from "../../shared/racing/comparison/types";

export const COMPARISON_SEMANTIC_IDS = [
  "motion.position-x",
  "motion.position-z",
  "motion.yaw",
  "motion.speed",
  "inputs.accel",
  "inputs.brake",
  "inputs.steer",
  "engine.current-engine-rpm",
  "tires.tire-wear",
  "fuel.fuel",
  "timing.distance-traveled",
  "timing.current-lap",
] as const;

const MPH_PER_METERS_PER_SECOND = 2.237;

type SemanticNumberId =
  | "motion.position-x"
  | "motion.position-z"
  | "motion.speed"
  | "inputs.accel"
  | "inputs.brake"
  | "inputs.steer"
  | "engine.current-engine-rpm"
  | "fuel.fuel"
  | "timing.distance-traveled";

type SemanticWheelNumberId = "tires.tire-wear";

export interface AlignedTrace {
  speed: number[];
  throttle: number[];
  brake: number[];
  steer: number[];
  rpm: number[];
  posX: number[];
  posZ: number[];
  elapsedTime: number[];
  tireWear: number[];
  fuel: number[];
  sourceIndices: number[];
}

export interface ComparisonResult {
  distances: number[];
  lapA: AlignedTrace;
  lapB: AlignedTrace;
  timeDelta: number[];
  cornerDeltas: CornerDelta[];
}

export interface ComparisonOptions {
  lapAIsValid?: boolean;
  lapBIsValid?: boolean;
  trackLengthMeters?: number | null;
}

interface LapData {
  distances: number[];
  speeds: number[];
  throttles: number[];
  brakes: number[];
  steers: number[];
  rpms: number[];
  posXs: number[];
  posZs: number[];
  times: number[];
  tireWears: number[];
  fuels: number[];
}

function semanticNumber(sample: SemanticTelemetrySample, semanticId: SemanticNumberId): number {
  const value = sample.values[semanticId];
  return typeof value === "number" && Number.isFinite(value) ? value : Number.NaN;
}

function semanticWheelAverage(sample: SemanticTelemetrySample, semanticId: SemanticWheelNumberId): number {
  const value = sample.values[semanticId];
  if (!Array.isArray(value) || value.length !== 4) return Number.NaN;
  const fl = value[0];
  const fr = value[1];
  const rl = value[2];
  const rr = value[3];
  return typeof fl === "number" &&
    Number.isFinite(fl) &&
    typeof fr === "number" &&
    Number.isFinite(fr) &&
    typeof rl === "number" &&
    Number.isFinite(rl) &&
    typeof rr === "number" &&
    Number.isFinite(rr)
    ? (fl + fr + rl + rr) / 4
    : Number.NaN;
}

function positiveSpan(samples: readonly SemanticTelemetrySample[]): number {
  let first: number | undefined;
  let last: number | undefined;
  for (const sample of samples) {
    const distance = semanticNumber(sample, "timing.distance-traveled");
    if (!Number.isFinite(distance)) continue;
    first ??= distance;
    last = distance;
  }
  return first === undefined || last === undefined ? 0 : Math.max(0, last - first);
}

function rawDistances(samples: readonly SemanticTelemetrySample[]): number[] {
  const first = samples.find((sample) => Number.isFinite(semanticNumber(sample, "timing.distance-traveled")));
  if (!first) return new Array(samples.length).fill(Number.NaN);

  const start = semanticNumber(first, "timing.distance-traveled");
  let previous = 0;
  return samples.map((sample) => {
    const raw = semanticNumber(sample, "timing.distance-traveled") - start;
    if (!Number.isFinite(raw)) return Number.NaN;
    const next = raw >= previous ? raw : previous;
    previous = next;
    return next;
  });
}

function hasWorldPositions(samples: readonly SemanticTelemetrySample[]): boolean {
  for (const sample of samples) {
    const x = semanticNumber(sample, "motion.position-x");
    const z = semanticNumber(sample, "motion.position-z");
    if (Number.isFinite(x) && Number.isFinite(z) && (x !== 0 || z !== 0)) return true;
  }
  return false;
}

function projectPoint(px: number, pz: number, ax: number, az: number, bx: number, bz: number): { t: number; distance: number } {
  const dx = bx - ax;
  const dz = bz - az;
  const lengthSquared = dx * dx + dz * dz;
  const rawT = lengthSquared > 0 ? ((px - ax) * dx + (pz - az) * dz) / lengthSquared : 0;
  const t = Math.max(0, Math.min(1, rawT));
  return { t, distance: Math.hypot(px - (ax + dx * t), pz - (az + dz * t)) };
}

function projectedDistances(samples: readonly SemanticTelemetrySample[], referenceSamples: readonly SemanticTelemetrySample[], nominalSpan: number): number[] | null {
  const points = referenceSamples
    .map((sample) => ({ x: semanticNumber(sample, "motion.position-x"), z: semanticNumber(sample, "motion.position-z") }))
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.z) && (point.x !== 0 || point.z !== 0));
  if (points.length < 20) return null;

  const cumulative = [0];
  for (let index = 1; index < points.length; index++) {
    cumulative.push(cumulative[index - 1] + Math.hypot(points[index].x - points[index - 1].x, points[index].z - points[index - 1].z));
  }
  const total = cumulative.at(-1) ?? 0;
  if (!(total > 0)) return null;

  const raw = rawDistances(samples);
  const projected: number[] = [];
  let previous = 0;
  for (let index = 0; index < samples.length; index++) {
    const x = semanticNumber(samples[index], "motion.position-x");
    const z = semanticNumber(samples[index], "motion.position-z");
    if (!Number.isFinite(x) || !Number.isFinite(z) || (x === 0 && z === 0)) {
      projected.push(Number.NaN);
      continue;
    }
    const increment = index > 0 && Number.isFinite(raw[index]) && Number.isFinite(raw[index - 1]) ? Math.max(0, raw[index] - raw[index - 1]) : 50;
    const low = index === 0 ? 0 : Math.max(0, previous - 25);
    const high = index === 0 ? Math.min(total, 50) : Math.min(total, previous + Math.min(250, Math.max(50, increment * 3)));
    let bestProgress = previous;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let segment = 0; segment < points.length - 1; segment++) {
      if (cumulative[segment + 1] < low || cumulative[segment] > high) continue;
      const candidate = projectPoint(x, z, points[segment].x, points[segment].z, points[segment + 1].x, points[segment + 1].z);
      const progress = cumulative[segment] + candidate.t * (cumulative[segment + 1] - cumulative[segment]);
      if (progress >= low && progress <= high && candidate.distance < bestDistance) {
        bestDistance = candidate.distance;
        bestProgress = progress;
      }
    }
    previous = Math.max(previous, Math.min(high, bestProgress));
    projected.push(previous);
  }
  const first = projected.find(Number.isFinite);
  let last: number | undefined;
  for (let index = projected.length - 1; index >= 0; index--) {
    if (!Number.isFinite(projected[index])) continue;
    last = projected[index];
    break;
  }
  if (first === undefined || last === undefined || !(last > first)) return null;
  return projected.map((value) => (Number.isFinite(value) ? ((value - first) / (last - first)) * nominalSpan : Number.NaN));
}

function chooseReferenceIndex(samplesA: readonly SemanticTelemetrySample[], samplesB: readonly SemanticTelemetrySample[], options: ComparisonOptions): 0 | 1 {
  if (options.lapAIsValid !== options.lapBIsValid) return options.lapAIsValid ? 0 : 1;
  const spanA = positiveSpan(samplesA);
  const spanB = positiveSpan(samplesB);
  if (Number.isFinite(options.trackLengthMeters) && options.trackLengthMeters! > 0) {
    const errorA = Math.abs(spanA - options.trackLengthMeters!);
    const errorB = Math.abs(spanB - options.trackLengthMeters!);
    if (errorA !== errorB) return errorA < errorB ? 0 : 1;
  }
  return spanA <= spanB ? 0 : 1;
}

function buildAlignmentDistances(samplesA: readonly SemanticTelemetrySample[], samplesB: readonly SemanticTelemetrySample[], options: ComparisonOptions): [number[], number[], number] {
  const referenceSamples = chooseReferenceIndex(samplesA, samplesB, options) === 0 ? samplesA : samplesB;
  const nominalSpan = positiveSpan(referenceSamples) || Math.max(positiveSpan(samplesA), positiveSpan(samplesB));
  if (hasWorldPositions(samplesA) && hasWorldPositions(samplesB) && nominalSpan > 0) {
    const distancesA = projectedDistances(samplesA, referenceSamples, nominalSpan);
    const distancesB = projectedDistances(samplesB, referenceSamples, nominalSpan);
    if (distancesA && distancesB) return [distancesA, distancesB, nominalSpan];
  }
  return [rawDistances(samplesA), rawDistances(samplesB), nominalSpan];
}

function extractLapData(samples: readonly SemanticTelemetrySample[], distances: number[]): LapData {
  const startedAtMs = samples[0]?.observedAtMs;
  return {
    distances,
    speeds: samples.map((sample) => semanticNumber(sample, "motion.speed") * MPH_PER_METERS_PER_SECOND),
    throttles: samples.map((sample) => semanticNumber(sample, "inputs.accel") / 255),
    brakes: samples.map((sample) => semanticNumber(sample, "inputs.brake") / 255),
    steers: samples.map((sample) => semanticNumber(sample, "inputs.steer")),
    rpms: samples.map((sample) => semanticNumber(sample, "engine.current-engine-rpm")),
    posXs: samples.map((sample) => semanticNumber(sample, "motion.position-x")),
    posZs: samples.map((sample) => semanticNumber(sample, "motion.position-z")),
    times: samples.map((sample) => (Number.isFinite(startedAtMs) ? (sample.observedAtMs - startedAtMs!) / 1000 : Number.NaN)),
    tireWears: samples.map((sample) => semanticWheelAverage(sample, "tires.tire-wear")),
    fuels: samples.map((sample) => semanticNumber(sample, "fuel.fuel")),
  };
}

function interpolateSample(values: number[], lower: number, upper: number, interpolation: number): number {
  if (lower === upper) return values[lower];
  return values[lower] + interpolation * (values[upper] - values[lower]);
}

function alignLap(data: LapData, grid: number[]): AlignedTrace {
  const trace: AlignedTrace = {
    speed: new Array(grid.length),
    throttle: new Array(grid.length),
    brake: new Array(grid.length),
    steer: new Array(grid.length),
    rpm: new Array(grid.length),
    posX: new Array(grid.length),
    posZ: new Array(grid.length),
    elapsedTime: new Array(grid.length),
    tireWear: new Array(grid.length),
    fuel: new Array(grid.length),
    sourceIndices: new Array(grid.length),
  };
  const last = Math.max(0, data.distances.length - 1);
  let sourceIndex = 0;
  for (let gridIndex = 0; gridIndex < grid.length; gridIndex++) {
    const distance = grid[gridIndex];
    while (sourceIndex < last && Number.isFinite(data.distances[sourceIndex + 1]) && data.distances[sourceIndex + 1] <= distance) sourceIndex++;
    let lower = sourceIndex;
    let upper = Math.min(last, sourceIndex + 1);
    if (distance <= data.distances[0]) lower = upper = 0;
    else if (Number.isFinite(data.distances[last]) && distance >= data.distances[last]) lower = upper = last;
    const x0 = data.distances[lower];
    const x1 = data.distances[upper];
    const interpolation = x1 === x0 ? 0 : Math.max(0, Math.min(1, (distance - x0) / (x1 - x0)));
    trace.sourceIndices[gridIndex] = interpolation < 0.5 ? lower : upper;
    trace.speed[gridIndex] = interpolateSample(data.speeds, lower, upper, interpolation);
    trace.throttle[gridIndex] = interpolateSample(data.throttles, lower, upper, interpolation);
    trace.brake[gridIndex] = interpolateSample(data.brakes, lower, upper, interpolation);
    trace.steer[gridIndex] = interpolateSample(data.steers, lower, upper, interpolation);
    trace.rpm[gridIndex] = interpolateSample(data.rpms, lower, upper, interpolation);
    trace.posX[gridIndex] = interpolateSample(data.posXs, lower, upper, interpolation);
    trace.posZ[gridIndex] = interpolateSample(data.posZs, lower, upper, interpolation);
    trace.elapsedTime[gridIndex] = interpolateSample(data.times, lower, upper, interpolation);
    trace.tireWear[gridIndex] = interpolateSample(data.tireWears, lower, upper, interpolation);
    trace.fuel[gridIndex] = interpolateSample(data.fuels, lower, upper, interpolation);
  }
  return trace;
}

function computeTimeDelta(lapATime: number[], lapBTime: number[]): number[] {
  return lapATime.map((time, index) => time - lapBTime[index]);
}

function computeCornerDeltas(corners: Corner[], distances: number[], timeDelta: number[], lapA: AlignedTrace, lapB: AlignedTrace): CornerDelta[] {
  return corners.map((corner) => {
    const alignedStartIndex = distances.findIndex((distance) => distance >= corner.distanceStart);
    let alignedEndIndex = distances.findIndex((distance) => distance >= corner.distanceEnd);
    if (alignedEndIndex === -1) alignedEndIndex = distances.length - 1;
    const hasRange = alignedStartIndex >= 0 && alignedStartIndex < alignedEndIndex;
    if (!hasRange) {
      return {
        label: corner.label,
        deltaSeconds: 0,
        timeA: 0,
        timeB: 0,
        distanceStart: corner.distanceStart,
        distanceEnd: corner.distanceEnd,
        alignedStartIndex: null,
        alignedEndIndex: null,
        sourceStartIndexA: null,
        sourceEndIndexA: null,
        sourceStartIndexB: null,
        sourceEndIndexB: null,
      };
    }
    return {
      label: corner.label,
      deltaSeconds: Math.round((timeDelta[alignedEndIndex] - timeDelta[alignedStartIndex]) * 1000) / 1000,
      timeA: Math.round((lapA.elapsedTime[alignedEndIndex] - lapA.elapsedTime[alignedStartIndex]) * 1000) / 1000,
      timeB: Math.round((lapB.elapsedTime[alignedEndIndex] - lapB.elapsedTime[alignedStartIndex]) * 1000) / 1000,
      distanceStart: distances[alignedStartIndex],
      distanceEnd: distances[alignedEndIndex],
      alignedStartIndex,
      alignedEndIndex,
      sourceStartIndexA: lapA.sourceIndices[alignedStartIndex],
      sourceEndIndexA: lapA.sourceIndices[alignedEndIndex],
      sourceStartIndexB: lapB.sourceIndices[alignedStartIndex],
      sourceEndIndexB: lapB.sourceIndices[alignedEndIndex],
    };
  });
}

export function compareLaps(samplesA: readonly SemanticTelemetrySample[], samplesB: readonly SemanticTelemetrySample[], corners: Corner[] = [], options: ComparisonOptions = {}): ComparisonResult {
  const [distancesA, distancesB, nominalSpan] = buildAlignmentDistances(samplesA, samplesB, options);
  const gridLength = Math.max(0, Math.floor(nominalSpan));
  const distances = Array.from({ length: gridLength + 1 }, (_, index) => index);
  const lapA = alignLap(extractLapData(samplesA, distancesA), distances);
  const lapB = alignLap(extractLapData(samplesB, distancesB), distances);
  const timeDelta = computeTimeDelta(lapA.elapsedTime, lapB.elapsedTime);
  return { distances, lapA, lapB, timeDelta, cornerDeltas: computeCornerDeltas(corners, distances, timeDelta, lapA, lapB) };
}
