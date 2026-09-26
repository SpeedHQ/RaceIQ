import { and, asc, eq, gt, inArray, isNull, ne, or } from "drizzle-orm";
import type { TelemetryPacket } from "../../shared/telemetry/types";
import type { GameId } from "../../shared/games/ids";
import type { LapInsight } from "../../shared/racing/analysis/laps/insights/types";
import { db } from "../db";
import { lapMetrics, laps } from "../db/schema";
import { getLapById, getLapsByIds } from "../db/lap-read-queries";
import { resolveLapSegments, resolveRacingLineReference, STATIC_LAP_ANALYSIS_VERSION } from "./insights";
import { analyzeLap } from "../../shared/racing/analysis/laps/insights/analyze";
import { processLap, restoreF1FrameIndices } from "../../shared/racing/analysis/laps/insights/process";
import {
  computeLapMetrics,
  deriveFuelPerLap,
  deriveTyreWear,
  LAP_METRICS_ALGO_VERSION,
  type LapMetrics,
  type SegmentStat,
} from "./metrics";

/** Minimal DB surface persistLapMetrics needs (DbAdapter satisfies it). */
interface LapMetricsWriter {
  setLapMetrics(lapId: number, fuelPerLap: number | null, tyreWear: number | null): Promise<void>;
}

/** Derive fuel + tyre metrics from in-memory frames and persist them on the lap row. */
export async function persistLapMetrics(
  writer: LapMetricsWriter,
  lapId: number,
  packets: TelemetryPacket[],
): Promise<void> {
  const fuelPerLap = deriveFuelPerLap(packets) ?? null;
  const tyreWear = deriveTyreWear(packets) ?? null;
  if (fuelPerLap == null && tyreWear == null) return;
  await writer.setLapMetrics(lapId, fuelPerLap, tyreWear);
}

interface MetricsRow {
  lapId: number;
  algoVersion: number;
  insightVersion: number;
  insights: string;
  segmentStats: string;
  computedAt: string;
}

function rowInsights(row: MetricsRow): LapInsight[] | null {
  if (row.insightVersion !== STATIC_LAP_ANALYSIS_VERSION) return null;
  try {
    const parsed = JSON.parse(row.insights) as unknown;
    return Array.isArray(parsed) ? parsed as LapInsight[] : null;
  } catch {
    return null;
  }
}

function rowToMetrics(row: MetricsRow): LapMetrics | null {
  if (row.algoVersion !== LAP_METRICS_ALGO_VERSION) return null;
  const insights = rowInsights(row);
  if (!insights) return null;
  try {
    const segmentStats = JSON.parse(row.segmentStats) as unknown;
    if (!Array.isArray(segmentStats)) return null;
    return {
      lapId: row.lapId,
      algoVersion: row.algoVersion,
      insightVersion: row.insightVersion,
      insights,
      segmentStats: segmentStats as SegmentStat[],
      computedAt: row.computedAt,
    };
  } catch {
    return null;
  }
}

async function persist(metrics: LapMetrics): Promise<void> {
  const insights = JSON.stringify(metrics.insights);
  const segmentStats = JSON.stringify(metrics.segmentStats);
  await db
    .insert(lapMetrics)
    .values({
      lapId: metrics.lapId,
      algoVersion: metrics.algoVersion,
      insightVersion: metrics.insightVersion,
      insights,
      segmentStats,
      computedAt: metrics.computedAt,
    })
    .onConflictDoUpdate({
      target: lapMetrics.lapId,
      set: {
        algoVersion: metrics.algoVersion,
        insightVersion: metrics.insightVersion,
        insights,
        segmentStats,
        computedAt: metrics.computedAt,
      },
    });
}

async function persistInsights(lapId: number, insights: LapInsight[]): Promise<void> {
  await db.update(lapMetrics).set({
    insightVersion: STATIC_LAP_ANALYSIS_VERSION,
    insights: JSON.stringify(insights),
    computedAt: new Date().toISOString(),
  }).where(eq(lapMetrics.lapId, lapId));
}

