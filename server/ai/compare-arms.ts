/**
 * A-vs-B significance between two experiment arms (issue #120, Phase 2).
 *
 * `clean-lap-aggregate.ts` computes confidence *within* one arm. Comparing two
 * arms was left to eyeballing dashboards, which is how a 0.05s "gain" over
 * three laps becomes a setup decision. This module does the actual test:
 * Welch's t-test (unequal variances — two arms rarely have the same spread),
 * Hedges' g for effect size, and a percentile bootstrap CI on the difference in
 * means, over whichever `OutcomeMetric` the experiment is being judged on.
 *
 * ⚠️ **`significance` is a statement about a measurement, not about the car or
 * the driver.** It answers exactly one question: "is this difference
 * distinguishable from noise?" It does NOT mean the change was good, and it is
 * deliberately *not* called `verdict`.
 *
 * `experiment_versions.verdict` is a human column. Nothing in this file writes it,
 * nothing derived from this file may write it, and `verdict_source` exists to
 * record how the *driver* decided ('manual', or 'ai' for a chat suggestion the
 * driver accepted). See the v37 migration comment in `server/db/migrations.ts`.
 * A significant lap-time drop with a car the driver can no longer trust is a
 * refuted experiment; only a person can say that.
 *
 * Hard guardrail: below `MIN_LAPS_PER_ARM` samples in either arm the result is
 * `inconclusive` with a reason, and never a confident call — mirroring how
 * `computeConsistency` collapses to "very-low" under 2 clean laps.
 *
 * Pure and deterministic: the bootstrap uses a seeded PRNG, so the same laps
 * always produce the same CI.
 */

import type { Corner } from "../corner-detection";
import type { EvaluableLap } from "../../shared/review-laps";
import {
  type ArmLap,
  type CuratedPool,
  type CurationReason,
  curateLaps,
  extractSamples,
  metricNeedsTelemetry,
  type MetricSample,
  type OutcomeMetric,
} from "./outcome-metrics";

/**
 * Minimum samples per arm for any confident statement. Three is the point at
 * which a spread is even estimable; with two, Welch's df is ~1 and the CI is
 * wider than any difference a setup change makes.
 */
export const MIN_LAPS_PER_ARM = 3;

/**
 * Below this, a non-significant result is reported as `underpowered`: absence
 * of evidence, not evidence of absence. Above it, "not significant" starts to
 * mean something.
 */
export const RECOMMENDED_LAPS_PER_ARM = 5;

const DEFAULT_ALPHA = 0.05;
const DEFAULT_BOOTSTRAP = 2000;
const DEFAULT_SEED = 0x5eed_1a9;

/** Statistical description of the measured difference. Never a judgement. */
export type Significance = "significant" | "not-significant" | "inconclusive";

export interface ArmSummary {
  label: string | null;
  /** Samples the metric actually produced (not the raw lap count). */
  n: number;
  mean: number | null;
  /** Sample standard deviation (n-1); null under 2 samples. */
  sd: number | null;
  min: number | null;
  max: number | null;
  lapIds: number[];
  /** Raw laps handed in, before curation. */
  rawLapCount: number;
  droppedOutliers: number;
  droppedIneligible: number;
  /** Laps that lost the fastest-N ranking. Always 0 under `all-valid`, which is
   *  every shipped metric — see the outcome-metrics.ts header. */
  droppedByCap: number;
  /**
   * Curated laps the loader's frame budget declined to decode (see
   * `FRAME_BUDGET_PER_ARM` in `server/ai/arm-stream.ts`). Always 0 for a
   * `"metadata"` metric and for in-memory callers. Non-zero means the sample is
   * smaller than the driver's stint — never truncate without saying so.
   */
  droppedByFrameBudget: number;
  /** Frames actually decoded for this arm, or null when nothing was decoded. */
  framesDecoded: number | null;
  curationMode: OutcomeMetric["curation"]["mode"];
  reasonById: Map<number, CurationReason>;
}

export interface ArmComparison {
  metricId: OutcomeMetric["id"];
  metricLabel: string;
  unit: string;
  direction: OutcomeMetric["direction"];
  a: ArmSummary;
  b: ArmSummary;
  /** `b.mean - a.mean`, in the metric's unit. Null when either arm is empty. */
  deltaMean: number | null;
  /** Percentile bootstrap CI (default 95%) on `deltaMean`. */
  ci: [number, number] | null;
  /** Two-sided Welch p-value. */
  pValue: number | null;
  /** Hedges' g (bias-corrected Cohen's d), signed like `deltaMean`. */
  effectSize: number | null;
  significance: Significance;
  underpowered: boolean;
  /** Which arm the difference points at, given the metric's direction. Null
   *  unless the difference is significant. */
  favours: "a" | "b" | null;
  /** Why the result is inconclusive / underpowered. Null when neither applies. */
  reason: string | null;
}

