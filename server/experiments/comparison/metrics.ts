/**
 * Outcome metrics — what an experiment arm is actually being measured on
 * (issue #120, Phase 2).
 *
 * A `experiment_versions` row is an experiment arm. Until now the only thing the app
 * could compare arms on was lap time, and the lap pool feeding any comparison
 * was curated by one global rule: the fastest 5 (`server/experiments/auto-exclude.ts`
 * / `fastestLaps` in `shared/review-laps.ts`).
 *
 * ⚠️ **That rule is metric-specific, and treating it as global is a real bug.**
 * A consistency drill's whole outcome is the width of the lap distribution, and
 * taking the fastest 5 laps truncates the very tail that carries the signal.
 * Every arm then looks more consistent than it is, and the bias grows with lap
 * count (5 kept out of 8 laps is a mild trim; 5 out of 40 is a fantasy).
 *
 * So the curation policy lives **on the metric**, not on the session:
 *
 *   | metric family         | curation                                        |
 *   |-----------------------|-------------------------------------------------|
 *   | lap time              | ALL eligible laps + blunder fence (see below)   |
 *   | variance / dispersion | ALL eligible laps + blunder fence               |
 *
 * Both families land on the same policy, for the same reason: `compareArms`
 * runs a *statistical test*, and every such test assumes its inputs are an iid
 * sample. Fastest-N hands it order statistics instead. `fastest-n` therefore
 * survives as a `CurationSpec` mode — the review UI still curates that way, and
 * test/compare-arms.test.ts keeps measuring what it does to a p-value — but no
 * outcome metric uses it. See `lapTimeSec` below for the full argument.
 *
 * Eligibility itself is NOT re-derived here: it routes through
 * `selectEvaluationLaps` in `shared/review-laps.ts`, the canonical filter
 * (manual pins win, then invalid/pit, then the ranking). `all-valid` passes
 * `n = Infinity`, so nothing is ranked away and the persisted fastest-5 `auto`
 * exclusions are deliberately *ignored* — an `auto` stamp is a cached artefact
 * of the lap-time rule, not a statement that the lap was bad. Manual
 * exclusions are still respected, because those are a human's call.
 *
 * ## Two sampling modes
 *
 * A metric is either `"metadata"` (its samples are a function of the lap row —
 * lap time and friends, zero frames decoded) or `"pairwise-frames"` (each
 * sample is one lap measured against the arm's own reference lap). The
 * distinction is not cosmetic: `pairwise-frames` is what lets the DB loader
 * *stream* an arm — decode the reference once, then fold one lap at a time —
 * so peak memory is 2 laps no matter how long the track or how many laps were
 * driven. See `server/experiments/comparison/stream.ts`.
 *
 * `pairwise-frames` metrics expose only `reduce()`; use `extractSamples()` for
 * the in-memory path, which picks the reference and loops `reduce` for you.
 *
 * Everything in this module is pure. Nothing here judges an outcome: a metric
 * yields numbers, `compare-arms.ts` says whether two sets of numbers are
 * distinguishable, and a human writes `experiment_versions.verdict`.
 */

import type { TelemetryPacket } from "../../../shared/types";
import { type EvaluableLap, type EvaluationReason, REVIEW_LAP_CAP, selectEvaluationLaps } from "../../../shared/review-laps";
import type { Corner } from "../../lap-analysis/corners";
import { computeLapConsistencyDelta, LINE_SPREAD_FULL_SCALE_M } from "../../lap-analysis/consistency";

/** Which way is better for a metric. Never used to judge an arm — only to say
 *  which arm a *statistically distinguishable* difference points at. */
type MetricDirection = "lower-better" | "higher-better";

export const OUTCOME_METRIC_IDS = [
  "lapTimeSec",
  "consistencySpreadSec",
  "inputVarianceBrake",
  "inputVarianceThrottle",
  "lineSpreadScore",
] as const;