function computeForLap(lap: NonNullable<Awaited<ReturnType<typeof getLapById>>>, cachedInsights?: LapInsight[]): LapMetrics {
  const segments = resolveLapSegments(lap.gameId as GameId, lap.trackId);
  return computeLapMetrics(
    lap.id,
    lap.telemetry,
    lap.gameId as GameId,
    lap.trackId,
    segments,
    cachedInsights,
  );
}

/** Serialize reads and writes for each lap; an explicit rerun must not lose to an older computation. */
const lapWork = new Map<number, Promise<void>>();

function withLapWork<T>(lapId: number, work: () => Promise<T>): Promise<T> {
  const previous = lapWork.get(lapId);
  const result = previous ? previous.then(work, work) : work();
  const settled = result.then(() => {}, () => {});
  lapWork.set(lapId, settled);
  void settled.then(() => {
    if (lapWork.get(lapId) === settled) lapWork.delete(lapId);
  });
  return result;
}

async function computeMissingMetrics(lapId: number, existing?: MetricsRow): Promise<LapMetrics | null> {
  const lap = await getLapById(lapId);
  if (!lap || lap.telemetry.length === 0 || !lap.gameId) return null;
  const metrics = computeForLap(lap, existing ? rowInsights(existing) ?? undefined : undefined);
  await persist(metrics);
  return metrics;
}

export function getOrComputeLapMetrics(lapId: number): Promise<LapMetrics | null> {
  return withLapWork(lapId, async () => {
    const existing = await db.select().from(lapMetrics).where(eq(lapMetrics.lapId, lapId)).get();
    const hit = existing ? rowToMetrics(existing) : null;
    return hit ?? computeMissingMetrics(lapId, existing);
  });
}

export function getOrComputeLapInsights(lapId: number): Promise<LapInsight[] | null> {
  return withLapWork(lapId, async () => {
    const existing = await db.select().from(lapMetrics).where(eq(lapMetrics.lapId, lapId)).get();
    const hit = existing ? rowInsights(existing) : null;
    return hit ?? (await rerunLapInsights(lapId, existing))?.insights ?? null;
  });
}

async function rerunLapInsights(lapId: number, existing?: MetricsRow): Promise<LapMetrics | null> {
  const row = existing ?? await db.select().from(lapMetrics).where(eq(lapMetrics.lapId, lapId)).get();
  const lap = await getLapById(lapId);
  if (!lap || lap.telemetry.length === 0 || !lap.gameId) return null;
  const gameId = lap.gameId as GameId;
  const processed = processLap(lap.telemetry, gameId);
  const insights = analyzeLap(processed.packets, gameId, {
    racingLine: resolveRacingLineReference(gameId, lap.trackId),
  });
  restoreF1FrameIndices(insights, processed.sourceIndices);
  if (row) {
    await persistInsights(lapId, insights);
    const refreshed = { ...row, insightVersion: STATIC_LAP_ANALYSIS_VERSION, insights: JSON.stringify(insights), computedAt: new Date().toISOString() };
    const hit = rowToMetrics(refreshed);
    if (hit) return hit;
  }
  const metrics = computeForLap(lap, insights);
  await persist(metrics);
  return metrics;
}

export function recomputeLapInsights(lapId: number): Promise<LapInsight[] | null> {
  return withLapWork(lapId, async () => (await rerunLapInsights(lapId))?.insights ?? null);
}

export async function getOrComputeLapMetricsBatch(lapIds: number[]): Promise<Map<number, LapMetrics>> {
  const output = new Map<number, LapMetrics>();
  if (lapIds.length === 0) return output;

  const ids = [...new Set(lapIds)];
  await Promise.all(ids.map((id) => lapWork.get(id)));
  const rows = await db.select().from(lapMetrics).where(inArray(lapMetrics.lapId, ids)).all();
  for (const row of rows) {
    const hit = rowToMetrics(row);
    if (hit) output.set(hit.lapId, hit);
  }

  const missing = ids.filter((id) => !output.has(id));
  if (missing.length === 0) return output;

  const loaded = await getLapsByIds(missing);
  for (const lap of loaded) {
    if (lap.telemetry.length === 0 || !lap.gameId) continue;
    const metrics = await withLapWork(lap.id, async () => {
      const current = await db.select().from(lapMetrics).where(eq(lapMetrics.lapId, lap.id)).get();
      const hit = current ? rowToMetrics(current) : null;
      if (hit) return hit;
      const computed = computeForLap(lap, current ? rowInsights(current) ?? undefined : undefined);
      await persist(computed);
      return computed;
    });
    output.set(lap.id, metrics);
  }
  return output;
}