export interface ArmInput {
  label?: string | null;
  /** Raw, UNCURATED laps for this arm — curation is the metric's job. */
  laps: ArmLap[];
  corners?: Corner[];
}

export interface CompareArmsOptions {
  alpha?: number;
  bootstrapSamples?: number;
  seed?: number;
}

// ── stats primitives (exported for direct unit testing) ─────────────────────

export function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((s, v) => s + v, 0) / xs.length;
}

/** Unbiased (n-1) sample variance; 0 under 2 samples. */
export function sampleVariance(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return xs.reduce((s, v) => s + (v - m) * (v - m), 0) / (xs.length - 1);
}

/** Lanczos log-gamma. */
function logGamma(x: number): number {
  const g = [
    76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2,
    -0.5395239384953e-5,
  ];
  let y = x;
  const tmp = x + 5.5;
  let ser = 1.000000000190015;
  for (const c of g) ser += c / ++y;
  return -tmp + (x + 0.5) * Math.log(tmp) + Math.log((2.5066282746310005 * ser) / x);
}

/** Continued-fraction expansion for the incomplete beta (Lentz's method). */
function betaContinuedFraction(a: number, b: number, x: number): number {
  const FPMIN = 1e-300;
  const EPS = 3e-12;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/** Regularized incomplete beta I_x(a, b). */
export function incompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  if (x < (a + 1) / (a + b + 2)) return (bt * betaContinuedFraction(a, b, x)) / a;
  return 1 - (bt * betaContinuedFraction(b, a, 1 - x)) / b;
}

export interface WelchResult {
  t: number;
  df: number;
  /** Two-sided p. */
  p: number;
  /** Standard error of the difference in means. */
  se: number;
}

/**
 * Welch's unequal-variance t-test on `b` vs `a` (sign follows `mean(b) - mean(a)`).
 * Returns `se === 0` when both arms are constant — the caller must treat that as
 * inconclusive rather than as p = 0.
 */
export function welchTTest(a: number[], b: number[]): WelchResult {
  const na = a.length;
  const nb = b.length;
  const va = sampleVariance(a);
  const vb = sampleVariance(b);
  const sa = na > 0 ? va / na : 0;
  const sb = nb > 0 ? vb / nb : 0;
  const se = Math.sqrt(sa + sb);
  if (!(se > 0)) return { t: 0, df: 0, p: 1, se: 0 };

  const t = (mean(b) - mean(a)) / se;
  const num = (sa + sb) * (sa + sb);
  const den = (na > 1 ? (sa * sa) / (na - 1) : 0) + (nb > 1 ? (sb * sb) / (nb - 1) : 0);
  const df = den > 0 ? num / den : 1;
  const p = incompleteBeta(df / (df + t * t), df / 2, 0.5);
  return { t, df, p: Math.min(1, Math.max(0, p)), se };
}

/** Hedges' g — Cohen's d on the pooled SD, bias-corrected for small samples. */
export function hedgesG(a: number[], b: number[]): number | null {
  const na = a.length;
  const nb = b.length;
  if (na < 2 || nb < 2) return null;
  const pooledVar = ((na - 1) * sampleVariance(a) + (nb - 1) * sampleVariance(b)) / (na + nb - 2);
  if (!(pooledVar > 0)) return null;
  const d = (mean(b) - mean(a)) / Math.sqrt(pooledVar);
  const correction = 1 - 3 / (4 * (na + nb) - 9);
  return d * correction;
}

/** Deterministic PRNG so a bootstrap CI is reproducible across runs. */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function resampleMean(xs: number[], rand: () => number): number {
  let sum = 0;
  for (let i = 0; i < xs.length; i++) sum += xs[Math.floor(rand() * xs.length)];
  return sum / xs.length;
}

/**
 * Percentile bootstrap CI on `mean(b) - mean(a)`. Distribution-free, which
 * matters: the absolute-deviation samples a variance metric produces are
 * half-normal, not normal.
 */
export function bootstrapMeanDiffCI(
  a: number[],
  b: number[],
  opts?: { alpha?: number; samples?: number; seed?: number },
): [number, number] | null {
  if (a.length < 2 || b.length < 2) return null;
  const alpha = opts?.alpha ?? DEFAULT_ALPHA;
  const samples = opts?.samples ?? DEFAULT_BOOTSTRAP;
  const rand = mulberry32(opts?.seed ?? DEFAULT_SEED);

  const diffs: number[] = [];
  for (let i = 0; i < samples; i++) diffs.push(resampleMean(b, rand) - resampleMean(a, rand));
  diffs.sort((x, y) => x - y);

  const pick = (p: number): number => {
    const idx = (diffs.length - 1) * p;
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    if (lo === hi) return diffs[lo];
    return diffs[lo] + (diffs[hi] - diffs[lo]) * (idx - lo);
  };
  return [pick(alpha / 2), pick(1 - alpha / 2)];
}

