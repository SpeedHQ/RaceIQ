import type { TelemetryPacket } from "../../shared/telemetry/types";
import { hasWorldPositions, lapPath } from "../../shared/racing/tracks/path";
import type { Corner } from "./corners";
import { speedMphFromPacket } from "./metrics";

export interface AlignedTrace {
  speed: number[];
  throttle: number[];
  brake: number[];
  steer: number[];
  rpm: number[];
  gear: number[];
  posX: number[];
  posZ: number[];
  yaw: number[];
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

export interface CornerDelta {
  label: string;
  deltaSeconds: number;
  timeA: number;
  timeB: number;
}

export interface ComparisonOptions {
  lapAIsValid?: boolean;
  lapBIsValid?: boolean;
  trackLengthMeters?: number | null;
  gridStepMeters?: number;
  distanceRange?: { start: number; end: number };
  alignmentIndex?: ComparisonAlignmentIndex;
}

export interface ComparisonAlignmentIndex {
  distancesA: number[];
  distancesB: number[];
  nominalSpan: number;
}

function lowerBound(values: readonly number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (values[middle] < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function upperBound(values: readonly number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (values[middle] <= target) low = middle + 1;
    else high = middle;
  }
  return low;
}

interface LapData {
  distances: number[];
  speeds: number[];
  throttles: number[];
  brakes: number[];
  steers: number[];
  rpms: number[];
  gears: number[];
  posXs: number[];
  posZs: number[];
  yaws: number[];
  times: number[];
  tireWears: number[];
  fuels: number[];
}


function positiveSpan(packets: TelemetryPacket[]): number {
  const first = packets.find((packet) => Number.isFinite(packet.DistanceTraveled));
  const last = [...packets].reverse().find((packet) => Number.isFinite(packet.DistanceTraveled));
  return first && last ? Math.max(0, last.DistanceTraveled - first.DistanceTraveled) : 0;
}

function rawDistances(packets: TelemetryPacket[]): number[] {
  const first = packets.find((packet) => Number.isFinite(packet.DistanceTraveled))?.DistanceTraveled ?? 0;
  let previous = 0;
  return packets.map((packet) => {
    const raw = packet.DistanceTraveled - first;
    const next = Number.isFinite(raw) && raw >= previous ? raw : previous;
    previous = next;
    return next;
  });
}

function fractionDistances(packets: TelemetryPacket[], span: number): number[] | null {
  const values = packets.map((packet) => packet.iracing?.lapDistancePct);
  if (values.filter((value) => Number.isFinite(value)).length < 2) return null;
  let previous = 0;
  let offset = 0;
  const fractions = values.map((value) => {
    if (!Number.isFinite(value)) return previous;
    let next = value! + offset;
    if (next < previous - 0.5) {
      offset += 1;
      next = value! + offset;
    }
    next = Math.max(previous, Math.min(1, next));
    previous = next;
    return next;
  });
  const start = fractions[0] ?? 0;
  const end = fractions.at(-1) ?? start;
  if (!(end > start)) return null;
  return fractions.map((fraction) => ((fraction - start) / (end - start)) * span);
}

function projectPoint(px: number, pz: number, ax: number, az: number, bx: number, bz: number): { t: number; distance: number } {
  const dx = bx - ax;
  const dz = bz - az;
  const lengthSquared = dx * dx + dz * dz;
  const rawT = lengthSquared > 0 ? ((px - ax) * dx + (pz - az) * dz) / lengthSquared : 0;
  const t = Math.max(0, Math.min(1, rawT));
  return { t, distance: Math.hypot(px - (ax + dx * t), pz - (az + dz * t)) };
}

function projectedDistances(packets: TelemetryPacket[], referencePackets: TelemetryPacket[], nominalSpan: number): number[] | null {
  const path = lapPath(referencePackets);
  const points = path.x
    .map((x, index) => ({ x, z: path.z[index] }))
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.z) && (point.x !== 0 || point.z !== 0));
  if (points.length < 20) return null;
  const cumulative = [0];
  for (let index = 1; index < points.length; index++) {
    cumulative.push(cumulative[index - 1] + Math.hypot(points[index].x - points[index - 1].x, points[index].z - points[index - 1].z));
  }
  const total = cumulative.at(-1) ?? 0;
  if (!(total > 0)) return null;

