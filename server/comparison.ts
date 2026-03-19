import type { TelemetryPacket } from "../shared/types";
import type { Corner } from "./corner-detection";

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
 * Convert a TelemetryPacket to per-lap distance (meters from lap start).
 */
function lapDistance(packet: TelemetryPacket, distanceAtLapStart: number): number {
  return packet.DistanceTraveled - distanceAtLapStart;
}

/**
 * Speed in mph from velocity vector.
 */
function speedMph(p: TelemetryPacket): number {
  return Math.sqrt(p.VelocityX ** 2 + p.VelocityY ** 2 + p.VelocityZ ** 2) * 2.237;
}

/**
 * Compute elapsed time in seconds from first packet of the lap.
 */
function elapsedSeconds(packet: TelemetryPacket, firstPacket: TelemetryPacket): number {
  return (packet.TimestampMS - firstPacket.TimestampMS) / 1000;
}

/**
 * Linear interpolation: find the value at targetX given two known points.
 */
function lerp(x0: number, y0: number, x1: number, y1: number, targetX: number): number {
  if (x1 === x0) return y0;
  const t = (targetX - x0) / (x1 - x0);
  return y0 + t * (y1 - y0);
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
}

function extractLapData(packets: TelemetryPacket[]): LapData {
  const first = packets[0];
  const distanceAtLapStart = first.DistanceTraveled;

  return {
    distances: packets.map((p) => lapDistance(p, distanceAtLapStart)),
    speeds: packets.map(speedMph),
    throttles: packets.map((p) => p.Accel / 255),
    brakes: packets.map((p) => p.Brake / 255),
    steers: packets.map((p) => p.Steer),
    rpms: packets.map((p) => p.CurrentEngineRpm),
    gears: packets.map((p) => p.Gear),
    posXs: packets.map((p) => p.VelocityX), // Using position proxy; actual X from integration
    posZs: packets.map((p) => p.VelocityZ),
    times: packets.map((p) => elapsedSeconds(p, first)),
    tireWears: packets.map((p) => (p.TireWearFL + p.TireWearFR + p.TireWearRL + p.TireWearRR) / 4),
  };
}

/**
 * Interpolate a single channel onto a 1-meter distance grid.
 * sourceDist must be monotonically non-decreasing.
 */
function interpolateChannel(
  sourceDist: number[],
  sourceValues: number[],
  gridDist: number[]
): number[] {
  const result: number[] = new Array(gridDist.length);
  let j = 0; // pointer into source arrays

  for (let i = 0; i < gridDist.length; i++) {
    const d = gridDist[i];

    // Advance j so sourceDist[j] <= d < sourceDist[j+1]
    while (j < sourceDist.length - 2 && sourceDist[j + 1] < d) {
      j++;
    }

    // Clamp at boundaries
    if (d <= sourceDist[0]) {
      result[i] = sourceValues[0];
    } else if (d >= sourceDist[sourceDist.length - 1]) {
      result[i] = sourceValues[sourceValues.length - 1];
    } else {
      result[i] = lerp(
        sourceDist[j],
        sourceValues[j],
        sourceDist[j + 1],
        sourceValues[j + 1],
        d
      );
    }
  }

  return result;
}

/**
 * Align a lap's data to a 1-meter distance grid.
 */
function alignLap(data: LapData, grid: number[]): AlignedTrace {
  return {
    speed: interpolateChannel(data.distances, data.speeds, grid),
    throttle: interpolateChannel(data.distances, data.throttles, grid),
    brake: interpolateChannel(data.distances, data.brakes, grid),
    steer: interpolateChannel(data.distances, data.steers, grid),
    rpm: interpolateChannel(data.distances, data.rpms, grid),
    gear: interpolateChannel(data.distances, data.gears, grid).map(Math.round),
    posX: interpolateChannel(data.distances, data.posXs, grid),
    posZ: interpolateChannel(data.distances, data.posZs, grid),
    elapsedTime: interpolateChannel(data.distances, data.times, grid),
    tireWear: interpolateChannel(data.distances, data.tireWears, grid),
  };
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