/** Read current-version insights without decoding telemetry or running detectors. */
export async function getCachedLapInsightsBatch(lapIds: number[]): Promise<Map<number, LapInsight[]>> {
  const output = new Map<number, LapInsight[]>();
  if (lapIds.length === 0) return output;
  const ids = [...new Set(lapIds)];
  const rows = await db.select().from(lapMetrics).where(inArray(lapMetrics.lapId, ids)).all();
  for (const row of rows) {
    const hit = rowInsights(row);
    if (hit) output.set(row.lapId, hit);
  }
  return output;
}

export async function getOrComputeLapInsightsBatch(lapIds: number[]): Promise<Map<number, LapInsight[]>> {
  const output = new Map<number, LapInsight[]>();
  if (lapIds.length === 0) return output;

  const ids = [...new Set(lapIds)];
  await Promise.all(ids.map((id) => lapWork.get(id)));
  const rows = await db.select().from(lapMetrics).where(inArray(lapMetrics.lapId, ids)).all();
  for (const row of rows) {
    const hit = rowInsights(row);
    if (hit) output.set(row.lapId, hit);
  }

  const missing = ids.filter((id) => !output.has(id));
  const loaded = await getLapsByIds(missing);
  for (const lap of loaded) {
    if (lap.telemetry.length === 0 || !lap.gameId) continue;
    const insights = await withLapWork(lap.id, async () => {
      const current = await db.select().from(lapMetrics).where(eq(lapMetrics.lapId, lap.id)).get();
      const hit = current ? rowInsights(current) : null;
      if (hit) return hit;
      const gameId = lap.gameId as GameId;
      const processed = processLap(lap.telemetry, gameId);
      const computed = analyzeLap(processed.packets, gameId, {
        racingLine: resolveRacingLineReference(gameId, lap.trackId),
      });
      restoreF1FrameIndices(computed, processed.sourceIndices);
      if (current) await persistInsights(lap.id, computed);
      else await persist(computeForLap(lap, computed));
      return computed;
    });
    output.set(lap.id, insights);
  }
  return output;
}

export interface LapInsightBackfillReport {
  version: number;
  processed: number;
  recomputed: number;
  skipped: number;
  errors: number;
  nextAfterLapId: number | null;
}

export async function backfillLapInsights(options: {
  limit: number;
  afterLapId?: number;
  force?: boolean;
}): Promise<LapInsightBackfillReport> {
  const limit = Math.max(1, Math.min(500, Math.trunc(options.limit)));
  const afterLapId = options.afterLapId ?? 0;
  const stale = or(isNull(lapMetrics.lapId), ne(lapMetrics.insightVersion, STATIC_LAP_ANALYSIS_VERSION));
  const candidates = await db
    .select({ lapId: laps.id })
    .from(laps)
    .leftJoin(lapMetrics, eq(lapMetrics.lapId, laps.id))
    .where(and(gt(laps.id, afterLapId), options.force ? undefined : stale))
    .orderBy(asc(laps.id))
    .limit(limit)
    .all();

  let recomputed = 0;
  let skipped = 0;
  let errors = 0;
  for (const candidate of candidates) {
    try {
      const insights = options.force
        ? await recomputeLapInsights(candidate.lapId)
        : await getOrComputeLapInsights(candidate.lapId);
      if (insights) recomputed++;
      else skipped++;
    } catch {
      errors++;
    }
  }
  return {
    version: STATIC_LAP_ANALYSIS_VERSION,
    processed: candidates.length,
    recomputed,
    skipped,
    errors,
    nextAfterLapId: candidates.at(-1)?.lapId ?? null,
  };
}
