import { eq, inArray } from "drizzle-orm";
import type { TelemetryPacket } from "../../shared/telemetry/types";
import type { GameId } from "../../shared/games/ids";
import type { LapInsight } from "../../shared/racing/analysis/laps/insights/types";
import type { LapQualitySummary } from "../../shared/racing/quality/contracts";
import { isQualitySnapshotCurrent } from "../../shared/racing/quality/policies";
import { db } from "../db";
import { lapMetrics, laps } from "../db/schema";
import { getLapById, getLapsByIds } from "../db/lap-read-queries";
import { resolveTrack } from "../tracks/info";
import { computeLapMetrics, deriveFuelPerLap, deriveTyreWear, LAP_METRICS_ALGO_VERSION, type LapMetrics, type SegmentStat } from "./metrics";

/** Minimal DB surface persistLapMetrics needs (DbAdapter satisfies it). */
interface LapMetricsWriter {
  setLapMetrics(lapId: number, fuelPerLap: number | null, tyreWear: number | null): Promise<void>;
}

/** Derive fuel + tyre metrics from in-memory frames and persist them on the lap row. */
export async function persistLapMetrics(writer: LapMetricsWriter, lapId: number, packets: TelemetryPacket[]): Promise<void> {
  const fuelPerLap = deriveFuelPerLap(packets) ?? null;
  const tyreWear = deriveTyreWear(packets) ?? null;
  if (fuelPerLap == null && tyreWear == null) return;
  await writer.setLapMetrics(lapId, fuelPerLap, tyreWear);
}

interface MetricsRow {
  lapId: number;
  algoVersion: number;
  insights: string;
  segmentStats: string;
  computedAt: string;
  qualityGeneration: string | null;
  currentQualityGeneration: string | null;
  quality: LapQualitySummary | null;
  qualitySchemaVersion: string | null;
  qualityPolicyVersion: string | null;
  qualityConfigVersion: string | null;
}

function rowToMetrics(row: MetricsRow): LapMetrics | null {
  if (
    !isQualitySnapshotCurrent({
      quality: row.quality,
      qualityGeneration: row.currentQualityGeneration,
      qualitySchemaVersion: row.qualitySchemaVersion,
      qualityPolicyVersion: row.qualityPolicyVersion,
      qualityConfigVersion: row.qualityConfigVersion,
    })
  ) {
    return null;
  }
  if (row.algoVersion !== LAP_METRICS_ALGO_VERSION || row.qualityGeneration !== row.currentQualityGeneration) return null;
  try {
    return {
      lapId: row.lapId,
      algoVersion: row.algoVersion,
      insights: JSON.parse(row.insights) as LapInsight[],
      segmentStats: JSON.parse(row.segmentStats) as SegmentStat[],
      computedAt: row.computedAt,
    };
  } catch {
    return null;
  }
}

async function persist(metrics: LapMetrics, qualityGeneration: string | null): Promise<void> {
  const insights = JSON.stringify(metrics.insights);
  const segmentStats = JSON.stringify(metrics.segmentStats);
  await db
    .insert(lapMetrics)
    .values({
      lapId: metrics.lapId,
      algoVersion: metrics.algoVersion,
      insights,
      segmentStats,
      qualityGeneration,
      computedAt: metrics.computedAt,
    })
    .onConflictDoUpdate({
      target: lapMetrics.lapId,
      set: {
        algoVersion: metrics.algoVersion,
        insights,
        segmentStats,
        qualityGeneration,
        computedAt: metrics.computedAt,
      },
    });
}

export async function getOrComputeLapMetrics(lapId: number): Promise<LapMetrics | null> {
  const existing = await db
    .select({
      lapId: lapMetrics.lapId,
      algoVersion: lapMetrics.algoVersion,
      insights: lapMetrics.insights,
      segmentStats: lapMetrics.segmentStats,
      computedAt: lapMetrics.computedAt,
      qualityGeneration: lapMetrics.qualityGeneration,
      currentQualityGeneration: laps.qualityGeneration,
      quality: laps.quality,
      qualitySchemaVersion: laps.qualitySchemaVersion,
      qualityPolicyVersion: laps.qualityPolicyVersion,
      qualityConfigVersion: laps.qualityConfigVersion,
    })
    .from(lapMetrics)
    .innerJoin(laps, eq(lapMetrics.lapId, laps.id))
    .where(eq(lapMetrics.lapId, lapId))
    .get();
  if (existing) {
    const hit = rowToMetrics(existing);
    if (hit) return hit;
  }

  const lap = await getLapById(lapId);
  if (!lap || !isQualitySnapshotCurrent(lap) || lap.telemetry.length === 0 || !lap.gameId) return null;

  const segments = resolveTrack(lap.gameId, lap.trackOrdinal).segments;
  const metrics = computeLapMetrics(lapId, lap.telemetry, lap.gameId as GameId, segments, lap.quality);
  await persist(metrics, lap.qualityGeneration ?? null);
  return metrics;
}

export async function getOrComputeLapMetricsBatch(lapIds: number[]): Promise<Map<number, LapMetrics>> {
  const output = new Map<number, LapMetrics>();
  if (lapIds.length === 0) return output;

  const ids = [...new Set(lapIds)];
  const rows = await db
    .select({
      lapId: lapMetrics.lapId,
      algoVersion: lapMetrics.algoVersion,
      insights: lapMetrics.insights,
      segmentStats: lapMetrics.segmentStats,
      computedAt: lapMetrics.computedAt,
      qualityGeneration: lapMetrics.qualityGeneration,
      currentQualityGeneration: laps.qualityGeneration,
      quality: laps.quality,
      qualitySchemaVersion: laps.qualitySchemaVersion,
      qualityPolicyVersion: laps.qualityPolicyVersion,
      qualityConfigVersion: laps.qualityConfigVersion,
    })
    .from(lapMetrics)
    .innerJoin(laps, eq(lapMetrics.lapId, laps.id))
    .where(inArray(lapMetrics.lapId, ids))
    .all();
  for (const row of rows) {
    const hit = rowToMetrics(row);
    if (hit) output.set(hit.lapId, hit);
  }

  const missing = ids.filter((id) => !output.has(id));
  if (missing.length === 0) return output;

  const loadedLaps = await getLapsByIds(missing);
  for (const lap of loadedLaps) {
    if (!isQualitySnapshotCurrent(lap) || lap.telemetry.length === 0 || !lap.gameId) continue;
    const segments = resolveTrack(lap.gameId, lap.trackOrdinal).segments;
    const metrics = computeLapMetrics(lap.id, lap.telemetry, lap.gameId as GameId, segments, lap.quality);
    await persist(metrics, lap.qualityGeneration ?? null);
    output.set(lap.id, metrics);
  }
  return output;
}