// ── the comparison ──────────────────────────────────────────────────────────

/**
 * An arm reduced to its samples, with the bookkeeping of how it got there.
 *
 * The seam between "get the numbers" and "test the numbers": `compareArms`
 * builds one of these from laps held in memory, and the streaming loader builds
 * one by folding laps past a reference (`server/ai/arm-stream.ts`). Both then go
 * through `compareArmSamples`, so there is exactly one implementation of the
 * statistics and of the guardrail.
 */
export interface PreparedArm {
  label: string | null;
  /** Raw laps in the arm, before curation. */
  rawLapCount: number;
  pool: CuratedPool<EvaluableLap>;
  samples: MetricSample[];
  /** See `ArmSummary.droppedByFrameBudget`. */
  droppedByFrameBudget?: number;
  framesDecoded?: number | null;
}

function summarize(prepared: PreparedArm, curationMode: OutcomeMetric["curation"]["mode"]): ArmSummary {
  const values = prepared.samples.map((s) => s.value);
  return {
    label: prepared.label,
    n: values.length,
    mean: values.length > 0 ? mean(values) : null,
    sd: values.length > 1 ? Math.sqrt(sampleVariance(values)) : null,
    min: values.length > 0 ? Math.min(...values) : null,
    max: values.length > 0 ? Math.max(...values) : null,
    lapIds: prepared.samples.map((s) => s.lapId),
    rawLapCount: prepared.rawLapCount,
    droppedOutliers: prepared.pool.droppedOutliers,
    droppedIneligible: prepared.pool.droppedIneligible,
    droppedByCap: prepared.pool.droppedByCap,
    droppedByFrameBudget: prepared.droppedByFrameBudget ?? 0,
    framesDecoded: prepared.framesDecoded ?? null,
    curationMode,
    reasonById: prepared.pool.reasonById,
  };
}

/**
 * Curate one arm's in-memory laps and sample the metric over them.
 *
 * Exported so a test (or any caller holding laps already) can build the
 * non-streaming side of an equivalence check.
 */
export function prepareArm(arm: ArmInput, metric: OutcomeMetric): PreparedArm {
  const pool = curateLaps(
    arm.laps.map((e) => e.lap),
    metric.curation,
  );
  const kept = new Set(pool.kept.map((l) => l.id));
  // Input order, not curated (lap-time-sorted) order — see `extractSamples`.
  const laps = arm.laps.filter((e) => kept.has(e.lap.id));
  return {
    label: arm.label ?? null,
    rawLapCount: arm.laps.length,
    pool,
    samples: extractSamples(metric, { laps, corners: arm.corners }),
  };
}

/**
 * Compare two experiment arms on one outcome metric.
 *
 * Curation is driven by `metric.curation` and eligibility by
 * `selectEvaluationLaps` — pass the arms' RAW lap pools, not a pre-trimmed set,
 * or the metric's policy is silently bypassed.
 */
export function compareArms(a: ArmInput, b: ArmInput, metric: OutcomeMetric, opts?: CompareArmsOptions): ArmComparison {
  return compareArmSamples(prepareArm(a, metric), prepareArm(b, metric), metric, opts);
}

