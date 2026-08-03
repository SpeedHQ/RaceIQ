/**
 * Pure per-lap driver metrics. Every export is a deterministic function of
 * telemetry and curated track geometry; persistence lives in metrics-store.ts.
 */

import { analyzeLap } from "../../shared/racing/analysis/laps/insights/analyze";
import type { LapInsight } from "../../shared/racing/analysis/laps/insights/types";
import { tryGetGame } from "../../shared/games/registry";
import type { NamedSegment } from "../../shared/racing/tracks/named-segments";
import type { GameId } from "../../shared/games/ids";
import type { TelemetryPacket } from "../../shared/telemetry/types";

/**
 * Bump when any detector or segment-stat definition changes, so cached rows
 * from the old definition are discarded instead of silently mixing with new
 * ones inside a single experiment.
 */
export const LAP_METRICS_ALGO_VERSION = 1;

const MPH_TO_KMH = 1.609344;

/** Convert one packet's velocity vector from metres per second to miles per hour. */
export function speedMphFromPacket(packet: TelemetryPacket): number {
  return Math.sqrt(packet.VelocityX ** 2 + packet.VelocityY ** 2 + packet.VelocityZ ** 2) * 2.237;
}

/** ~20-feature input descriptor for one slice of a lap. */
export interface InputStats {
  // Aggregates
  throttleAvg: number;
  throttleMax: number;
  fullThrottlePctDist: number;
  brakeAvg: number;
  brakeMax: number;
  brakingPctDist: number;
  brakeApplications: number;
  steerAbsAvg: number;
  steerAbsMax: number;
  steeringSmoothness: number;
  // Event points — distances are meters from the start of the LAP (not segment)
  brakeOnDist: number | null; // first sample where brake crosses >5%
  brakeOffDist: number | null; // last sample where brake was >5%
  peakBrakeValue: number; // 0..1
  peakBrakeDist: number | null; // distance where peak brake occurred
  fullThrottleDist: number | null; // first sample where throttle reaches >=95%
  liftOffThrottleDist: number | null; // first sample (after any full throttle) where throttle drops below 80%
  minSpeed: number; // km/h equivalent from the raw mph trace
  minSpeedDist: number | null;
  maxSpeed: number;
  maxSpeedDist: number | null;
}

/**
 * Input descriptor for one named section of a lap, plus the time it took.
 *
 * `name`/`number`/`covers` are copied from the track's curated geometry so a
 * stored row still identifies its corner the same way the map and the track
 * guide do, without a second lookup at read time.
 */
export interface SegmentStat {
  name: string;
  type: "corner" | "straight";
  number?: number;
  covers?: number[];
  startFrac: number;
  endFrac: number;
  /** Seconds spent in this section. */
  timeSec: number;
  stats: InputStats;
}

/** What `lap_metrics` stores for one lap. */
export interface LapMetrics {
  lapId: number;
  algoVersion: number;
  insights: LapInsight[];
  segmentStats: SegmentStat[];
  computedAt: string;
}

/**
 * How to read a game's raw `Steer` channel: the value meaning "wheel straight"
 * and the value meaning "full lock".
 *
 * Passed in rather than hardcoded because the two are game-specific and the
 * game adapters already declare them (`steeringCenter` / `steeringRange`).
 * `computeStatsRange` previously baked in `(steer - 127) / 127`, which silently
 * assumed FM's convention for every game; `lap-analysis/corners.ts` reads the
 * adapter for the same two numbers. One source of truth, so a correction to an
 * adapter reaches both.
 */
export interface SteerScale {
  center: number;
  range: number;
}

/** The steering convention declared by a game's adapter. */
export function steerScaleFor(gameId: string | undefined): SteerScale {
  const adapter = gameId ? tryGetGame(gameId) : undefined;
  return { center: adapter?.steeringCenter ?? 127, range: adapter?.steeringRange ?? 127 };
}

/**
 * Aggregate + event statistics over `[startIdx, endIdx)` of a set of
 * index-aligned channel arrays.
 *
 * Deliberately index-based rather than distance-based: both callers (the
 * 1-metre resampled compare grid and a raw packet stream) already know their
 * own index bounds, and re-deriving them from distances inside here would make
 * the resampled case do a redundant search.
 */
