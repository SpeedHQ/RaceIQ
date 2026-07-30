/**
 * driver-profile-aggregate — the deterministic half of the Driver Profiler
 * (issue #118). Reduces a pool of the driver's laps to a single
 * `DriverFingerprint`: normalised style axes, ranked weaknesses and a global
 * recent normalized trend.
 *
 * Everything here is pure arithmetic over `analyzeLap()`'s per-lap insights —
 * no LLM, no clock, no randomness. The same laps in always produce a deeply
 * equal fingerprint out, so the (later) DB cache can key on lap ids alone and
 * the coach agent can be re-run without the profile drifting underneath it.
 *
 * Two scopes share one code path:
 *   - per car+track  ("how do I drive this car at this track")
 *   - global driver  ("how do I drive, full stop")
 * There is no driver identity to filter on — RaceIQ is single-local-driver. The
 * `profiles` table and `laps.profile_id` are dead columns; they are deliberately
 * not consulted here.
 *
 * Structure mirrors clean-lap-aggregate.ts: pure exported building blocks at the
 * top, one DB-touching `load*` entry point at the bottom.
 */
import { aggregateLapStyles, summariseLapStyle, type LapStyleSummary } from "../../shared/lib/driving-style";
import { analyzeLap, type InsightCategory, type InsightSeverity, type LapInsight } from "../../shared/lib/lap-insights";
import { repeatabilityStats } from "../../shared/lib/stint-stats";
import { clamp } from "../../shared/stint-trace";
import type { GameId, LapMeta } from "../../shared/types";
import { getLapMetaForProfileScope, getLapsByIds } from "../db/queries";
import type { Confidence } from "./clean-lap-aggregate";

// ---------------------------------------------------------------------------
// Tuning constants
// ---------------------------------------------------------------------------
export const DRIVER_TREND_WINDOW_LAPS = 30;


/** Below this, the style axes are noise and are reported as null rather than as a driving style. */
export const MIN_LAPS_FOR_STYLE = 3;

/** Minimum decoded frames for a lap to be worth running detectors over (matches clean-lap-aggregate). */
const MIN_TELEMETRY_FRAMES = 30;

const SEVERITY_WEIGHT: Record<InsightSeverity, number> = { info: 1, warning: 2, critical: 3 };
const MAX_SEVERITY_WEIGHT = 3;

// ---------------------------------------------------------------------------
// Detector universe
// ---------------------------------------------------------------------------

const WHEELS = ["FL", "FR", "RL", "RR"] as const;
const perWheel = (prefix: string): string[] => WHEELS.map((w) => `${prefix}${w}`);

/**
 * Every detector id `analyzeLap` can emit. Needed because a *strength* is the
 * absence of a detector, and absent detectors leave no trace in the insight
 * list. Kept in lockstep with shared/lib/lap-insights.ts by
 * test/driver-profile-aggregate.test.ts, which fails if the two drift.
 */
export const ALL_DETECTOR_IDS: readonly string[] = [
  ...perWheel("susp-overload-"),
  "susp-imbalance",
  ...perWheel("tire-overheat-"),
  ...perWheel("tire-lockup-"),
  ...perWheel("tire-spin-"),
  "tire-wear-imbalance",
  "tire-temp-split",
  ...perWheel("tire-edge-temp-"),
  "driving-brake-traction-loss",
  "driving-rev-limiter",
  "driving-coasting",
  "driving-trail-brake",
  "driving-counter-steer",
  "driving-early-braking",
  "driving-over-slowing",
  "driving-throttle-traction-loss",
  "driving-early-throttle",
  "driving-binary-throttle",
  "driving-brake-drag",
  "driving-downshift-over-rev",
  "driving-late-braking-overshoot",
  "driving-understeer-scrub",
  "driving-steering-sawing",
  "driving-throttle-micro-lifts",
  "driving-kerb-riding",
  "mech-fuel",
  "mech-peak-power",
  "mech-boost-anomaly",
];

