/**
 * Per-lap driver metrics — the persisted, cross-session view of how a lap was
 * *driven* (issue #120, Phase 0).
 *
 * Two things live here:
 *
 * 1. **The pure data path.** `computeStatsRange` used to sit inside
 *    `server/ai/inputs-compare-prompt.ts`, where it was already pure but only
 *    ever stringified into a prompt. Other consumers need it as *data*, so the
 *    prompt builder is now one consumer of this module rather than its owner.
 *
 *    ⚠️ Everything here is a **raw, concrete observation about one lap** and
 *    must stay that way: a pure function of that lap's telemetry plus its
 *    track's curated geometry. No `testId`, no baseline arm, no "did the change
 *    work" framing, no problem focus. `brakeOnDist` is a number; whether 10m
 *    later was an improvement is not this module's call. Judgement belongs to
 *    the human (the `verdict` column, set by hand) or to the chat agent, which
 *    reads these facts and recommends. Bake an experiment's intent in here and
 *    every cached row silently becomes valid only for the question that was
 *    being asked the day it was written.
 *
 * 2. **Persistence.** Every consistency/corner/insight number in the app is
 *    recomputed from raw frames on read. That is fine for one session and fatal
 *    for cross-session progress tracking: an experiment spanning a week would
 *    re-decode every .bin file on every dashboard render. `lap_metrics` caches
 *    the result keyed on `algo_version`, exactly like `line_spread_cache` — bump
 *    the version and every row is transparently recomputed on next read.
 *
 * Static imports only, per CLAUDE.md.
 */

import { eq, inArray } from "drizzle-orm";
import { db } from "./db";
import { lapMetrics } from "./db/schema";
import { getLapById, getLapsByIds } from "./db/queries";
import { resolveTrack } from "./track-info";
import { analyzeLap, type LapInsight } from "../shared/lib/lap-insights";
import { tryGetGame } from "../shared/games/registry";
import type { NamedSegment } from "../shared/track-named-segments";
import type { GameId, TelemetryPacket } from "../shared/types";

/**
 * Bump when any detector or segment-stat definition changes, so cached rows
 * from the old definition are discarded instead of silently mixing with new
 * ones inside a single experiment.
 */
export const LAP_METRICS_ALGO_VERSION = 1;

const MPH_TO_KMH = 1.609344;

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
 * assumed FM's convention for every game; `corner-detection.ts` reads the
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
  const empty: InputStats = {
    throttleAvg: 0,
    throttleMax: 0,
    fullThrottlePctDist: 0,
    brakeAvg: 0,
    brakeMax: 0,
    brakingPctDist: 0,
    brakeApplications: 0,
    steerAbsAvg: 0,
    steerAbsMax: 0,
    steeringSmoothness: 0,
    brakeOnDist: null,
    brakeOffDist: null,
    peakBrakeValue: 0,
    peakBrakeDist: null,
    fullThrottleDist: null,
    liftOffThrottleDist: null,
    minSpeed: 0,
    minSpeedDist: null,
    maxSpeed: 0,
    maxSpeedDist: null,
  };
  if (n === 0) return empty;

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
  return {
    distances: packets.map((p) => p.DistanceTraveled - d0),
    elapsed: packets.map((p) => (p.TimestampMS - t0) / 1000),
    throttle: packets.map((p) => p.Accel / 255),
    brake: packets.map((p) => p.Brake / 255),
    steer: packets.map((p) => p.Steer),
    speedMph: packets.map((p) => Math.sqrt(p.VelocityX ** 2 + p.VelocityY ** 2 + p.VelocityZ ** 2) * 2.237),
  };
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
export function computeLapSegmentStats(
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

// ── Persistence ──────────────────────────────────────────────────────────────

interface MetricsRow {
  lapId: number;
  algoVersion: number;
  insights: string;
  segmentStats: string;
  computedAt: string;
}

function rowToMetrics(row: MetricsRow): LapMetrics | null {
  // A row written by an older algo version is not an error, just a miss: the
  // caller recomputes and overwrites it.
  if (row.algoVersion !== LAP_METRICS_ALGO_VERSION) return null;
  try {
    return {
      lapId: row.lapId,
      algoVersion: row.algoVersion,
      insights: JSON.parse(row.insights) as LapInsight[],
      segmentStats: JSON.parse(row.segmentStats) as SegmentStat[],
      computedAt: row.computedAt,
    };
  } catch {
    // Corrupt JSON behaves like a cache miss rather than taking down the read.
    return null;
  }
}

async function persist(m: LapMetrics): Promise<void> {
  await db
    .insert(lapMetrics)
    .values({
      lapId: m.lapId,
      algoVersion: m.algoVersion,
      insights: JSON.stringify(m.insights),
      segmentStats: JSON.stringify(m.segmentStats),
      computedAt: m.computedAt,
    })
    .onConflictDoUpdate({
      target: lapMetrics.lapId,
      set: {
        algoVersion: m.algoVersion,
        insights: JSON.stringify(m.insights),
        segmentStats: JSON.stringify(m.segmentStats),
        computedAt: m.computedAt,
      },
    });
}

/**
 * Read a lap's persisted metrics, computing and storing them on a miss.
 *
 * Returns null only when the lap does not exist or has no decodable telemetry
 * (pre-raw-capture rows, or a .bin that failed to parse) — in which case
 * nothing is written, so a later fix to the parser is picked up automatically.
 */
export async function getOrComputeLapMetrics(lapId: number): Promise<LapMetrics | null> {
  const existing = await db.select().from(lapMetrics).where(eq(lapMetrics.lapId, lapId)).get();
  if (existing) {
    const hit = rowToMetrics(existing);
    if (hit) return hit;
  }

  const lap = await getLapById(lapId);
  if (!lap || lap.telemetry.length === 0 || !lap.gameId) return null;

  const segments = resolveTrack(lap.gameId, lap.trackOrdinal).segments;
  const metrics = computeLapMetrics(lapId, lap.telemetry, lap.gameId as GameId, segments);
  await persist(metrics);
  return metrics;
}

/**
 * Batch form of `getOrComputeLapMetrics`.
 *
 * Worth having separately because every experiment read wants a whole arm at
 * once: this issues one cache query and hands cache-misses to `getLapsByIds`,
 * which decodes each session's .bin once for all of its laps instead of once
 * per lap.
 */
export async function getOrComputeLapMetricsBatch(lapIds: number[]): Promise<Map<number, LapMetrics>> {
  const out = new Map<number, LapMetrics>();
  if (lapIds.length === 0) return out;

  const ids = [...new Set(lapIds)];
  const rows = await db.select().from(lapMetrics).where(inArray(lapMetrics.lapId, ids)).all();
  for (const row of rows) {
    const hit = rowToMetrics(row);
    if (hit) out.set(hit.lapId, hit);
  }

  const missing = ids.filter((id) => !out.has(id));
  if (missing.length === 0) return out;

  const laps = await getLapsByIds(missing);
  for (const lap of laps) {
    if (lap.telemetry.length === 0 || !lap.gameId) continue;
    const segments = resolveTrack(lap.gameId, lap.trackOrdinal).segments;
    const metrics = computeLapMetrics(lap.id, lap.telemetry, lap.gameId as GameId, segments);
    await persist(metrics);
    out.set(lap.id, metrics);
  }
  return out;
}
