import type { TelemetryPacket } from "../../shared/types";
import type { Corner } from "./corners";
import { speedMphFromPacket } from "./metrics";

/** A single aligned data point at a given distance. */
export interface AlignedTrace {
  speed: number[]; // mph
  throttle: number[]; // 0-1
  brake: number[]; // 0-1
  steer: number[]; // raw u8 (127=center)
  rpm: number[];
  gear: number[];
  posX: number[];
  posZ: number[];
  elapsedTime: number[]; // seconds from lap start
  tireWear: number[]; // average of all 4 tires (0-1)
  fuel: number[]; // raw fuel value (game-dependent units; treated as a fraction for FM)
}

export interface ComparisonResult {
  distances: number[]; // 1-meter grid
  lapA: AlignedTrace;
  lapB: AlignedTrace;
  timeDelta: number[]; // cumulative time delta (positive = lapA slower, lapB gaining)
  cornerDeltas: CornerDelta[];
}

export interface CornerDelta {
  label: string;
  deltaSeconds: number; // positive = lapA slower in this corner
  timeA: number; // section time for lap A in seconds
  timeB: number; // section time for lap B in seconds
}


/**
 * Build per-packet arrays of values we want to interpolate.
 */
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
  times: number[];
  tireWears: number[];
  fuels: number[];
}

function extractLapData(packets: TelemetryPacket[]): LapData {
  const first = packets[0];
  const distanceAtLapStart = first.DistanceTraveled;
  const data: LapData = {
    distances: new Array(packets.length),
    speeds: new Array(packets.length),
    throttles: new Array(packets.length),
    brakes: new Array(packets.length),
    steers: new Array(packets.length),
    rpms: new Array(packets.length),
    gears: new Array(packets.length),
    posXs: new Array(packets.length),
    posZs: new Array(packets.length),
    times: new Array(packets.length),
    tireWears: new Array(packets.length),
    fuels: new Array(packets.length),
  };

  for (let index = 0; index < packets.length; index++) {
    const packet = packets[index];
    data.distances[index] = packet.DistanceTraveled - distanceAtLapStart;
    data.speeds[index] = speedMphFromPacket(packet);
    data.throttles[index] = packet.Accel / 255;
    data.brakes[index] = packet.Brake / 255;
    data.steers[index] = packet.Steer;
    data.rpms[index] = packet.CurrentEngineRpm;
    data.gears[index] = packet.Gear;
    data.posXs[index] = packet.VelocityX;
    data.posZs[index] = packet.VelocityZ;
    data.times[index] = (packet.TimestampMS - first.TimestampMS) / 1000;
    data.tireWears[index] =
      (packet.TireWearFL + packet.TireWearFR + packet.TireWearRL + packet.TireWearRR) / 4;
    data.fuels[index] = packet.Fuel;
  }

  return data;
}

function interpolateSample(
  values: number[],
  lower: number,
  upper: number,
  interpolation: number,
): number {
  if (lower === upper) return values[lower];
  return values[lower] + interpolation * (values[upper] - values[lower]);
}

/**
 * Align all channels to the 1-metre distance grid in one pass.
 * Source distances must be monotonically non-decreasing.
 */
function alignLap(data: LapData, grid: number[]): AlignedTrace {
  const trace: AlignedTrace = {
    speed: new Array(grid.length),
    throttle: new Array(grid.length),
    brake: new Array(grid.length),
    steer: new Array(grid.length),
    rpm: new Array(grid.length),
    gear: new Array(grid.length),
    posX: new Array(grid.length),
    posZ: new Array(grid.length),
    elapsedTime: new Array(grid.length),
    tireWear: new Array(grid.length),
    fuel: new Array(grid.length),
  };
  const lastSourceIndex = data.distances.length - 1;
  let sourceIndex = 0;

  for (let gridIndex = 0; gridIndex < grid.length; gridIndex++) {
    const distance = grid[gridIndex];
    while (
      sourceIndex < lastSourceIndex - 1 &&
      data.distances[sourceIndex + 1] < distance
    ) {
      sourceIndex++;
    }

    let lower = sourceIndex;
    let upper = sourceIndex + 1;
    if (distance <= data.distances[0]) {
      lower = upper = 0;
    } else if (distance >= data.distances[lastSourceIndex]) {
      lower = upper = lastSourceIndex;
    }

    const x0 = data.distances[lower];
    const x1 = data.distances[upper];
    if (x1 === x0) upper = lower;
    const interpolation = x1 === x0 ? 0 : (distance - x0) / (x1 - x0);
    trace.speed[gridIndex] = interpolateSample(data.speeds, lower, upper, interpolation);
    trace.throttle[gridIndex] = interpolateSample(data.throttles, lower, upper, interpolation);
    trace.brake[gridIndex] = interpolateSample(data.brakes, lower, upper, interpolation);
    trace.steer[gridIndex] = interpolateSample(data.steers, lower, upper, interpolation);
    trace.rpm[gridIndex] = interpolateSample(data.rpms, lower, upper, interpolation);
    trace.gear[gridIndex] = Math.round(
      interpolateSample(data.gears, lower, upper, interpolation),
    );
    trace.posX[gridIndex] = interpolateSample(data.posXs, lower, upper, interpolation);
    trace.posZ[gridIndex] = interpolateSample(data.posZs, lower, upper, interpolation);
    trace.elapsedTime[gridIndex] = interpolateSample(data.times, lower, upper, interpolation);
    trace.tireWear[gridIndex] = interpolateSample(data.tireWears, lower, upper, interpolation);
    trace.fuel[gridIndex] = interpolateSample(data.fuels, lower, upper, interpolation);
  }

  return trace;
}