/**
 * Detectors that describe rather than fault. `mech-peak-power` and `mech-fuel`
 * always fire on a healthy lap, and `driving-trail-brake` reports a *technique
 * statistic* whose severity is hardcoded to "info". Ranking any of them as a
 * weakness (or celebrating their absence as a strength) would be noise.
 */
const DESCRIPTIVE_IDS = new Set(["mech-peak-power", "mech-fuel", "driving-trail-brake"]);


// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

export type ProfileScopeKind = "car-track" | "global";

export interface ProfileScope {
  kind: ProfileScopeKind;
  gameId: GameId;
  carOrdinal: number | null;
  trackOrdinal: number | null;
}

/** Per-detector rollup, normalised per lap so pool size cancels out. */
export interface DetectorStat {
  id: string;
  category: InsightCategory;
  label: string;
  /** Laps in which the detector fired / laps analysed. 0–1. */
  perLapFrequency: number;
  /** Number of laps in which it fired. */
  lapsAffected: number;
  /** Mean SEVERITY_WEIGHT across the laps it fired in (1–3). */
  meanSeverityWeight: number;
  /** Worst severity seen. */
  peakSeverity: InsightSeverity;
  /**
   * Median `timeLossS` across the laps where the detector quantified one, or
   * null when it never did. Null means "not quantified", never "cost nothing" —
   * see shared/lib/time-loss.ts.
   */
  medianTimeLossS: number | null;
  /** Laps in which the detector fired *and* produced a time-loss estimate. */
  lapsQuantified: number;
  /** One representative `detail` string (from the lap with the lowest id, for determinism). */
  sampleDetail: string;
}

export interface RankedWeakness extends DetectorStat {
  /**
   * Ranking score. Quantified weaknesses:
   *   perLapFrequency × (meanSeverityWeight / 3) × medianTimeLossS   [seconds/lap]
   * Unquantified weaknesses:
   *   perLapFrequency × (meanSeverityWeight / 3)                     [dimensionless]
   * The two are NOT comparable, which is exactly why they are returned as two
   * separate lists rather than one merged ranking.
   */
  score: number;
  timeLossKnown: boolean;
}


/**
 * Driving-style axes.
 *
 * All but one of these are **continuous vehicle-physics measurements**, median-
 * aggregated across the lap pool by `shared/lib/driving-style.ts`. They are not
 * derived from detector counts.
 *
 * That is a deliberate change of basis. The previous axes were built from
 * `perLapFrequency × meanSeverityWeight / 3` over a list of detector ids, mapped
 * onto 0–100. The resulting scale had no absolute meaning: a driver with
 * warning-severity wheelspin on *every* lap scored ~28 for "aggression", because
 * 100 required every contributing detector firing at critical severity on every
 * lap. The number looked like a percentage and was in truth only comparable to
 * other numbers from the same function. Counting threshold crossings was also
 * only ever a proxy for the physical questions — how close to the tyres' limit
 * does this driver work, and how often does the car get away from them — which
 * `vehicle-physics.ts` can answer directly on a calibrated scale.
 *
 * Every field is `null` when it could not be measured (too few cornering frames
 * across the pool, or an unregistered game adapter for the steering fields).
 * Null is "not measurable", never "zero" — see `timeLossS` in lap-insights.ts.
 */