export type OutcomeMetricId = (typeof OUTCOME_METRIC_IDS)[number];

/** Input channel an `inputVariance*` metric measures. */
type InputChannel = "brake" | "throttle";

/**
 * How an arm's raw lap pool is reduced to the laps a metric is computed over.
 *
 * - `fastest-n` — rank eligible laps by lap time, keep the best `n`. What the
 *   review UI shows. No outcome metric uses it (see the module header); it
 *   stays here so the bias it introduces remains measurable in tests.
 * - `all-valid` — keep every eligible lap. The honest pool for a statistical
 *   test; the tail is signal, not noise.
 *
 * `outlierRule`:
 * - `none` — no outlier rule at all (the caller accepts contamination, or the
 *   cap already removed slow laps).
 * - `blunder-fence` — one explicit statistical rule (below), reported as
 *   `droppedOutliers`. Deliberately conservative: it exists to remove spins
 *   and off-tracks that the validity flag missed, not to tighten the
 *   distribution.
 */
export interface CurationSpec {
  mode: "fastest-n" | "all-valid";
  /** Only meaningful for `fastest-n`. */
  n?: number;
  outlierRule: "none" | "blunder-fence";
}

/** Why a lap is (or isn't) in a metric's pool. Extends the canonical review
 *  reasons with the dispersion-safe statistical fence. */
export type CurationReason = EvaluationReason | "outlier";

export interface CuratedPool<T> {
  kept: T[];
  reasonById: Map<number, CurationReason>;
  /** Laps removed by `blunder-fence`. Mirrors `ConsistencyReport.droppedOutliers`. */
  droppedOutliers: number;
  /** Laps removed as invalid / pit / manually excluded. */
  droppedIneligible: number;
  /** Clean laps that only lost the fastest-N ranking. Always 0 for `all-valid`. */
  droppedByCap: number;
}

/**
 * Blunder fence for `all-valid` pools. Upper-tail only (a lap can't be
 * implausibly *fast* without also being invalid), and triple-gated so it can't
 * eat a genuinely wide-but-real distribution:
 *
 *   1. at least `MIN_FENCE_SAMPLES` laps, so the quartiles mean something;
 *   2. above `median + FENCE_IQR_MULT * IQR` (3x, not the usual 1.5x — this is
 *      a blunder detector, not a normality test);
 *   3. AND more than `FENCE_MIN_REL_GAP` slower than the arm's best lap, so a
 *      metronomic arm whose IQR is near zero doesn't flag its own noise.
 */
const MIN_FENCE_SAMPLES = 4;
const FENCE_IQR_MULT = 3;
const FENCE_MIN_REL_GAP = 1.05;

