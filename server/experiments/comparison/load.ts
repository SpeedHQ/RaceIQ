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

import type { GameId, LapMeta, TelemetryPacket } from "../../../shared/types";
import type { EvaluableLap } from "../../../shared/review-laps";
import { detectCorners } from "../../lap-analysis/corners";
import type { Corner } from "../../lap-analysis/corners";
import { getCorners } from "../../db/track-queries";
import { getLapById } from "../../db/lap-read-queries";
import { getLapMetaForExperimentVersion } from "../../db/experiment-lap-queries";
import { getExperiment } from "../../db/experiment-queries";
import { getExperimentVersion } from "../../db/experiment-version-queries";
import {
  type ArmComparison,
  compareArmSamples,
  type CompareArmsOptions,
  prepareArm,
  type PreparedArm,
} from "./compare";
import { type FrameLapMeta, type LapFrameLoader, streamArmSamples } from "./stream";
import { blunderFencesForArms, getOutcomeMetric, type OutcomeMetricId } from "./metrics";

/**
 * Frames for one lap, through the shared LRU telemetry cache.
 *
 * Deliberately `getLapById` rather than a raw parse: the cache is bounded by a
 * 256MB evict-on-insert budget (`docs/architecture/lap-cache.md`), so it cannot
 * grow without limit, and bypassing it would re-decode the stint on each use.
 */
const loadLapFrames: LapFrameLoader = async (lapId) => {
  const lap = await getLapById(lapId);
  return lap?.telemetry ?? null;
};

function toEvaluable(meta: LapMeta): EvaluableLap {
  return {
    id: meta.id,
    lapTime: meta.lapTime,
    isValid: meta.isValid,
    invalidReason: meta.invalidReason ?? null,
    experimentExcluded: meta.experimentExcluded ?? false,
    experimentExcludedSource: meta.experimentExcludedSource ?? null,
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
 * Corners for the fold. Curated track geometry wins; `detectCorners` on the
 * arm's reference lap is the fallback, and matters because
 * `computeLapConsistencyDelta` returns an all-zero delta when there are no
 * corners — no corners means no samples, not a "perfect" arm.
 */
async function resolveCornersFor(
  sessionId: number,
  metas: LapMeta[],
  referenceTelemetry: TelemetryPacket[],
): Promise<Corner[]> {
  const session = await getExperiment(sessionId);
  const trackOrdinal = session?.trackOrdinal ?? metas.find((m) => m.trackOrdinal != null)?.trackOrdinal ?? null;
  const gameId = (session?.gameId ?? metas.find((m) => m.gameId != null)?.gameId ?? null) as GameId | null;
  if (trackOrdinal != null && gameId) {
    const curated = await getCorners(trackOrdinal, gameId);
    if (curated.length > 0) return curated;
  }
  return detectCorners(referenceTelemetry);
}

/**
 * Load both arms' lap pools and compare them on one outcome metric.
 *
 * Curation is the metric's own policy (`server/experiments/comparison/metrics.ts`), applied
 * to the RAW pool — this loader never pre-trims by lap time.
 */
export async function loadArmComparison(
  sessionId: number,
  aTestId: number,
  bTestId: number,
  metricId: OutcomeMetricId,
  opts?: CompareArmsOptions,
): Promise<ArmComparison> {
  const metric = getOutcomeMetric(metricId);
  const [aMetas, bMetas, aLabel, bLabel] = await Promise.all([
    getLapMetaForExperimentVersion(aTestId),
    getLapMetaForExperimentVersion(bTestId),
    armLabel(aTestId),
    armLabel(bTestId),
  ]);

  // Shared fence width, per-arm placement (`blunderFencesForArms`). Computed
  // here, where both pools are known, and handed to whichever path runs below —
  // the streaming and in-memory paths must censor identically or the equivalence
  // test/arm-stream.test.ts pins is a fiction.
  const [fenceA, fenceB] =
    metric.curation.outlierRule === "blunder-fence"
      ? blunderFencesForArms([aMetas.map((m) => m.lapTime), bMetas.map((m) => m.lapTime)])
      : [undefined, undefined];

  if (metric.sampling === "metadata") {
    const prepare = (label: string, metas: LapMeta[], fence: number | null | undefined): PreparedArm =>
      prepareArm({ label, laps: metas.map((m) => ({ lap: toEvaluable(m), telemetry: null })) }, metric, { fence });
    return compareArmSamples(prepare(aLabel, aMetas, fenceA), prepare(bLabel, bMetas, fenceB), metric, opts);
  }

  // Resolved once, on whichever arm streams first, and shared: two arms of the
  // same experiment are by definition the same track.
  let corners: Corner[] | null = null;
  const resolveCorners = async (referenceTelemetry: TelemetryPacket[]): Promise<Corner[]> => {
    corners ??= await resolveCornersFor(sessionId, [...aMetas, ...bMetas], referenceTelemetry);
    return corners;
  };

  const a = await streamArmSamples({
    label: aLabel,
    metas: aMetas.map(toFrameMeta),
    metric,
    loadFrames: loadLapFrames,
    resolveCorners,
    fence: fenceA,
  });
  const b = await streamArmSamples({
    label: bLabel,
    metas: bMetas.map(toFrameMeta),
    metric,
    loadFrames: loadLapFrames,
    resolveCorners,
    fence: fenceB,
  });

  return compareArmSamples(a, b, metric, opts);
}