export interface StyleAxes {
  /**
   * Median four-wheel friction-circle utilisation over cornering frames.
   * Dimensionless but calibrated: **1.0 = at peak grip** (documented references
   * `SLIP_RATIO_PEAK` 0.12 and `SLIP_ANGLE_PEAK_RAD` 8°).
   *
   * 0.5 ≈ the car held at half its peak slip angle mid-corner; 0.9 ≈ working
   * close to the limit for most of the corner. A quick driver's median lands
   * around 0.6–0.85 — it spans entry and exit, so it sits structurally below the
   * peak. Median ≥ 1.0 is not commitment, it is scrubbing.
   *
   * This is the honest replacement for the old "aggression" axis.
   */
  gripUtilMedian: number | null;
  /**
   * 95th percentile of the same quantity — the frames where the driver actually
   * leans on the car. 1.0 = the limit is being touched; ~1.0–1.4 is committed
   * driving; below ~0.8 the car is never asked for everything it has.
   */
  gripUtilP95: number | null;
  /**
   * Median signed front−rear slip-angle delta, in **degrees**. Positive =
   * understeer-leaning, negative = oversteer-leaning. Kept in degrees rather
   * than mapped to an index: ±1–3° is a normal working range, past ±4° the bias
   * is pronounced. Replaces the old unitless `balanceBias`.
   */
  balanceMedianDeg: number | null;
  /** Fraction (0–1) of cornering frames classified understeer / oversteer. */
  understeerFraction: number | null;
  oversteerFraction: number | null;
  /**
   * Fraction (0–1) of cornering frames where the body is rotating faster than
   * the path demands *and* the rear carries more slip angle than the front.
   * 0–0.03 is normal (deliberate rotation on entry); past ~0.10 the driver is
   * catching the car rather than placing it.
   */
  controlLossFraction: number | null;
  /**
   * Steering direction reversals per second of cornering. Measures *variability*
   * of input, not magnitude — a fast chicane needs big quick inputs and that is
   * not roughness. ~0.5–2 /s is ordinary; past ~3 /s is sawing. Replaces the old
   * "smoothness" axis (note the polarity: lower is smoother).
   */
  steerReversalsPerS: number | null;
  /**
   * Median absolute deviation of the signed slip delta, in **degrees**. Blind to
   * how much slip the driver carries, sensitive only to how much it moves: a
   * steady 6° reads ~0, an oscillating 0–8° reads high. ~0.5–1.5° is ordinary;
   * past ~2.5° the car's attitude is not being held.
   */
  slipVariabilityDeg: number | null;
  /**
   * −100 (chronically early / over-slowing) … +100 (chronically late /
   * overshooting), 0 = neither pattern dominates.
   *
   * ⚠️ The one axis still built from detector intensities, and therefore the one
   * axis that is only *relatively* meaningful. Braking-point timing has no
   * continuous physical signal in the telemetry — it is a judgement about a
   * counterfactual braking point, which is exactly what the `driving-early-*` /
   * `driving-late-*` detectors already model. Being a *difference* of two poles
   * it at least has a meaningful zero and sign, which the old unipolar axes did
   * not. Read it as a lean, never as a percentage.
   *
   * Early: driving-early-braking, driving-over-slowing, driving-coasting.
   * Late:  driving-late-braking-overshoot, driving-brake-traction-loss,
   *        tire-lockup-*.
   */
  brakingStyle: number;
  /**
   * 0–100 repeatability from the recent normalized trend window.
   * Null when fewer than 2 comparable normalized laps exist.
   */
  consistency: number | null;
  /** Laps whose telemetry produced a usable physics summary (see MIN_CORNERING_FRAMES). */
  physicsLaps: number;
}

export type TrendDirection = "improving" | "steady" | "declining" | "unavailable";

export interface DriverTrendLap {
  id: number;
  createdAt: string;
  isValid: boolean;
  relativePacePct: number | null;
}

export interface DriverTrendWindow {
  laps: DriverTrendLap[];
  total: number;
  valid: number;
  dirty: number;
  cleanRate: number | null;
  normalized: number;
  consistency: number | null;
  medianPacePct: number | null;
  spreadPct: number | null;
  contexts: number;
}

export interface DriverTrendAdvice {
  id: "build-baseline" | "keep-approach" | "stabilize-pace" | "add-pace" | "reset-baseline" | "hold-steady" | "protect-validity";
  tone: "positive" | "neutral" | "caution";
  title: string;
  detail: string;
}

export interface DriverTrend {
  recent: DriverTrendWindow;
  previous: DriverTrendWindow;
  consistencyDelta: number | null;
  paceDeltaPct: number | null;
  spreadDeltaPct: number | null;
  cleanRateDelta: number | null;
  consistencyDirection: TrendDirection;
  paceDirection: TrendDirection;
  validityDirection: TrendDirection;
  advice: DriverTrendAdvice[];
}

