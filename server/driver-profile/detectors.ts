import { aggregateLapStyles, type LapStyleSummary } from "../../shared/lib/driving-style";
import { clamp } from "../../shared/stint-trace";
import type { InsightCategory, InsightSeverity, LapInsight } from "../../shared/lib/lap-insights";
import { median, round4 } from "./math";
/** Per-detector rollup, normalised per lap so pool size cancels out. */
export interface DetectorStat {
  id: string;
  category: InsightCategory;
  label: string;
  /** Laps in which detector fired / laps analysed. 0–1. */
  perLapFrequency: number;
  lapsAffected: number;
  /** Mean severity weight across affected laps (1–3). */
  meanSeverityWeight: number;
  peakSeverity: InsightSeverity;
  /** Median quantified loss, or null when detector never quantified one. */
  medianTimeLossS: number | null;
  lapsQuantified: number;
  /** Detail from lowest lap id that reported detector. */
  sampleDetail: string;
}

export interface RankedWeakness extends DetectorStat {
  score: number;
  timeLossKnown: boolean;
}

/** Calibrated vehicle-physics measurements plus detector-derived braking style. */
export interface StyleAxes {
  /** Four-wheel friction-circle utilisation; 1.0 means peak grip. */
  gripUtilMedian: number | null;
  gripUtilP95: number | null;
  /** Signed front−rear slip-angle delta in degrees; positive means understeer. */
  balanceMedianDeg: number | null;
  understeerFraction: number | null;
  oversteerFraction: number | null;
  controlLossFraction: number | null;
  steerReversalsPerS: number | null;
  slipVariabilityDeg: number | null;
  /** −100 early/over-slowing … +100 late/overshooting. */
  brakingStyle: number;
  /** 0–100 repeatability from recent normalized trend window. */
  consistency: number | null;
  /** Laps whose telemetry produced a usable physics summary. */
  physicsLaps: number;
}

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

/** Minimum usable laps for style axis output, and style-dependent confidence floor. */
export const MIN_LAPS_FOR_STYLE = 3;

// ---------------------------------------------------------------------------
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
export function rollUpDetectors(perLapInsights: readonly (readonly LapInsight[])[], lapIds: readonly number[]): DetectorStat[] {
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
const BRAKING_LATE_IDS = [
  "driving-late-braking-overshoot",
  "driving-brake-traction-loss",
  ...perWheel("tire-lockup-"),
] as const;

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
export function computeStyleAxes(
  detectors: readonly DetectorStat[],
  paceConsistency: number | null,
  styleSummaries: readonly LapStyleSummary[] = [],
): StyleAxes {
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
 * Ties break on id so output is stable.
 */
export function rankWeaknesses(detectors: readonly DetectorStat[]): {
  weaknesses: RankedWeakness[];
  unquantifiedWeaknesses: RankedWeakness[];
} {
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

const SEVERITY_WEIGHT: Record<InsightSeverity, number> = { info: 1, warning: 2, critical: 3 };
const MAX_SEVERITY_WEIGHT = 3;

function severityRank(s: InsightSeverity): number {
  return SEVERITY_WEIGHT[s];
}