/**
 * Compute cumulative time delta at each distance point.
 * Positive = lapA is slower (lapB is ahead / gaining time).
 */
function computeTimeDelta(
  lapATime: number[],
  lapBTime: number[]
): number[] {
  return lapATime.map((tA, i) => tA - lapBTime[i]);
}

/**
 * Compute per-corner time deltas.
 * For each corner, the delta is the change in cumulative time delta
 * from corner start to corner end.
 */
function computeCornerDeltas(
  corners: Corner[],
  distances: number[],
  timeDelta: number[],
  lapATime: number[],
  lapBTime: number[],
): CornerDelta[] {
  return corners.map((corner) => {
    // Find grid indices closest to corner start/end
    const startIdx = distances.findIndex((d) => d >= corner.distanceStart);
    let endIdx = distances.findIndex((d) => d >= corner.distanceEnd);
    if (endIdx === -1) endIdx = distances.length - 1;
    if (startIdx === -1 || startIdx >= endIdx) {
      return { label: corner.label, deltaSeconds: 0, timeA: 0, timeB: 0 };
    }

    const deltaSeconds = timeDelta[endIdx] - timeDelta[startIdx];
    const timeA = lapATime[endIdx] - lapATime[startIdx];
    const timeB = lapBTime[endIdx] - lapBTime[startIdx];
    return {
      label: corner.label,
      deltaSeconds: Math.round(deltaSeconds * 1000) / 1000,
      timeA: Math.round(timeA * 1000) / 1000,
      timeB: Math.round(timeB * 1000) / 1000,
    };
  });
}

/**
 * Compare two laps by aligning their telemetry to a common 1-meter distance grid.
 *
 * @param packetsA - Telemetry packets for lap A
 * @param packetsB - Telemetry packets for lap B
 * @param corners - Optional corner definitions for per-corner breakdown
 * @returns Comparison result with aligned traces, time deltas, and corner deltas
 */
export function compareLaps(
  packetsA: TelemetryPacket[],
  packetsB: TelemetryPacket[],
  corners: Corner[] = []
): ComparisonResult {
  const dataA = extractLapData(packetsA);
  const dataB = extractLapData(packetsB);

  // Determine common distance range (intersection of both laps)
  const maxDistA = dataA.distances[dataA.distances.length - 1];
  const maxDistB = dataB.distances[dataB.distances.length - 1];
  const maxDist = Math.min(maxDistA, maxDistB);

  // Build 1-meter grid
  const gridLength = Math.floor(maxDist);
  const distances: number[] = [];
  for (let d = 0; d <= gridLength; d++) {
    distances.push(d);
  }

  // Align both laps to the grid
  const lapA = alignLap(dataA, distances);
  const lapB = alignLap(dataB, distances);

  // Compute cumulative time delta
  const timeDelta = computeTimeDelta(lapA.elapsedTime, lapB.elapsedTime);

  // Compute per-corner deltas if corners provided
  const cornerDeltas = computeCornerDeltas(corners, distances, timeDelta, lapA.elapsedTime, lapB.elapsedTime);

  return {
    distances,
    lapA,
    lapB,
    timeDelta,
    cornerDeltas,
  };
}
