/**
 * DB-backed loader for `compareArms` (issue #120, Phase 2).
 *
 * Keeps `compare-arms.ts`, `outcome-metrics.ts` and `arm-stream.ts` pure: this
 * is the only place that knows arms live in `experiment_versions` and laps in SQLite.
 * Read-only — it never writes a verdict, a lap exclusion, or anything else.
 *
 * Two paths, chosen by the metric's sampling mode:
 *
 * - `"metadata"` (lap time, lap-time spread) — one query per arm, zero frames
 *   decoded, every eligible lap in the sample. There is nothing to bound.
 * - `"pairwise-frames"` (input variance, line spread) — streamed by
 *   `arm-stream.ts`: the reference lap is decoded once and every other lap is
 *   folded past it one at a time, so peak live telemetry is 2 laps regardless of
 *   track length or lap count. The arms are streamed SEQUENTIALLY (not
 *   `Promise.all`) precisely to keep that bound: overlapping them would double it.
 */

import { GameIdSchema } from "../../../shared/games/ids";
import type { SemanticTelemetrySample } from "@shared/telemetry/replay/contracts";
import type { LapMeta } from "../../../shared/racing/sessions/types";
import type { EvaluableLap } from "../../../shared/racing/laps/review-selection";
import type { Corner } from "../../lap-analysis/corners";
import { resolveSemanticLapCorners } from "../../tracks/corner-resolution";
import { getLapMetaForExperimentVersion } from "../../db/experiment-lap-queries";
import { getExperiment } from "../../db/experiment-queries";
import { getExperimentVersion } from "../../db/experiment-version-queries";
import { queryLapTelemetryBySemanticId } from "../../telemetry/replay";
import { semanticSamplesFromReplay } from "../../telemetry/semantic-samples";
import { type ArmComparison, compareArmSamples, type CompareArmsOptions, prepareArm, type PreparedArm } from "./compare";
import { type FrameLapMeta, type SemanticSampleLoader, streamArmSamples } from "./stream";
import { comparisonFences, EXPERIMENT_COMPARISON_SEMANTIC_IDS, getOutcomeMetric, type OutcomeMetricId } from "./metrics";

function toEvaluable(meta: LapMeta): EvaluableLap {
  return {
    id: meta.id,
    lapTime: meta.lapTime,
    isValid: meta.isValid,
    phase: meta.phase,
    conditions: meta.conditions,
    paceEligibility: meta.paceEligibility,
    invalidReason: meta.invalidReason ?? null,
    experimentExcluded: meta.experimentExcluded ?? false,
    experimentExcludedSource: meta.experimentExcludedSource ?? null,
    quality: meta.quality,
    eligibility: meta.eligibility,
    qualityGeneration: meta.qualityGeneration,
    qualityStale: meta.qualityStale,
  };
}

function toFrameMeta(meta: LapMeta): FrameLapMeta {
  return {
    ...toEvaluable(meta),
    lapNumber: meta.lapNumber,
    createdAt: meta.createdAt,
    rawFrameCount: meta.rawFrameCount ?? null,
  };
}

async function armLabel(versionId: number): Promise<string> {
  const test = await getExperimentVersion(versionId);
  return test ? test.label : `#${versionId}`;
}

/**
 * Load both arms' lap pools and compare them on one outcome metric.
 *
 * Curation is the metric's own policy (`server/experiments/comparison/metrics.ts`), applied
 * to the raw pool — this loader never pre-trims by lap time.
 */
export async function loadArmComparison(sessionId: number, aTestId: number, bTestId: number, metricId: OutcomeMetricId, opts?: CompareArmsOptions): Promise<ArmComparison> {
  const metric = getOutcomeMetric(metricId);
  const [aMetas, bMetas, aLabel, bLabel, experiment] = await Promise.all([
    getLapMetaForExperimentVersion(aTestId),
    getLapMetaForExperimentVersion(bTestId),
    armLabel(aTestId),
    armLabel(bTestId),
    getExperiment(sessionId),
  ]);
  if (!experiment) throw new Error(`Experiment ${sessionId} not found`);
  const gameId = GameIdSchema.parse(experiment.gameId);
  for (const meta of aMetas) {
    if (meta.gameId !== gameId) throw new Error(`Lap ${meta.id} game ID does not match experiment ${sessionId}`);
  }
  for (const meta of bMetas) {
    if (meta.gameId !== gameId) throw new Error(`Lap ${meta.id} game ID does not match experiment ${sessionId}`);
  }

  // Compute the shared fence policy before choosing metadata or streaming;
  // both paths must censor identical lap pools.
  const [fenceA, fenceB] = comparisonFences(
    metric,
    aMetas.map((m) => m.lapTime),
    bMetas.map((m) => m.lapTime),
  );

  if (metric.sampling === "metadata") {
    const prepare = (label: string, metas: LapMeta[], fence: number | null | undefined): PreparedArm =>
      prepareArm({ label, laps: metas.map((m) => ({ lap: toEvaluable(m), semanticSamples: null })) }, metric, { fence });
    return compareArmSamples(prepare(aLabel, aMetas, fenceA), prepare(bLabel, bMetas, fenceB), metric, opts);
  }

  // Resolved once, on whichever arm streams first, and shared: two arms of the
  // same experiment are by definition on the same game-owned track.
  let corners: Corner[] | null = null;
  const resolveCorners = async (referenceSamples: readonly SemanticTelemetrySample[]): Promise<Corner[]> => {
    corners ??= await resolveSemanticLapCorners(experiment.trackOrdinal, gameId, referenceSamples);
    return corners;
  };
  const replayByLapId = new Map<number, Promise<SemanticTelemetrySample[] | null>>();
  const loadSamples: SemanticSampleLoader = (lapId) => {
    const cached = replayByLapId.get(lapId);
    if (cached) return cached;
    const replay = queryLapTelemetryBySemanticId(lapId, EXPERIMENT_COMPARISON_SEMANTIC_IDS).then((result) => (result ? semanticSamplesFromReplay(result) : null));
    replayByLapId.set(lapId, replay);
    return replay;
  };

  const a = await streamArmSamples({
    label: aLabel,
    metas: aMetas.map(toFrameMeta),
    metric,
    loadSamples,
    resolveCorners,
    fence: fenceA,
  });
  const b = await streamArmSamples({
    label: bLabel,
    metas: bMetas.map(toFrameMeta),
    metric,
    loadSamples,
    resolveCorners,
    fence: fenceB,
  });

  return compareArmSamples(a, b, metric, opts);
}