/** The statistics, over two already-sampled arms. */
export function compareArmSamples(
  a: PreparedArm,
  b: PreparedArm,
  metric: OutcomeMetric,
  opts?: CompareArmsOptions,
): ArmComparison {
  const alpha = opts?.alpha ?? DEFAULT_ALPHA;

  const summaryA = summarize(a, metric.curation.mode);
  const summaryB = summarize(b, metric.curation.mode);

  const samplesA = a.samples;
  const samplesB = b.samples;
  const valuesA = samplesA.map((s) => s.value);
  const valuesB = samplesB.map((s) => s.value);

  const base = {
    metricId: metric.id,
    metricLabel: metric.label,
    unit: metric.unit,
    direction: metric.direction,
    a: summaryA,
    b: summaryB,
    deltaMean: summaryA.mean != null && summaryB.mean != null ? summaryB.mean - summaryA.mean : null,
  };

  const minN = Math.min(valuesA.length, valuesB.length);
  if (minN < MIN_LAPS_PER_ARM) {
    const shortfall = `${valuesA.length} and ${valuesB.length} usable ${metricNeedsTelemetry(metric) ? "measured laps" : "laps"}`;
    return {
      ...base,
      ci: null,
      pValue: null,
      effectSize: null,
      significance: "inconclusive",
      underpowered: true,
      favours: null,
      reason:
        `Need at least ${MIN_LAPS_PER_ARM} laps per arm to separate a change from noise; got ${shortfall}. ` +
        `Drive more laps on ${valuesA.length < MIN_LAPS_PER_ARM ? "arm A" : "arm B"}.`,
    };
  }

  const welch = welchTTest(valuesA, valuesB);
  if (!(welch.se > 0)) {
    return {
      ...base,
      ci: null,
      pValue: null,
      effectSize: null,
      significance: "inconclusive",
      underpowered: true,
      favours: null,
      reason: "Both arms measured identically on every lap — no variation to test against.",
    };
  }

  const ci = bootstrapMeanDiffCI(valuesA, valuesB, {
    alpha,
    samples: opts?.bootstrapSamples,
    seed: opts?.seed,
  });
  const effectSize = hedgesG(valuesA, valuesB);
  const significant = welch.p < alpha;
  const delta = base.deltaMean ?? 0;

  let favours: "a" | "b" | null = null;
  if (significant && delta !== 0) {
    const bIsBetter = metric.direction === "lower-better" ? delta < 0 : delta > 0;
    favours = bIsBetter ? "b" : "a";
  }

  const underpowered = !significant && minN < RECOMMENDED_LAPS_PER_ARM;
  const reason = underpowered
    ? `No distinguishable difference, but with only ${minN} laps in the smaller arm this is absence of evidence, ` +
      `not evidence of absence — ${RECOMMENDED_LAPS_PER_ARM}+ per arm makes a null result meaningful.`
    : null;

  return {
    ...base,
    ci,
    pValue: welch.p,
    effectSize,
    significance: significant ? "significant" : "not-significant",
    underpowered,
    favours,
    reason,
  };
}

/** JSON-safe projection of a comparison (`reasonById` is a Map). */
export function serializeComparison(cmp: ArmComparison) {
  const arm = (s: ArmSummary) => ({
    ...s,
    reasonById: undefined,
    lapReasons: [...s.reasonById.entries()].map(([lapId, reason]) => ({ lapId, reason })),
  });
  return { ...cmp, a: arm(cmp.a), b: arm(cmp.b), summary: describeComparison(cmp) };
}

/**
 * One-line human-readable rendering of a comparison, for chat/agent context.
 *
 * Phrased strictly as a measurement ("distinguishable from noise"), never as
 * "better" — a reader must not be able to lift this string into a verdict.
 */
/**
 * Frame-budget disclosure. A sample smaller than the driver's stint must say so
 * on the face of the result, not only in a field nobody reads.
 */
function describeBudgetDrop(cmp: ArmComparison): string {
  const parts: string[] = [];
  for (const [name, arm] of [
    [cmp.a.label ?? "A", cmp.a],
    [cmp.b.label ?? "B", cmp.b],
  ] as const) {
    if (arm.droppedByFrameBudget > 0) {
      parts.push(`${arm.droppedByFrameBudget} on ${name}`);
    }
  }
  return parts.length > 0 ? ` [oldest laps not decoded within the frame budget: ${parts.join(", ")}]` : "";
}

export function describeComparison(cmp: ArmComparison): string {
  const unit = cmp.unit;
  const aLabel = cmp.a.label ?? "A";
  const bLabel = cmp.b.label ?? "B";
  const head = `${cmp.metricLabel}: ${aLabel} ${cmp.a.mean?.toFixed(3) ?? "n/a"}${unit} (n=${cmp.a.n}) vs ${bLabel} ${cmp.b.mean?.toFixed(3) ?? "n/a"}${unit} (n=${cmp.b.n})${describeBudgetDrop(cmp)}`;
  if (cmp.significance === "inconclusive") return `${head} — inconclusive. ${cmp.reason ?? ""}`.trim();

  const delta = cmp.deltaMean ?? 0;
  const ci = cmp.ci ? ` [95% CI ${cmp.ci[0].toFixed(3)} to ${cmp.ci[1].toFixed(3)}]` : "";
  const stats = ` delta ${delta >= 0 ? "+" : ""}${delta.toFixed(3)}${unit}${ci}, p=${cmp.pValue?.toFixed(4)}, g=${cmp.effectSize?.toFixed(2) ?? "n/a"}`;
  if (cmp.significance === "significant") {
    const arm = cmp.favours === "b" ? bLabel : aLabel;
    return `${head} —${stats}. Distinguishable from noise, pointing at ${arm} on this metric. Whether that is an improvement is the driver's call.`;
  }
  return `${head} —${stats}. Not distinguishable from noise.${cmp.underpowered ? ` ${cmp.reason}` : ""}`;
}