function percentileAsc(sortedAsc: number[], p: number): number {
  const n = sortedAsc.length;
  if (n === 0) return 0;
  const idx = (n - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (idx - lo);
}

function medianAsc(sortedAsc: number[]): number {
  const n = sortedAsc.length;
  if (n === 0) return 0;
  const mid = Math.floor(n / 2);
  return n % 2 === 0 ? (sortedAsc[mid - 1] + sortedAsc[mid]) / 2 : sortedAsc[mid];
}

/** The blunder threshold for a lap-time pool, or null when the fence can't fire. */
export function blunderFence(lapTimes: number[]): number | null {
  if (lapTimes.length < MIN_FENCE_SAMPLES) return null;
  const sorted = [...lapTimes].sort((a, b) => a - b);
  const iqr = percentileAsc(sorted, 0.75) - percentileAsc(sorted, 0.25);
  const best = sorted[0];
  return Math.max(medianAsc(sorted) + FENCE_IQR_MULT * iqr, best * FENCE_MIN_REL_GAP);
}

/**
 * Blunder thresholds for a set of arms being compared: one shared *width*,
 * each arm's own *location*.
 *
 * Two arms fenced independently are censored at different widths, because each
 * arm's `IQR` and `best` are its own. The wider arm gets the more forgiving cut,
 * so for a dispersion metric — where the tail IS the measurement — the arms are
 * not comparably censored.
 *
 * The obvious repair, flattening both arms and fencing the pool, is worse: if
 * the arms differ in mean, that between-arm shift lands in the pooled IQR and
 * inflates it, so the fence stops firing at all. (Measured on a 90.0s vs 91.5s
 * pair: per-arm 94.50 / 96.08, naively pooled 99.20 — leniency, not fairness.)
 *
 * So the spread is pooled over arm-CENTERED residuals, which contain only
 * within-arm variation, and the threshold is then placed at each arm's own
 * median. A blunder stays "a lap far slower than this arm normally runs", but
 * "far" now means the same thing in both arms.
 *
 * The relative-gap floor stays per-arm on purpose: it exists so a metronomic
 * arm cannot flag its own noise, which is a statement about that arm's best lap.
 *
 * Returns one threshold per input arm, index-aligned; null entries mean that arm
 * is not fenced. All-null when the pooled sample is too small for quartiles.
 */
export function blunderFencesForArms(armLapTimes: number[][]): (number | null)[] {
  const total = armLapTimes.reduce((n, a) => n + a.length, 0);
  if (total < MIN_FENCE_SAMPLES) return armLapTimes.map(() => null);

  const residuals: number[] = [];
  for (const arm of armLapTimes) {
    if (arm.length === 0) continue;
    const med = medianAsc([...arm].sort((x, y) => x - y));
    for (const t of arm) residuals.push(t - med);
  }
  const sortedRes = residuals.sort((x, y) => x - y);
  const pooledIqr = percentileAsc(sortedRes, 0.75) - percentileAsc(sortedRes, 0.25);

  return armLapTimes.map((arm) => {
    if (arm.length === 0) return null;
    const sorted = [...arm].sort((x, y) => x - y);
    return Math.max(medianAsc(sorted) + FENCE_IQR_MULT * pooledIqr, sorted[0] * FENCE_MIN_REL_GAP);
  });
}

/**
 * Reduce one arm's raw lap pool to the laps a metric is computed over.
 *
 * Eligibility is delegated to `selectEvaluationLaps` so this never becomes a
 * fourth place that re-derives "which laps count".
 */
export function curateLaps<T extends EvaluableLap>(
  laps: T[],
  curation: CurationSpec,
  opts?: { fence?: number | null },
): CuratedPool<T> {
  const cap = curation.mode === "fastest-n" ? (curation.n ?? REVIEW_LAP_CAP) : Number.POSITIVE_INFINITY;
  const selection = selectEvaluationLaps(laps, cap);

  const reasonById = new Map<number, CurationReason>(selection.reasonById);
  let kept = selection.chosen;
  let droppedOutliers = 0;

  if (curation.outlierRule === "blunder-fence") {
    // `opts.fence` lets a caller comparing two arms censor both at ONE threshold
    // (see `pooledBlunderFence`). Per-arm fences are not comparable: each arm is
    // cut relative to its own spread, so the wider arm loses more of its tail and
    // a dispersion metric is biased toward "no difference" — the same defect this
    // module rejects fastest-N for. Undefined keeps the single-arm behaviour.
    const fence = opts?.fence !== undefined ? opts.fence : blunderFence(kept.map((l) => l.lapTime));
    if (fence != null) {
      const survivors: T[] = [];
      for (const lap of kept) {
        if (lap.lapTime > fence) {
          reasonById.set(lap.id, "outlier");
          droppedOutliers++;
          continue;
        }
        survivors.push(lap);
      }
      kept = survivors;
    }
  }

  let droppedIneligible = 0;
  for (const reason of reasonById.values()) {
    if (reason === "invalid" || reason === "pit" || reason === "manual") droppedIneligible++;
  }

  return {
    kept,
    reasonById,
    droppedOutliers,
    droppedIneligible,
    droppedByCap: selection.cappedIds.size,
  };
}

/** One lap of an arm: its metadata, plus decoded telemetry when the metric
 *  needs frames. `telemetry` is left null for the lap-time-only metrics so
 *  callers don't pay a decode they don't need. */
export interface ArmLap {
  lap: EvaluableLap;
  telemetry?: TelemetryPacket[] | null;
}

/** An arm's curated laps plus the track geometry frame-based metrics need. */
export interface MetricInput {
  laps: ArmLap[];
  corners?: Corner[];
}

export interface MetricSample {
  lapId: number;
  value: number;
}

/** Common to both sampling modes. */
interface OutcomeMetricBase {
  id: OutcomeMetricId;
  label: string;
  /** Unit suffix for display, "" when unitless. */
  unit: string;
  direction: MetricDirection;
  /** THE curation policy for this metric — see the module header. */
  curation: CurationSpec;
}

/** A metric computable from lap rows alone — no frames decoded, ever. */
export interface MetadataOutcomeMetric extends OutcomeMetricBase {
  sampling: "metadata";
  /** One sample per curated lap where computable. Pure. */
  extract(input: MetricInput): MetricSample[];
}

/** One lap measured against the arm's reference lap. */
export interface PairwiseReduceInput {
  lap: EvaluableLap;
  telemetry: TelemetryPacket[];
  /** The arm's reference lap's frames (its median-lap-time lap). */
  referenceTelemetry: TelemetryPacket[];
  corners: Corner[];
}

/**
 * A frame-based metric, expressed strictly PAIRWISE: one lap vs the arm's
 * reference lap, and nothing else. That constraint is what makes streaming
 * possible — `reduce` never needs a third lap in memory, so a loader can hold
 * the reference and fold the rest one at a time.
 *
 * Deliberately no `extract`: an implementation that could see the whole pool at
 * once would quietly re-acquire the pool-shaped dependency this interface
 * exists to forbid. Use `extractSamples()` for in-memory callers.
 */
export interface PairwiseFramesOutcomeMetric extends OutcomeMetricBase {
  sampling: "pairwise-frames";
  /** This lap's scalar sample, or null when it isn't computable. Pure. */
  reduce(input: PairwiseReduceInput): number | null;
}

export type OutcomeMetric = MetadataOutcomeMetric | PairwiseFramesOutcomeMetric;

/** True when sampling this metric requires decoding frames (and corners). */
export function metricNeedsTelemetry(metric: OutcomeMetric): boolean {
  return metric.sampling === "pairwise-frames";
}

/**
 * Fewest frames a lap must have to be worth measuring. Below this the
 * resampler has nothing to align against.
 */
export const MIN_TELEMETRY_FRAMES = 30;

function withTelemetry(input: MetricInput): { lap: EvaluableLap; telemetry: TelemetryPacket[] }[] {
  const out: { lap: EvaluableLap; telemetry: TelemetryPacket[] }[] = [];
  for (const entry of input.laps) {
    if (entry.telemetry && entry.telemetry.length >= MIN_TELEMETRY_FRAMES) {
      out.push({ lap: entry.lap, telemetry: entry.telemetry });
    }
  }
  return out;
}

/**
 * THE reference lap of an arm: its median-lap-time lap.
 *
 * Deterministic (lap time, then id, so equal times can't reorder between two
 * callers), and unlike the fastest lap it isn't a flyer. Crucially it is chosen
 * from **metadata only** — which is what lets the DB loader pick the reference,
 * decode just that one lap, and stream the rest past it.
 *
 * The reference is excluded from an arm's samples: its own deviation is 0 by
 * construction and would drag the arm's mean down.
 */
export function pickReferenceLap<T extends { lap: EvaluableLap }>(entries: T[]): T | null {
  if (entries.length === 0) return null;
  const byTime = [...entries].sort((a, b) => a.lap.lapTime - b.lap.lapTime || a.lap.id - b.lap.id);
  return byTime[Math.floor((byTime.length - 1) / 2)];
}

/**
 * Samples for either kind of metric, from laps already in memory.
 *
 * For `pairwise-frames` this is the non-streaming path: pick the reference, then
 * loop `reduce` over every other usable lap. The DB loader does the same fold
 * one lap at a time instead (`server/experiments/comparison/stream.ts`); both must agree, and
 * test/arm-stream.test.ts pins that they do.
 *
 * Sample order follows the INPUT order, not the sorted-by-lap-time order, so a
 * caller's `lapIds` array stays comparable across the two paths.
 */
export function extractSamples(metric: OutcomeMetric, input: MetricInput): MetricSample[] {
  if (metric.sampling === "metadata") return metric.extract(input);

  const corners = input.corners ?? [];
  const usable = withTelemetry(input);
  // `computeLapConsistencyDelta` returns an all-zero delta without corners, and
  // a pairwise sample needs something to be paired against.
  if (corners.length < 1 || usable.length < 2) return [];

  const reference = pickReferenceLap(usable);
  if (!reference) return [];

  const samples: MetricSample[] = [];
  for (const entry of usable) {
    if (entry.lap.id === reference.lap.id) continue;
    const value = metric.reduce({
      lap: entry.lap,
      telemetry: entry.telemetry,
      referenceTelemetry: reference.telemetry,
      corners,
    });
    if (value != null) samples.push({ lapId: entry.lap.id, value });
  }
  return samples;
}

/**
 * Per-lap deviation of an input/line channel from the arm's own reference lap.
 *
 * `computeLapConsistencyDelta` measures scatter across a *pool* — one number
 * per arm, which can't be t-tested. Feeding it the pair (lap, reference lap)
 * turns it into a per-lap sample: "how far did this lap differ from the way this
 * arm normally drives the track". The mean of those samples tracks the pool
 * figure, and the samples themselves carry the distribution a significance test
 * needs.
 */
function pairwiseDelta(input: PairwiseReduceInput): ReturnType<typeof computeLapConsistencyDelta> {
  return computeLapConsistencyDelta([input.telemetry, input.referenceTelemetry], input.corners);
}

/**
 * All eligible laps, with the blunder fence — NOT fastest-N. This reads
 * backwards ("surely the slow laps are noise on a lap-time test?"), so the
 * argument, which is about the *test*, not about lap times:
 *
 *  1. `compareArms` runs Welch's t-test. The question it answers is "is B's
 *     TYPICAL lap faster than A's", and it assumes an iid sample. Fastest-N
 *     hands it order statistics, which deflates each arm's within-arm spread and
 *     roughly doubles the false-positive rate: over 400 null experiments (12
 *     laps/arm, identical distributions) all-valid flags 4.8% at a nominal alpha
 *     of 5%, fastest-5 flags 12.3%. test/compare-arms.test.ts pins a 60-seed
 *     slice of that. A p-value you have to discount by 2.5x is not a p-value.
 *  2. Worse than conservative, it can *misrank*. On a loose-vs-tight pair with
 *     identical mean lap times, fastest-N keeps the loose arm's luckiest laps,
 *     so the LESS consistent arm reads as faster. Also pinned in that test.
 *  3. What "slow laps are noise" actually meant was contamination — spins, offs,
 *     a lift for traffic. That is the blunder fence's job, and the fence does it
 *     without deleting the clean tail. The fence removes bad *data*; the cap
 *     removed *data*.
 *
 * There is no memory argument either way: this is a `"metadata"` metric, so it
 * decodes nothing and the cap was never protecting anything.
 */
const lapTimeSec: MetadataOutcomeMetric = {
  id: "lapTimeSec",
  label: "Lap time",
  unit: "s",
  direction: "lower-better",
  curation: { mode: "all-valid", outlierRule: "blunder-fence" },
  sampling: "metadata",
  extract: (input) => input.laps.map((e) => ({ lapId: e.lap.id, value: e.lap.lapTime })),
};

/**
 * Lap-time dispersion, as per-lap absolute deviation from the arm's median lap
 * time. This is the Brown-Forsythe transform: a t-test over |x - median| is a
 * test of *spread*, which is what a consistency experiment is about, whereas a
 * t-test over raw lap times is a test of *level*.
 *
 * All eligible laps, precisely because fastest-N would delete the spread being
 * measured.
 *
 * ⚠️ One caveat the fastest-N argument above does NOT cover: the median is
 * estimated from the same laps the samples are built from, so these samples are
 * mildly dependent and Welch's p is slightly anti-conservative at small n. That
 * is inherent to Brown-Forsythe and accepted here — unlike fastest-N it is a
 * small, known bias in one direction rather than a 2.5x inflation that also
 * misranks. `MIN_LAPS_PER_ARM` is the guard that keeps it small; do not read a
 * marginal p on a spread metric as tightly as one on lap time.
 */
const consistencySpreadSec: MetadataOutcomeMetric = {
  id: "consistencySpreadSec",
  label: "Lap-time deviation",
  unit: "s",
  direction: "lower-better",
  curation: { mode: "all-valid", outlierRule: "blunder-fence" },
  sampling: "metadata",
  extract: (input) => {
    const times = input.laps.map((e) => e.lap.lapTime).sort((a, b) => a - b);
    if (times.length === 0) return [];
    const med = medianAsc(times);
    return input.laps.map((e) => ({ lapId: e.lap.id, value: Math.abs(e.lap.lapTime - med) }));
  },
};

function inputVarianceMetric(channel: InputChannel): PairwiseFramesOutcomeMetric {
  return {
    id: channel === "brake" ? "inputVarianceBrake" : "inputVarianceThrottle",
    label: channel === "brake" ? "Brake input variance" : "Throttle input variance",
    unit: "",
    direction: "lower-better",
    curation: { mode: "all-valid", outlierRule: "blunder-fence" },
    sampling: "pairwise-frames",
    reduce: (input) => {
      const d = pairwiseDelta(input);
      return channel === "brake" ? d.overall.brakeVar : d.overall.throttleVar;
    },
  };
}

/**
 * Racing-line repeatability, 0-100, per lap against the arm's reference lap.
 * Same scale as `LineSpreadTrace.consistencyScore`: 100 = identical line, 0 at
 * `LINE_SPREAD_FULL_SCALE_M` of lateral scatter. Higher-better, so it also
 * exercises the non-lap-time direction end to end.
 */
const lineSpreadScore: PairwiseFramesOutcomeMetric = {
  id: "lineSpreadScore",
  label: "Line consistency",
  unit: "/100",
  direction: "higher-better",
  curation: { mode: "all-valid", outlierRule: "blunder-fence" },
  sampling: "pairwise-frames",
  reduce: (input) => {
    const spread = pairwiseDelta(input).overall.lateralSpreadM;
    const frac = Math.min(1, Math.max(0, spread / LINE_SPREAD_FULL_SCALE_M));
    return 100 * (1 - frac);
  },
};

/** `satisfies`, not `:`, so each entry keeps its narrow sampling mode — a caller
 *  reaching for `.reduce` on a metadata metric should not typecheck. */
export const OUTCOME_METRICS = {
  lapTimeSec,
  consistencySpreadSec,
  inputVarianceBrake: inputVarianceMetric("brake"),
  inputVarianceThrottle: inputVarianceMetric("throttle"),
  lineSpreadScore,
} satisfies Record<OutcomeMetricId, OutcomeMetric>;

export function getOutcomeMetric(id: OutcomeMetricId): OutcomeMetric {
  return OUTCOME_METRICS[id];
}