export function computeStatsRange(
  throttle: number[],
  brake: number[],
  steer: number[],
  speedMph: number[],
  distances: number[],
  startIdx: number,
  endIdx: number,
  steerScale: SteerScale,
): InputStats {
  const lo = Math.max(0, Math.min(startIdx, throttle.length - 1));
  const hi = Math.max(lo + 1, Math.min(endIdx, throttle.length));
  const n = hi - lo;

  let tSum = 0,
    tMax = 0,
    tFull = 0;
  let bSum = 0,
    bMax = 0,
    bOn = 0,
    bEvents = 0,
    prevBrake = false;
  let sAbsSum = 0,
    sAbsMax = 0;
  let smoothSum = 0,
    prev = 0;

  let brakeOnDist: number | null = null;
  let brakeOffDist: number | null = null;
  let peakBrakeValue = 0;
  let peakBrakeDist: number | null = null;
  let fullThrottleDist: number | null = null;
  let liftOffThrottleDist: number | null = null;
  let sawFullThrottle = false;
  let minSpeed = Infinity,
    minSpeedDist: number | null = null;
  let maxSpeed = -Infinity,
    maxSpeedDist: number | null = null;

  for (let i = lo; i < hi; i++) {
    const t = throttle[i];
    tSum += t;
    if (t > tMax) tMax = t;
    if (t >= 0.95) {
      tFull++;
      if (fullThrottleDist == null) fullThrottleDist = distances[i];
      sawFullThrottle = true;
    } else if (sawFullThrottle && t < 0.8 && liftOffThrottleDist == null) {
      liftOffThrottleDist = distances[i];
    }

    const b = brake[i];
    bSum += b;
    if (b > bMax) bMax = b;
    if (b > peakBrakeValue) {
      peakBrakeValue = b;
      peakBrakeDist = distances[i];
    }
    const isBraking = b > 0.05;
    if (isBraking) {
      bOn++;
      if (brakeOnDist == null) brakeOnDist = distances[i];
      brakeOffDist = distances[i];
    }
    if (isBraking && !prevBrake) bEvents++;
    prevBrake = isBraking;

    const norm = (steer[i] - steerScale.center) / (steerScale.range || 1);
    const a = Math.abs(norm);
    sAbsSum += a;
    if (a > sAbsMax) sAbsMax = a;
    if (i > lo) smoothSum += Math.abs(norm - prev);
    prev = norm;

    const speedKmh = speedMph[i] * MPH_TO_KMH;
    if (speedKmh < minSpeed) {
      minSpeed = speedKmh;
      minSpeedDist = distances[i];
    }
    if (speedKmh > maxSpeed) {
      maxSpeed = speedKmh;
      maxSpeedDist = distances[i];
    }
  }

  return {
    throttleAvg: tSum / n,
    throttleMax: tMax,
    fullThrottlePctDist: tFull / n,
    brakeAvg: bSum / n,
    brakeMax: bMax,
    brakingPctDist: bOn / n,
    brakeApplications: bEvents,
    steerAbsAvg: sAbsSum / n,
    steerAbsMax: sAbsMax,
    steeringSmoothness: n > 1 ? smoothSum / (n - 1) : 0,
    brakeOnDist,
    brakeOffDist,
    peakBrakeValue,
    peakBrakeDist,
    fullThrottleDist,
    liftOffThrottleDist,
    minSpeed: isFinite(minSpeed) ? minSpeed : 0,
    minSpeedDist,
    maxSpeed: isFinite(maxSpeed) ? maxSpeed : 0,
    maxSpeedDist,
  };
}

/** Channel arrays pulled straight off a raw packet stream, index-aligned. */
interface LapChannels {
  /** Metres travelled since the first packet of the lap. */
  distances: number[];
  /** Seconds since the first packet of the lap. */
  elapsed: number[];
  throttle: number[];
  brake: number[];
  /** Raw, straight off the packet — interpreted via the game's `SteerScale`. */
  steer: number[];
  speedMph: number[];
}

function extractChannels(packets: TelemetryPacket[]): LapChannels {
  const first = packets[0];
  const d0 = first.DistanceTraveled;
  const t0 = first.TimestampMS;
  const channels: LapChannels = {
    distances: new Array(packets.length),
    elapsed: new Array(packets.length),
    throttle: new Array(packets.length),
    brake: new Array(packets.length),
    steer: new Array(packets.length),
    speedMph: new Array(packets.length),
  };

  for (let index = 0; index < packets.length; index++) {
    const packet = packets[index];
    channels.distances[index] = packet.DistanceTraveled - d0;
    channels.elapsed[index] = (packet.TimestampMS - t0) / 1000;
    channels.throttle[index] = packet.Accel / 255;
    channels.brake[index] = packet.Brake / 255;
    channels.steer[index] = packet.Steer;
    channels.speedMph[index] = speedMphFromPacket(packet);
  }

  return channels;
}

/**
 * Per-segment input stats for a single lap.
 *
 * Segment bounds are fractions of lap distance, resolved against this lap's own
 * total distance rather than the track's nominal length — a lap that cut a
 * corner or ran long still splits proportionally, which is what the compare
 * path already does.
 *
 * Pure: no DB, no track lookup. `getOrComputeLapMetrics` supplies the segments.
 */