  const raw = rawDistances(packets);
  const projected: number[] = [];
  let previous = 0;
  for (let index = 0; index < packets.length; index++) {
    const packet = packets[index];
    const { PositionX: x, PositionZ: z } = packet;
    if (!Number.isFinite(x) || !Number.isFinite(z) || (x === 0 && z === 0)) {
      projected.push(previous);
      continue;
    }
    const increment = index > 0 ? Math.max(0, raw[index] - raw[index - 1]) : 50;
    const low = index === 0 ? 0 : Math.max(0, previous - 25);
    const high = index === 0 ? Math.min(total, 50) : Math.min(total, previous + Math.min(250, Math.max(50, increment * 3)));
    let bestProgress = previous;
    let bestDistance = Number.POSITIVE_INFINITY;
    const firstSegment = Math.max(0, lowerBound(cumulative, low) - 1);
    const lastSegment = Math.min(points.length - 2, upperBound(cumulative, high) - 1);
    for (let segment = firstSegment; segment <= lastSegment; segment++) {
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
  const start = projected[0] ?? 0;
  const end = projected.at(-1) ?? start;
  if (!(end > start)) return null;
  return projected.map((value) => ((value - start) / (end - start)) * nominalSpan);
}

function chooseReferenceIndex(packetsA: TelemetryPacket[], packetsB: TelemetryPacket[], options: ComparisonOptions): 0 | 1 {
  if (options.lapAIsValid !== options.lapBIsValid) return options.lapAIsValid ? 0 : 1;
  const spanA = positiveSpan(packetsA);
  const spanB = positiveSpan(packetsB);
  if (Number.isFinite(options.trackLengthMeters) && options.trackLengthMeters! > 0) {
    const errorA = Math.abs(spanA - options.trackLengthMeters!);
    const errorB = Math.abs(spanB - options.trackLengthMeters!);
    if (errorA !== errorB) return errorA < errorB ? 0 : 1;
  }
  return spanA <= spanB ? 0 : 1;
}

export function prepareComparisonAlignmentIndex(
  packetsA: TelemetryPacket[],
  packetsB: TelemetryPacket[],
  options: Omit<ComparisonOptions, "alignmentIndex"> = {},
): ComparisonAlignmentIndex {
  const referencePackets = chooseReferenceIndex(packetsA, packetsB, options) === 0 ? packetsA : packetsB;
  const nominalSpan = positiveSpan(referencePackets) || Math.max(positiveSpan(packetsA), positiveSpan(packetsB));
  if (hasWorldPositions(packetsA) && hasWorldPositions(packetsB) && nominalSpan > 0) {
    const distancesA = projectedDistances(packetsA, referencePackets, nominalSpan);
    const distancesB = projectedDistances(packetsB, referencePackets, nominalSpan);
    if (distancesA && distancesB) return { distancesA, distancesB, nominalSpan };
  }
  const fractionsA = fractionDistances(packetsA, nominalSpan);
  const fractionsB = fractionDistances(packetsB, nominalSpan);
  if (fractionsA && fractionsB) return { distancesA: fractionsA, distancesB: fractionsB, nominalSpan };
  return { distancesA: rawDistances(packetsA), distancesB: rawDistances(packetsB), nominalSpan };
}

function extractLapData(packets: TelemetryPacket[], distances: number[]): LapData {
  const first = packets[0];
  return {
    distances,
    speeds: packets.map(speedMphFromPacket),
    throttles: packets.map((packet) => packet.Accel / 255),
    brakes: packets.map((packet) => packet.Brake / 255),
    steers: packets.map((packet) => packet.Steer),
    rpms: packets.map((packet) => packet.CurrentEngineRpm),
    gears: packets.map((packet) => packet.Gear),
    posXs: packets.map((packet) => packet.PositionX),
    posZs: packets.map((packet) => packet.PositionZ),
    yaws: packets.map((packet) => packet.Yaw),
    times: packets.map((packet) => (packet.TimestampMS - first.TimestampMS) / 1000),
    tireWears: packets.map((packet) => (packet.TireWearFL + packet.TireWearFR + packet.TireWearRL + packet.TireWearRR) / 4),
    fuels: packets.map((packet) => packet.Fuel),
  };
}

function interpolateSample(values: number[], lower: number, upper: number, interpolation: number): number {
  if (lower === upper) return values[lower];
  return values[lower] + interpolation * (values[upper] - values[lower]);
}

function alignLap(data: LapData, grid: number[]): AlignedTrace {
  const trace: AlignedTrace = {
    speed: new Array(grid.length), throttle: new Array(grid.length), brake: new Array(grid.length), steer: new Array(grid.length),
    rpm: new Array(grid.length), gear: new Array(grid.length), posX: new Array(grid.length), posZ: new Array(grid.length),
    yaw: new Array(grid.length), elapsedTime: new Array(grid.length), tireWear: new Array(grid.length), fuel: new Array(grid.length),
    sourceIndices: new Array(grid.length),
  };
  const last = Math.max(0, data.distances.length - 1);
  let sourceIndex = Math.max(0, lowerBound(data.distances, grid[0] ?? 0) - 1);
  for (let gridIndex = 0; gridIndex < grid.length; gridIndex++) {
    const distance = grid[gridIndex];
    while (sourceIndex < last && data.distances[sourceIndex + 1] <= distance) sourceIndex++;
    let lower = sourceIndex;
    let upper = Math.min(last, sourceIndex + 1);
    if (distance <= data.distances[0]) lower = upper = 0;
    else if (distance >= data.distances[last]) lower = upper = last;
    const x0 = data.distances[lower];
    const x1 = data.distances[upper];
    const interpolation = x1 === x0 ? 0 : Math.max(0, Math.min(1, (distance - x0) / (x1 - x0)));
    trace.sourceIndices[gridIndex] = interpolation < 0.5 ? lower : upper;
    trace.speed[gridIndex] = interpolateSample(data.speeds, lower, upper, interpolation);
    trace.throttle[gridIndex] = interpolateSample(data.throttles, lower, upper, interpolation);
    trace.brake[gridIndex] = interpolateSample(data.brakes, lower, upper, interpolation);
    trace.steer[gridIndex] = interpolateSample(data.steers, lower, upper, interpolation);
    trace.rpm[gridIndex] = interpolateSample(data.rpms, lower, upper, interpolation);
    trace.yaw[gridIndex] = interpolateSample(data.yaws, lower, upper, interpolation);
    trace.gear[gridIndex] = Math.round(interpolateSample(data.gears, lower, upper, interpolation));
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

function computeCornerDeltas(corners: Corner[], distances: number[], timeDelta: number[], lapATime: number[], lapBTime: number[]): CornerDelta[] {
  return corners.map((corner) => {
    const startIdx = distances.findIndex((distance) => distance >= corner.distanceStart);
    let endIdx = distances.findIndex((distance) => distance >= corner.distanceEnd);
    if (endIdx === -1) endIdx = distances.length - 1;
    if (startIdx === -1 || startIdx >= endIdx) return { label: corner.label, deltaSeconds: 0, timeA: 0, timeB: 0 };
    return {
      label: corner.label,
      deltaSeconds: Math.round((timeDelta[endIdx] - timeDelta[startIdx]) * 1000) / 1000,
      timeA: Math.round((lapATime[endIdx] - lapATime[startIdx]) * 1000) / 1000,
      timeB: Math.round((lapBTime[endIdx] - lapBTime[startIdx]) * 1000) / 1000,
    };
  });
}

export function compareLaps(
  packetsA: TelemetryPacket[],
  packetsB: TelemetryPacket[],
  corners: Corner[] = [],
  options: ComparisonOptions = {},
): ComparisonResult {
  const { distancesA, distancesB, nominalSpan } = options.alignmentIndex ?? prepareComparisonAlignmentIndex(packetsA, packetsB, options);
  const requestedStep = Number.isFinite(options.gridStepMeters) && options.gridStepMeters! > 0 ? options.gridStepMeters! : 1;
  const rangeStart = Math.max(0, Math.min(nominalSpan, options.distanceRange?.start ?? 0));
  const rangeEnd = Math.max(rangeStart, Math.min(nominalSpan, options.distanceRange?.end ?? nominalSpan));
  const maxPoints = 50_000;
  const step = Math.max(requestedStep, (rangeEnd - rangeStart) / Math.max(1, maxPoints - 1));
  const pointCount = Math.min(maxPoints, Math.max(1, Math.ceil((rangeEnd - rangeStart) / step) + 1));
  const distances = Array.from({ length: pointCount }, (_, index) => index === pointCount - 1 ? rangeEnd : rangeStart + index * step);
  const lapA = alignLap(extractLapData(packetsA, distancesA), distances);
  const lapB = alignLap(extractLapData(packetsB, distancesB), distances);
  const timeDelta = computeTimeDelta(lapA.elapsedTime, lapB.elapsedTime);
  return { distances, lapA, lapB, timeDelta, cornerDeltas: computeCornerDeltas(corners, distances, timeDelta, lapA.elapsedTime, lapB.elapsedTime) };
}