export interface LapPoolReport {
  lapIds: number[];
  analyzed: number;
  candidates: number;
  droppedNoTelemetry: number;
}

export interface DriverFingerprint {
  ok: boolean;
  scope: ProfileScope;
  laps: LapPoolReport;
  confidence: Confidence;
  style: StyleAxes | null;
  trend: DriverTrend;
  weaknesses: RankedWeakness[];
  unquantifiedWeaknesses: RankedWeakness[];
  detectors: DetectorStat[];
  notes: string[];
}


// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Round to 4dp so float noise can't make two identical inputs compare unequal. */
function round4(v: number): number {
  return Math.round(v * 1e4) / 1e4;
}
function trendContextKey(lap: LapMeta): string {
  return `${lap.gameId ?? "?"}|${lap.carOrdinal ?? "?"}|${lap.trackOrdinal ?? "?"}`;
}

function direction(delta: number | null, improveAt: number, declineAt: number): TrendDirection {
  if (delta === null) return "unavailable";
  if (delta >= improveAt) return "improving";
  if (delta <= declineAt) return "declining";
  return "steady";
}

function trendWindow(laps: readonly LapMeta[], benchmarks: ReadonlyMap<string, number>): DriverTrendWindow {
  const chartLaps = [...laps].reverse().map((lap) => {
    const benchmark = benchmarks.get(trendContextKey(lap));
    const relativePacePct =
      benchmark !== undefined && Number.isFinite(lap.lapTime) && lap.lapTime > 0 ? Math.max(0, (lap.lapTime / benchmark - 1) * 100) : null;
    return { id: lap.id, createdAt: lap.createdAt, isValid: lap.isValid, relativePacePct };
  });
  const paceValues = chartLaps.flatMap((lap) => (lap.relativePacePct === null ? [] : [lap.relativePacePct]));
  const repeatability = repeatabilityStats(paceValues.map((pace) => 1 + pace / 100));
  const contextValues = laps.filter((lap) => benchmarks.has(trendContextKey(lap))).map(trendContextKey);
  return {
    laps: chartLaps,
    total: laps.length,
    valid: laps.filter((lap) => lap.isValid).length,
    dirty: laps.filter((lap) => !lap.isValid).length,
    cleanRate: laps.length === 0 ? null : laps.filter((lap) => lap.isValid).length / laps.length,
    normalized: repeatability.n,
    consistency: repeatability.consistency === null ? null : round4(repeatability.consistency),
    medianPacePct: median(paceValues.map((pace) => round4(pace))),
    spreadPct: repeatability.sd === null ? null : round4(repeatability.sd * 100),
    contexts: new Set(contextValues).size,
  };
}

function adviceFor(recent: DriverTrendWindow, previous: DriverTrendWindow, paceDirection: TrendDirection, consistencyDirection: TrendDirection): DriverTrendAdvice[] {
  const missingMetric =
    recent.normalized < 2 ||
    previous.normalized < 2 ||
    recent.consistency === null ||
    previous.consistency === null ||
    recent.medianPacePct === null ||
    previous.medianPacePct === null;
  let primary: DriverTrendAdvice;
  if (missingMetric) {
    primary = { id: "build-baseline", tone: "neutral", title: "Keep building the baseline", detail: "A trend needs both recent and previous windows to contain comparable pace data." };
  } else if (paceDirection === "improving" && consistencyDirection === "improving") {
    primary = { id: "keep-approach", tone: "positive", title: "Your improvement looks repeatable", detail: "Pace and consistency moved together. Keep the approach stable instead of chasing a larger change." };
  } else if (paceDirection === "improving" && consistencyDirection === "declining") {
    primary = { id: "stabilize-pace", tone: "caution", title: "Consolidate the new speed", detail: "Pace improved while repeatability fell. Hold the current pace until consistency returns." };
  } else if (consistencyDirection === "improving" && (paceDirection === "steady" || paceDirection === "declining")) {
    primary = { id: "add-pace", tone: "positive", title: "Use the stable base to add pace", detail: "Your laps are becoming more repeatable. Preserve that rhythm and add speed gradually." };
  } else if (consistencyDirection === "declining" && paceDirection !== "improving") {
    primary = { id: "reset-baseline", tone: "caution", title: "Reset to a repeatable baseline", detail: "Pace and repeatability are not moving together. Reduce variation before pushing again." };
  } else {
    primary = { id: "hold-steady", tone: "neutral", title: "Performance is stable", detail: "Neither pace nor consistency moved enough to call a trend. Change one thing at a time and keep building evidence." };
  }
  const advice = [primary];
  if (recent.cleanRate !== null && previous.cleanRate !== null && recent.cleanRate - previous.cleanRate <= -0.05) {
    advice.push({ id: "protect-validity", tone: "caution", title: "Protect validity before pushing harder", detail: "Dirty-lap rate worsened. Keep the current pace inside the valid-lap envelope before adding more risk." });
  }
  return advice;
}