function computeLapSegmentStats(
  packets: TelemetryPacket[],
  segments: NamedSegment[],
  steerScale: SteerScale,
): SegmentStat[] {
  if (packets.length < 2 || segments.length === 0) return [];

  const ch = extractChannels(packets);
  const startDist = ch.distances[0];
  const totalDist = ch.distances[ch.distances.length - 1] - startDist || 1;

  const out: SegmentStat[] = [];
  for (const seg of segments) {
    const startD = startDist + seg.startFrac * totalDist;
    const endD = startDist + seg.endFrac * totalDist;

    // distances is monotonic, so a linear scan is exact and cheap.
    let lo = 0;
    while (lo < ch.distances.length && ch.distances[lo] < startD) lo++;
    let hi = lo;
    while (hi < ch.distances.length && ch.distances[hi] < endD) hi++;
    // Fewer than two samples in the window means no measurable time; skipping
    // matches the compare path rather than emitting a zero-width row.
    if (hi - lo < 2) continue;

    out.push({
      name: seg.name,
      type: seg.type,
      ...(seg.number != null ? { number: seg.number } : {}),
      ...(seg.covers?.length ? { covers: seg.covers } : {}),
      startFrac: seg.startFrac,
      endFrac: seg.endFrac,
      timeSec: (ch.elapsed[hi - 1] ?? 0) - (ch.elapsed[lo] ?? 0),
      stats: computeStatsRange(ch.throttle, ch.brake, ch.steer, ch.speedMph, ch.distances, lo, hi, steerScale),
    });
  }
  return out;
}

/** Compute (but do not persist) metrics for an already-decoded lap. */
export function computeLapMetrics(
  lapId: number,
  packets: TelemetryPacket[],
  gameId: GameId,
  segments: NamedSegment[],
): LapMetrics {
  return {
    lapId,
    algoVersion: LAP_METRICS_ALGO_VERSION,
    insights: analyzeLap(packets, gameId),
    segmentStats: computeLapSegmentStats(packets, segments, steerScaleFor(gameId)),
    computedAt: new Date().toISOString(),
  };
}
/**
 * Per-lap tuning metrics derived server-side from a lap's raw telemetry frames
 * (plan §2 "Per-lap metrics"). Fields are optional: a metric is omitted entirely
 * when the underlying channel is unavailable, so the UI shows "—" rather than a
 * fabricated 0.
 */
export interface LapMetric {
  lapId: number;
  /** Litres consumed over the lap. */
  fuelPerLap?: number;
  /**
   * Worst-tyre wear at lap end, as a percentage worn (0 = new, 100 = dead).
   * Derived from the game's per-tyre wear channel (ACC/AC-Evo shared memory and
   * F1 both expose it); omitted when no frame carries a usable reading.
   */
  tyreWear?: number;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Fuel used over a lap, in litres. Prefers the parser-provided per-lap fuel field
 * (ACC & AC-Evo both populate `acc.fuelPerLap`, litres) — the game's own rolling
 * estimate, read from the last frame that reports a positive value (most complete
 * at lap end). Falls back to the Δ of remaining fuel across the lap's frames
 * (first − last; `Fuel` is litres-remaining for ACC/AC-Evo).
 *
 * Returns undefined when neither source is usable — including legacy laps with no
 * stored telemetry — so the caller omits the metric instead of reporting 0.
 */
export function deriveFuelPerLap(packets: TelemetryPacket[]): number | undefined {
  if (packets.length < 2) return undefined;

  // Prefer the game-computed per-lap fuel field, latest positive reading.
  for (let i = packets.length - 1; i >= 0; i--) {
    const f = packets[i].acc?.fuelPerLap;
    if (typeof f === "number" && Number.isFinite(f) && f > 0) return round2(f);
  }

  // Fallback: fuel burned = remaining at lap start − remaining at lap end.
  const first = packets[0].Fuel;
  const last = packets[packets.length - 1].Fuel;
  if (typeof first === "number" && typeof last === "number") {
    const delta = first - last;
    // Guard against noise/refuels: a real GT lap burns a few litres, never
    // negative and never a full tank.
    if (delta > 0 && delta < 100) return round2(delta);
  }

  return undefined;
}

/**
 * Worst-tyre wear at lap end, as a percentage worn (0 = new, 100 = fully worn).
 *
 * `TireWearFL/FR/RL/RR` are a 0..1 fraction worn (higher = more worn) on ACC and
 * AC-Evo, and on F1 (which divides its raw 0..100 channel by 100). F1 also sets
 * them to -1 when the channel is unavailable, so negatives are skipped. Reads the
 * last frame whose four tyres are all finite and ≥ 0 (most worn, and complete at
 * lap end), then reports the single worst tyre × 100.
 *
 * Returns undefined when no frame carries a usable reading — legacy laps with no
 * stored telemetry, or games without a wear channel — so the caller omits the
 * metric instead of reporting 0.
 */
export function deriveTyreWear(packets: TelemetryPacket[]): number | undefined {
  for (let i = packets.length - 1; i >= 0; i--) {
    const packet = packets[i];
    const frontLeft = packet.TireWearFL;
    const frontRight = packet.TireWearFR;
    const rearLeft = packet.TireWearRL;
    const rearRight = packet.TireWearRR;
    if (
      typeof frontLeft !== "number" ||
      !Number.isFinite(frontLeft) ||
      frontLeft < 0 ||
      typeof frontRight !== "number" ||
      !Number.isFinite(frontRight) ||
      frontRight < 0 ||
      typeof rearLeft !== "number" ||
      !Number.isFinite(rearLeft) ||
      rearLeft < 0 ||
      typeof rearRight !== "number" ||
      !Number.isFinite(rearRight) ||
      rearRight < 0
    ) {
      continue;
    }
    return round2(Math.max(frontLeft, frontRight, rearLeft, rearRight) * 100);
  }
  return undefined;
}

