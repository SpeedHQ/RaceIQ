import { eq, inArray } from "drizzle-orm";
import type { GameId } from "../../shared/games/ids";
import { CANONICAL_LAP_ANALYSIS_SEMANTIC_IDS } from "../../shared/racing/analysis/laps/semantic-frame";
import type { LapInsight } from "../../shared/racing/analysis/laps/insights/types";
import type { EligibilityDecisionSet, LapQualitySummary } from "../../shared/racing/quality/contracts";
import { isEligibilityUsable, resolveEligibilityDecision } from "../../shared/racing/quality/policies";
import { db } from "../db";
import { lapMetrics, laps } from "../db/schema";
import { getLapMetaById } from "../db/lap-read-queries";
import { queryLapTelemetryBySemanticId } from "../telemetry/replay";
import { semanticSamplesFromReplay } from "../telemetry/semantic-samples";
import { resolveTrack } from "../tracks/info";
import { computeLapMetrics, LAP_METRICS_ALGO_VERSION, type LapMetrics, type SegmentStat } from "./metrics";

interface MetricsRow {
  lapId: number;
  algoVersion: number;
  insights: string;
  segmentStats: string;
  computedAt: string;
  qualityGeneration: string | null;
  currentQualityGeneration: string | null;
  quality: LapQualitySummary | null;
  eligibility: EligibilityDecisionSet | null;
  qualitySchemaVersion: string | null;
  qualityPolicyVersion: string | null;
  qualityConfigVersion: string | null;
}

function rowToMetrics(row: MetricsRow): LapMetrics | null {
  const decision = resolveEligibilityDecision(
    {
      quality: row.quality,
      eligibility: row.eligibility,
      qualityGeneration: row.currentQualityGeneration,
      qualitySchemaVersion: row.qualitySchemaVersion,
      qualityPolicyVersion: row.qualityPolicyVersion,
      qualityConfigVersion: row.qualityConfigVersion,
    },
    "corner-trace",
  );
  if (!isEligibilityUsable(decision)) return null;
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
      eligibility: laps.eligibility,
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

  const lap = await getLapMetaById(lapId);
  if (!lap || !lap.gameId || !isEligibilityUsable(resolveEligibilityDecision(lap, "corner-trace"))) return null;
  const replay = await queryLapTelemetryBySemanticId(lap.id, CANONICAL_LAP_ANALYSIS_SEMANTIC_IDS);
  if (!replay) return null;
  const samples = semanticSamplesFromReplay(replay);
  if (samples.length === 0) return null;
  const segments = resolveTrack(lap.gameId, lap.trackOrdinal).segments;
  const metrics = computeLapMetrics(lapId, samples, lap.gameId as GameId, segments, lap.quality);
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
      eligibility: laps.eligibility,
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

  const metadata = await Promise.all(missing.map((id) => getLapMetaById(id)));
  for (const lap of metadata) {
    if (!lap || !lap.gameId || !isEligibilityUsable(resolveEligibilityDecision(lap, "corner-trace"))) continue;
    const replay = await queryLapTelemetryBySemanticId(lap.id, CANONICAL_LAP_ANALYSIS_SEMANTIC_IDS);
    if (!replay) continue;
    const samples = semanticSamplesFromReplay(replay);
    if (samples.length === 0) continue;
    const segments = resolveTrack(lap.gameId, lap.trackOrdinal).segments;
    const metrics = computeLapMetrics(lap.id, samples, lap.gameId as GameId, segments, lap.quality);
    await persist(metrics, lap.qualityGeneration ?? null);
    output.set(lap.id, metrics);
  }
  return output;
}