export function buildDriverTrend(candidatesNewestFirst: readonly LapMeta[]): DriverTrend {
  const benchmarks = new Map<string, number>();
  for (const lap of candidatesNewestFirst) {
    if (!lap.isValid || !Number.isFinite(lap.lapTime) || lap.lapTime <= 0) continue;
    const key = trendContextKey(lap);
    const current = benchmarks.get(key);
    if (current === undefined || lap.lapTime < current) benchmarks.set(key, lap.lapTime);
  }
  const recent = trendWindow(candidatesNewestFirst.slice(0, DRIVER_TREND_WINDOW_LAPS), benchmarks);
  const previous = trendWindow(candidatesNewestFirst.slice(DRIVER_TREND_WINDOW_LAPS, DRIVER_TREND_WINDOW_LAPS * 2), benchmarks);
  const consistencyDelta = recent.consistency !== null && previous.consistency !== null ? round4(recent.consistency - previous.consistency) : null;
  const paceDeltaPct = recent.medianPacePct !== null && previous.medianPacePct !== null ? round4(recent.medianPacePct - previous.medianPacePct) : null;
  const spreadDeltaPct = recent.spreadPct !== null && previous.spreadPct !== null ? round4(recent.spreadPct - previous.spreadPct) : null;
  const cleanRateDelta = recent.cleanRate !== null && previous.cleanRate !== null ? round4(recent.cleanRate - previous.cleanRate) : null;
  const consistencyDirection = direction(consistencyDelta, 2, -2);
  const paceDirection: TrendDirection = paceDeltaPct === null ? "unavailable" : paceDeltaPct <= -0.25 ? "improving" : paceDeltaPct >= 0.25 ? "declining" : "steady";
  const validityDirection = direction(cleanRateDelta, 0.05, -0.05);
  return {
    recent,
    previous,
    consistencyDelta,
    paceDeltaPct,
    spreadDeltaPct,
    cleanRateDelta,
    consistencyDirection,
    paceDirection,
    validityDirection,
    advice: adviceFor(recent, previous, paceDirection, consistencyDirection),
  };
}

function severityRank(s: InsightSeverity): number {
  return SEVERITY_WEIGHT[s];
}

// Detector rollup
// ---------------------------------------------------------------------------

/**
 * Roll per-lap insight lists into one per-detector table.
 *
 * All counting is PER LAP: a detector that fires on every lap scores the same
 * for a 5-lap pool as a 50-lap pool. Raw totals would make an experienced
 * driver's long history look like a worse driver's short one.
 *
 * `lapIds` is only used to pick `sampleDetail` deterministically (lowest lap id
 * that reported the detector); pass ids parallel to `perLapInsights`.
 */
