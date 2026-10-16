/**
 * Pure per-lap driver metrics. Every export is a deterministic function of
 * telemetry and curated track geometry; persistence lives in metrics-store.ts.
 */

import { resolveRacingLineReference, STATIC_LAP_ANALYSIS_VERSION } from "./insights";
import { analyzeLap } from "@raceiq/analysis-core/racing/analysis/laps/insights/analyze";
import { processLap, restoreFrameIndices } from "@raceiq/analysis-core/racing/analysis/laps/insights/process";
import type { LapInsight } from "@raceiq/analysis-core/racing/analysis/laps/insights/types";
import { computeStatsRange, type InputStats, type SteerScale } from "@raceiq/analysis-core/racing/analysis/laps/input-stats";
import { tryGetGame } from "@raceiq/shared/games/registry";
import type { NamedSegment } from "@raceiq/shared/racing/tracks/named-segments";
import type { GameId } from "@raceiq/shared/games/ids";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";

/**
 * Bump when any detector or segment-stat definition changes, so cached rows
 * from the old definition are discarded instead of silently mixing with new
 * ones inside a single experiment.
 */
export const LAP_METRICS_ALGO_VERSION = 4;


/** Convert one packet's velocity vector from metres per second to miles per hour. */
export function speedMphFromPacket(packet: TelemetryPacket): number {
  return Math.sqrt(packet.VelocityX ** 2 + packet.VelocityY ** 2 + packet.VelocityZ ** 2) * 2.237;
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
  insightVersion: number;
  algoVersion: number;
  insights: LapInsight[];
  segmentStats: SegmentStat[];
  computedAt: string;
}

/** The steering convention declared by a game's adapter. */
export function steerScaleFor(gameId: string | undefined): SteerScale {
  const adapter = gameId ? tryGetGame(gameId) : undefined;
  return { center: adapter?.steeringCenter ?? 0, range: adapter?.steeringRange ?? 127 };
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
  trackId: string | null | undefined,
  segments: NamedSegment[],
  insights?: LapInsight[],
): LapMetrics {
  if (!insights) {
    const processed = processLap(packets, gameId);
    insights = analyzeLap(processed.packets, gameId, {
      racingLine: resolveRacingLineReference(gameId, trackId),
    });
    restoreFrameIndices(insights, processed.sourceIndices);
  }
  return {
    lapId,
    algoVersion: LAP_METRICS_ALGO_VERSION,
    insightVersion: STATIC_LAP_ANALYSIS_VERSION,
    insights,
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
 * `TireWearFL/FR/RL/RR` are a 0..1 fraction worn (higher = more worn) on
 * AC Evo and F1 (which divides its raw 0..100 channel by 100). ACC and missing
 * F1 damage packets use -1 for unavailable wear, so negatives are skipped. Reads the
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