export function rollUpDetectors(perLapInsights: LapInsight[][], lapIds: number[]): DetectorStat[] {
  const lapCount = perLapInsights.length;
  if (lapCount === 0) return [];

  interface Acc {
    category: InsightCategory;
    label: string;
    lapsAffected: number;
    severitySum: number;
    peakSeverity: InsightSeverity;
    losses: number[];
    sampleDetail: string;
    sampleLapId: number;
  }
  const acc = new Map<string, Acc>();

  for (let i = 0; i < lapCount; i++) {
    const lapId = lapIds[i] ?? i;
    // A detector emits at most one insight per lap today; guard anyway so a
    // future multi-emit detector can't inflate lapsAffected past lapCount.
    const seen = new Set<string>();
    for (const ins of perLapInsights[i]) {
      if (seen.has(ins.id)) continue;
      seen.add(ins.id);

      let a = acc.get(ins.id);
      if (!a) {
        a = {
          category: ins.category,
          label: ins.label,
          lapsAffected: 0,
          severitySum: 0,
          peakSeverity: ins.severity,
          losses: [],
          sampleDetail: ins.detail,
          sampleLapId: lapId,
        };
        acc.set(ins.id, a);
      }
      a.lapsAffected++;
      a.severitySum += severityRank(ins.severity);
      if (severityRank(ins.severity) > severityRank(a.peakSeverity)) a.peakSeverity = ins.severity;
      // timeLossS absent === "not quantified". It is NOT pushed as 0; a zero
      // would drag the median down and quietly claim the fault was free.
      if (ins.timeLossS !== undefined) a.losses.push(ins.timeLossS);
      if (lapId < a.sampleLapId) {
        a.sampleLapId = lapId;
        a.sampleDetail = ins.detail;
      }
    }
  }

  const stats: DetectorStat[] = [];
  for (const [id, a] of acc) {
    const m = median(a.losses);
    stats.push({
      id,
      category: a.category,
      label: a.label,
      perLapFrequency: round4(a.lapsAffected / lapCount),
      lapsAffected: a.lapsAffected,
      meanSeverityWeight: round4(a.severitySum / a.lapsAffected),
      peakSeverity: a.peakSeverity,
      medianTimeLossS: m === null ? null : round4(m),
      lapsQuantified: a.losses.length,
      sampleDetail: a.sampleDetail,
    });
  }
  stats.sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  return stats;
}

/** Per-detector intensity in 0–1: how often it fires, scaled by how bad it is when it does. */
function intensity(stat: DetectorStat | undefined): number {
  if (!stat) return 0;
  return stat.perLapFrequency * (stat.meanSeverityWeight / MAX_SEVERITY_WEIGHT);
}

function meanIntensity(byId: Map<string, DetectorStat>, ids: readonly string[]): number {
  if (ids.length === 0) return 0;
  let sum = 0;
  for (const id of ids) sum += intensity(byId.get(id));
  return sum / ids.length;
}

const BRAKING_EARLY_IDS = ["driving-early-braking", "driving-over-slowing", "driving-coasting"] as const;
const BRAKING_LATE_IDS = ["driving-late-braking-overshoot", "driving-brake-traction-loss", ...perWheel("tire-lockup-")] as const;

/**
 * Build the style axes.
 *
 * The physics axes are lifted straight out of `aggregateLapStyles` — no rescaling,
 * no gain, no mapping onto 0–100. A grip utilisation of 0.83 is reported as 0.83
 * because 1.0 already means something (peak grip); a balance of −2.1° is reported
 * as −2.1° because degrees are what the driver's car actually did. Anything the
 * pool could not measure comes back null rather than as a manufactured zero.
 *
 * `brakingStyle` is the sole survivor of the detector-intensity basis and is
 * still linear and ungained: the difference of the two poles' mean intensities,
 * ±100 per side, always traceable back to "these detectors fired this often,
 * this badly". See its doc comment for why it has no continuous equivalent.
 */
export function computeStyleAxes(detectors: DetectorStat[], paceConsistency: number | null, styleSummaries: readonly LapStyleSummary[] = []): StyleAxes {
  const byId = new Map(detectors.map((d) => [d.id, d]));
  const scale = (v: number): number => round4(clamp(v * 100, -100, 100));

  const early = meanIntensity(byId, BRAKING_EARLY_IDS);
  const late = meanIntensity(byId, BRAKING_LATE_IDS);

  const agg = aggregateLapStyles(styleSummaries);
  const orNull = (v: number | undefined): number | null => (v === undefined ? null : v);

  return {
    gripUtilMedian: orNull(agg.gripUtilMedian),
    gripUtilP95: orNull(agg.gripUtilP95),
    balanceMedianDeg: orNull(agg.balanceMedianDeg),
    understeerFraction: orNull(agg.understeerFraction),
    oversteerFraction: orNull(agg.oversteerFraction),
    controlLossFraction: orNull(agg.controlLossFraction),
    steerReversalsPerS: orNull(agg.steerReversalsPerS),
    slipVariabilityDeg: orNull(agg.slipVariabilityDeg),
    brakingStyle: scale(late - early),
    consistency: paceConsistency === null ? null : round4(paceConsistency),
    physicsLaps: agg.lapsUsable,
  };
}

// ---------------------------------------------------------------------------
// Weakness / strength ranking
// ---------------------------------------------------------------------------

/**
 * Rank detectors as weaknesses.
 *
 * Two lists, not one. A merged ranking would need a time-loss number for every
 * detector, and there are only two ways to invent one: treat "not quantified"
 * as zero (which buries e.g. counter-steering below a 0.05 s coast) or guess a
 * value (which fabricates evidence the coach then narrates as fact). Splitting
 * the lists keeps both the seconds-ranking and the frequency-ranking honest and
 * lets the prompt say "costs 0.4 s/lap" only where that is true.
 *
 * Ties break on id so the output is stable.
 */
export function rankWeaknesses(detectors: DetectorStat[]): { weaknesses: RankedWeakness[]; unquantifiedWeaknesses: RankedWeakness[] } {
  const weaknesses: RankedWeakness[] = [];
  const unquantifiedWeaknesses: RankedWeakness[] = [];

  for (const d of detectors) {
    if (DESCRIPTIVE_IDS.has(d.id)) continue;
    const base = d.perLapFrequency * (d.meanSeverityWeight / MAX_SEVERITY_WEIGHT);
    if (d.medianTimeLossS !== null) {
      weaknesses.push({ ...d, score: round4(base * d.medianTimeLossS), timeLossKnown: true });
    } else {
      unquantifiedWeaknesses.push({ ...d, score: round4(base), timeLossKnown: false });
    }
  }

  const bySeverityThenId = (a: RankedWeakness, b: RankedWeakness): number => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  weaknesses.sort(bySeverityThenId);
  unquantifiedWeaknesses.sort(bySeverityThenId);
  return { weaknesses, unquantifiedWeaknesses };
}



// ---------------------------------------------------------------------------
// Fingerprint assembly
// ---------------------------------------------------------------------------

function confidenceFor(lapCount: number): Confidence {
  if (lapCount >= 10) return "high";
  if (lapCount >= 5) return "medium";
  if (lapCount >= MIN_LAPS_FOR_STYLE) return "low";
  return "very-low";
}

export function emptyFingerprint(scope: ProfileScope, laps: Partial<LapPoolReport> = {}, notes: string[] = [], trend: DriverTrend = buildDriverTrend([])): DriverFingerprint {
  return {
    ok: trend.recent.total > 0,
    scope,
    laps: { lapIds: [], analyzed: 0, candidates: 0, droppedNoTelemetry: 0, ...laps },
    confidence: "very-low",
    style: null,
    trend,
    weaknesses: [],
    unquantifiedWeaknesses: [],
    detectors: [],
    notes,
  };
}

/**
 * The pure core: laps + their insights in, fingerprint out. No DB, no clock.
 * `laps[i]` must correspond to `perLapInsights[i]`.
 */
export function buildDriverFingerprint(input: {
  scope: ProfileScope;
  laps: LapMeta[];
  perLapInsights: LapInsight[][];
  perLapStyle?: (LapStyleSummary | undefined)[];
  trend?: DriverTrend;
  pool?: Partial<LapPoolReport>;
  notes?: string[];
}): DriverFingerprint {
  const { scope } = input;
  const notes = [...(input.notes ?? [])];
  const trend = input.trend ?? buildDriverTrend(input.laps);
  const paired = input.laps
    .map((lap, i) => ({ lap, insights: input.perLapInsights[i] ?? [], style: input.perLapStyle?.[i] }))
    .sort((a, b) => a.lap.id - b.lap.id);
  const laps = paired.map((p) => p.lap);
  const perLapInsights = paired.map((p) => p.insights);
  const styleSummaries = paired.map((p) => p.style).filter((s): s is LapStyleSummary => s !== undefined);
  const lapCount = laps.length;
  const lapIds = laps.map((lap) => lap.id);
  const detectors = rollUpDetectors(perLapInsights, lapIds);
  const { weaknesses, unquantifiedWeaknesses } = rankWeaknesses(detectors);

  let style: StyleAxes | null = null;
  if (lapCount >= MIN_LAPS_FOR_STYLE) {
    style = computeStyleAxes(detectors, trend.recent.consistency, styleSummaries);
    if (style.physicsLaps > 0 && style.physicsLaps < MIN_LAPS_FOR_STYLE) {
      notes.push(`Only ${style.physicsLaps} lap${style.physicsLaps === 1 ? "" : "s"} had enough cornering to measure driving style from vehicle physics.`);
    } else if (style.physicsLaps === 0) {
      notes.push("No lap had enough cornering telemetry to measure driving style from vehicle physics.");
    }
  } else if (lapCount > 0) {
    notes.push(`Only ${lapCount} lap${lapCount === 1 ? "" : "s"} available — too few to characterise a driving style (need ${MIN_LAPS_FOR_STYLE}).`);
  }

  const pool = input.pool ?? {};
  if (pool.droppedNoTelemetry) notes.push(`${pool.droppedNoTelemetry} lap${pool.droppedNoTelemetry === 1 ? "" : "s"} had no usable telemetry.`);
  return {
    ok: trend.recent.total > 0,
    scope,
    laps: { lapIds, analyzed: lapCount, candidates: pool.candidates ?? trend.recent.total, droppedNoTelemetry: pool.droppedNoTelemetry ?? 0 },
    confidence: confidenceFor(lapCount),
    style,
    trend,
    weaknesses,
    unquantifiedWeaknesses,
    detectors,
    notes: lapCount === 0 ? [...notes, "No usable laps for this scope."] : notes,
  };
}


// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Load and reduce all of the driver's laps for one selected game to a
 * global fingerprint.
 */
export async function loadDriverProfile(opts: { gameId: GameId }): Promise<DriverFingerprint> {
  const scope: ProfileScope = { kind: "global", gameId: opts.gameId, carOrdinal: null, trackOrdinal: null };
  const pool = await getLapMetaForProfileScope(opts.gameId);
  const trend = buildDriverTrend(pool);
  if (pool.length === 0) return emptyFingerprint(scope, { candidates: 0 }, ["No laps recorded for this scope."], trend);

  const selected = pool.slice(0, DRIVER_TREND_WINDOW_LAPS);
  const loaded = await getLapsByIds(selected.map((lap) => lap.id));
  const metaById = new Map(selected.map((lap) => [lap.id, lap]));
  const laps: LapMeta[] = [];
  const perLapInsights: LapInsight[][] = [];
  const perLapStyle: LapStyleSummary[] = [];
  let droppedNoTelemetry = selected.length - loaded.length;

  for (const lap of loaded) {
    const meta = metaById.get(lap.id);
    if (!meta || lap.parseError || lap.telemetry.length < MIN_TELEMETRY_FRAMES) {
      droppedNoTelemetry++;
      continue;
    }
    const lapGame = meta.gameId ?? opts.gameId;
    laps.push(meta);
    perLapInsights.push(analyzeLap(lap.telemetry, lapGame));
    perLapStyle.push(summariseLapStyle(lap.telemetry, lapGame));
  }

  return buildDriverFingerprint({
    scope,
    laps,
    perLapInsights,
    perLapStyle,
    trend,
    pool: { candidates: pool.length, droppedNoTelemetry },
  });
}
