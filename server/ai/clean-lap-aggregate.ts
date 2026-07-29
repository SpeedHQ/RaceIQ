/**
 * clean-lap-aggregate — Phase 1 of the RaceIQ Setup Engineer flow: reduce a
 * tuning session (or a single branch/test) to a single, statistically clean
 * evidence bundle instead of the naive "fastest lap" read.
 *
 * A driver's fastest lap on a given setup is frequently a compromise (one
 * great sector, one messy one) or an outright fluke. This module:
 *   1. Filters the session/branch's laps down to a "clean" candidate pool
 *      (valid, not user-excluded, not a statistical blunder), keeping a full
 *      breakdown of why each lap was kept or dropped.
 *   2. Reduces the clean pool's lap times to a consistency read (spread,
 *      stddev, confidence band) so downstream chat can say "3 clean laps,
 *      high confidence" instead of silently trusting one lap.
 *   3. Aggregates each clean lap's deterministic symptom report
 *      (tune-symptoms.ts) into one majority/median symptom report, so a
 *      single noisy lap can't dominate the tune-intent LLM's evidence.
 *
 * Falls back to the existing single-representative-lap path
 * (loadRepresentativeLap) when the pool has fewer than two clean laps —
 * Phase 1 only strengthens the multi-lap case, it never regresses the
 * single-lap one.
 */
import type { LapMeta } from "../../shared/types";
import type { TelemetryPacket } from "../../shared/types";
import type { Corner } from "../corner-detection";
import { detectCorners } from "../corner-detection";
import { getLapById, getLapsForExperiment, getLapMetaForExperimentVersion, getCorners } from "../db/queries";
import { resolveActiveTestId } from "../db/experiment-version-queries";
import { telemetryToSymptoms, type TuneSymptoms, type TyreDeltas } from "./tune-symptoms";
import { telemetryToTrackConditions, type TrackConditions } from "./track-conditions";
import { loadRepresentativeLap } from "./setup-engineer-context";
import { computeLapConsistencyDelta, computeLineSpreadTrace, type CornerConsistency, type LineSpreadTrace } from "../lap-consistency";
import { stddevPopulation } from "../lap-stats";

/** Overall confidence in the clean-lap pool backing an aggregate. */
export type Confidence = "high" | "medium" | "low" | "very-low";

export interface ConsistencyReport {
  confidence: Confidence;
  cleanLapCount: number;
  bestLapSec: number | null;
  spreadSec: number | null;
  stdDevSec: number | null;
  spreadPct: number | null;
  droppedOutliers: number;
  /** Per-corner racing-line/input consistency across the clean laps; null when
   *  fewer than 2 clean laps (computeLapConsistencyDelta needs at least 2). */
  cornerConsistency: CornerConsistency[] | null;
  /** Trimmed (p90-p10) per-bin racing-line spread trace; null when fewer than
   *  3 clean laps (computeLineSpreadTrace needs a meaningful percentile trim). */
  lineSpread: LineSpreadTrace | null;
}

export interface LapBreakdownRow {
  lapId: number;
  lapTimeSec: number;
  valid: boolean;
  reason: "clean" | "invalid" | "user-excluded" | "auto-outlier";
  imported: boolean;
}

export interface CleanLapAggregate {
  ok: boolean;
  lapIds: number[];
  symptoms: TuneSymptoms | null;
  trackConditions: TrackConditions | null;
  consistency: ConsistencyReport;
  fallbackSingleLap: boolean;
  sourceScope: "branch" | "session-baseline";
  /** Laps stamped to the active head test (any cleanliness), or null when no
   *  active head test exists. 0 + "session-baseline" means the current setup
   *  version has never been driven and the pool below belongs to earlier
   *  versions. */
  headOwnLapCount: number | null;
  lapBreakdown: LapBreakdownRow[];
}

/**
 * Explicit-fallback note for AI/context consumers: non-null only when we fell
 * back to the session baseline pool while an active head test exists with zero
 * laps of its own — i.e. the laps shown are NOT this setup version's laps.
 */
export function baselineFallbackNote(
  agg: Pick<CleanLapAggregate, "sourceScope" | "headOwnLapCount">,
): string | null {
  if (agg.sourceScope !== "session-baseline" || agg.headOwnLapCount !== 0) return null;
  return (
    "NOTE: no laps recorded on this setup version yet — laps below are the session baseline " +
    "(earlier versions). Drive laps on this version before judging changes."
  );
}

// Cap on how many clean laps feed the symptom aggregate — beyond this the
// marginal value per lap is low and the per-lap telemetry fetch cost isn't
// worth it.
const MAX_CLEAN_LAPS = 8;
// Minimum telemetry frames for a lap to be analysable (matches
// loadRepresentativeLap's gate).
const MIN_TELEMETRY_FRAMES = 30;

/** Linear-interpolation percentile of an unsorted array; 0 when empty. */
function percentile(sortedAsc: number[], p: number): number {
  const n = sortedAsc.length;
  if (n === 0) return 0;
  const idx = (n - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (idx - lo);
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Split a session/branch's laps into a clean candidate pool and the dropped
 * ones, with a full per-lap breakdown of why. Pure — no DB.
 *
 * Candidacy: isValid && lapTime > 0. Among candidates, user-excluded laps are
 * dropped, then a blunder rule (median + 1.5*IQR, floored at best*1.02) drops
 * statistical outliers. Everything else survives as "clean".
 *
 * `applyUserExclusions: false` keeps `experimentExcluded` laps in the pool. That
 * exists for the driver profile (driver-profile-aggregate.ts): a lap the user
 * excluded from a *tuning* comparison is still a lap the driver drove, and
 * dropping it would bias the driving fingerprint towards the laps that happened
 * to flatter a setup. Defaults to true, so every tuning caller is unchanged.
 */
export function selectCleanLaps(
  laps: LapMeta[],
  opts?: { applyUserExclusions?: boolean },
): {
  clean: LapMeta[];
  dropped: LapMeta[];
  breakdown: LapBreakdownRow[];
} {
  const applyUserExclusions = opts?.applyUserExclusions ?? true;
  const candidates: LapMeta[] = [];
  const breakdown: LapBreakdownRow[] = [];

  for (const lap of laps) {
    const imported = lap.experimentVersionId == null;
    if (!(lap.isValid === true && lap.lapTime > 0)) {
      breakdown.push({ lapId: lap.id, lapTimeSec: lap.lapTime, valid: lap.isValid, reason: "invalid", imported });
      continue;
    }
    candidates.push(lap);
  }

  const notExcluded: LapMeta[] = [];
  for (const lap of candidates) {
    const imported = lap.experimentVersionId == null;
    if (applyUserExclusions && lap.experimentExcluded === true) {
      breakdown.push({ lapId: lap.id, lapTimeSec: lap.lapTime, valid: lap.isValid, reason: "user-excluded", imported });
      continue;
    }
    notExcluded.push(lap);
  }

  // Blunder rule over the surviving candidates' lap times.
  const times = notExcluded.map((l) => l.lapTime).sort((a, b) => a - b);
  const best = times.length > 0 ? times[0] : 0;
  const q1 = percentile(times, 0.25);
  const q3 = percentile(times, 0.75);
  const iqr = q3 - q1;
  const blunderCeiling = Math.max(median(times) ?? best, best) + 1.5 * iqr;
  const threshold = Math.max(blunderCeiling, best * 1.02);

  const clean: LapMeta[] = [];
  const dropped: LapMeta[] = [];
  for (const lap of notExcluded) {
    const imported = lap.experimentVersionId == null;
    if (times.length > 1 && lap.lapTime > threshold) {
      breakdown.push({ lapId: lap.id, lapTimeSec: lap.lapTime, valid: lap.isValid, reason: "auto-outlier", imported });
      dropped.push(lap);
      continue;
    }
    breakdown.push({ lapId: lap.id, lapTimeSec: lap.lapTime, valid: lap.isValid, reason: "clean", imported });
    clean.push(lap);
  }

  return { clean, dropped, breakdown };
}

/**
 * Reduce a clean lap-time pool to a consistency report — spread/stddev plus
 * a coarse confidence band on raw lap-time repeatability (not track-scaled;
 * that's what `consistencyRating` in lap-stats.ts is for elsewhere).
 */
export function computeConsistency(
  cleanLaps: LapMeta[],
  cornerConsistency: CornerConsistency[] | null,
  droppedOutliers: number,
  lineSpread: LineSpreadTrace | null = null,
): ConsistencyReport {
  const times = cleanLaps.map((l) => l.lapTime);
  const cleanLapCount = times.length;
  const bestLapSec = cleanLapCount > 0 ? Math.min(...times) : null;
  const spreadSec = cleanLapCount > 0 ? Math.max(...times) - (bestLapSec ?? 0) : null;
  const stdDevSec = cleanLapCount > 0 ? stddevPopulation(times) : null;
  const spreadPct = bestLapSec != null && bestLapSec > 0 && spreadSec != null ? spreadSec / bestLapSec : null;

  let confidence: Confidence;
  if (cleanLapCount < 2) {
    confidence = "very-low";
  } else if (cleanLapCount >= 3 && spreadPct != null && spreadPct < 0.01) {
    confidence = "high";
  } else if (cleanLapCount >= 2 && spreadPct != null && spreadPct < 0.02) {
    confidence = "medium";
  } else {
    confidence = "low";
  }

  return {
    confidence,
    cleanLapCount,
    bestLapSec,
    spreadSec,
    stdDevSec,
    spreadPct,
    droppedOutliers,
    cornerConsistency,
    lineSpread,
  };
}

function majorityBalance(perLap: TuneSymptoms[]): TuneSymptoms["aggregate"]["balance"] {
  let understeer = 0;
  let oversteer = 0;
  let neutral = 0;
  for (const s of perLap) {
    if (s.aggregate.balance === "understeer") understeer++;
    else if (s.aggregate.balance === "oversteer") oversteer++;
    else neutral++;
  }
  if (understeer > oversteer && understeer > neutral) return "understeer";
  if (oversteer > understeer && oversteer > neutral) return "oversteer";
  return "neutral";
}

/** Corner labels appearing in >= half (ceil) of the laps' given list field. */
function majorityCorners(perLap: TuneSymptoms[], field: "understeerCorners" | "oversteerCorners" | "lockupCorners" | "bottomingCorners"): string[] {
  const counts = new Map<string, number>();
  for (const s of perLap) {
    for (const label of s.aggregate[field]) {
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
  }
  const threshold = Math.ceil(perLap.length / 2);
  return [...counts.entries()].filter(([, n]) => n >= threshold).map(([label]) => label);
}

function medianTyrePressure(perLap: TuneSymptoms[]): TyreDeltas | null {
  const reporting = perLap.map((s) => s.aggregate.tyrePressure).filter((t): t is TyreDeltas => t != null);
  if (reporting.length === 0) return null;
  return {
    FL: median(reporting.map((t) => t.FL)) ?? 0,
    FR: median(reporting.map((t) => t.FR)) ?? 0,
    RL: median(reporting.map((t) => t.RL)) ?? 0,
    RR: median(reporting.map((t) => t.RR)) ?? 0,
  };
}

/**
 * Aggregate each clean lap's deterministic symptom report into one report.
 * Corner-name lists use a majority vote (>= half the laps); the flat
 * tyrePressure leaf is median'd per field. The deeper structured leaves
 * (tyreTemp/damper/weightTransfer) are pragmatically taken from the fastest
 * lap that reports them, rather than deep-medianed field-by-field — those
 * shapes nest per-corner objects with mixed derived-classification fields
 * (e.g. camberBias) that don't have a meaningful median.
 */
export function aggregateSymptoms(perLap: TuneSymptoms[]): TuneSymptoms {
  const fastest = perLap[0]!;

  const tyreTemp = perLap.find((s) => s.aggregate.tyreTemp != null)?.aggregate.tyreTemp ?? null;
  const damper = perLap.find((s) => s.aggregate.damper != null)?.aggregate.damper ?? null;
  const weightTransfer = perLap.find((s) => s.aggregate.weightTransfer != null)?.aggregate.weightTransfer ?? null;

  return {
    corners: fastest.corners,
    aggregate: {
      balance: majorityBalance(perLap),
      understeerCorners: majorityCorners(perLap, "understeerCorners"),
      oversteerCorners: majorityCorners(perLap, "oversteerCorners"),
      lockupCorners: majorityCorners(perLap, "lockupCorners"),
      bottomingCorners: majorityCorners(perLap, "bottomingCorners"),
      tyrePressure: medianTyrePressure(perLap),
      tyreTemp,
      damper,
      weightTransfer,
    },
  };
}

function emptyConsistency(confidence: Confidence): ConsistencyReport {
  return {
    confidence,
    cleanLapCount: 0,
    bestLapSec: null,
    spreadSec: null,
    stdDevSec: null,
    spreadPct: null,
    droppedOutliers: 0,
    cornerConsistency: null,
    lineSpread: null,
  };
}

/**
 * Load and reduce a tuning session (or one of its branch tests) to a clean-lap
 * evidence bundle. Prefers the branch pool (the current setup's own laps) when
 * it has >= 2 stamped clean candidates; otherwise falls back to the full
 * session baseline pool. Falls back further to the single-representative-lap
 * path when even the baseline pool has fewer than 2 clean laps.
 */
export async function loadCleanLapAggregate(
  sessionId: number,
  opts?: { versionId?: number },
): Promise<CleanLapAggregate> {
  const headVersionId = opts?.versionId ?? (await resolveActiveTestId(sessionId));

  let pool: LapMeta[] = [];
  let sourceScope: "branch" | "session-baseline" = "session-baseline";

  let headOwnLapCount: number | null = null;
  if (headVersionId != null) {
    const branchPool = await getLapMetaForExperimentVersion(headVersionId);
    headOwnLapCount = branchPool.length;
    const branchClean = selectCleanLaps(branchPool);
    if (branchClean.clean.length >= 2) {
      pool = branchPool;
      sourceScope = "branch";
    }
  }

  if (sourceScope === "session-baseline") {
    pool = await getLapsForExperiment(sessionId);
  }

  const { clean, breakdown } = selectCleanLaps(pool);
  const droppedOutliers = breakdown.filter((r) => r.reason === "auto-outlier").length;

  if (clean.length < 2) {
    const lap = await loadRepresentativeLap(sessionId);
    if (!lap) {
      return {
        ok: false,
        lapIds: [],
        symptoms: null,
        trackConditions: null,
        consistency: emptyConsistency("very-low"),
        fallbackSingleLap: true,
        sourceScope,
        headOwnLapCount,
        lapBreakdown: breakdown,
      };
    }
    const corners = detectCorners(lap.telemetry);
    return {
      ok: true,
      lapIds: [lap.id],
      symptoms: telemetryToSymptoms(lap.telemetry, corners),
      trackConditions: telemetryToTrackConditions(lap.telemetry),
      consistency: emptyConsistency("very-low"),
      fallbackSingleLap: true,
      sourceScope,
      headOwnLapCount,
      lapBreakdown: breakdown,
    };
  }

  // Fastest-first, capped.
  const cleanSorted = [...clean].sort((a, b) => a.lapTime - b.lapTime).slice(0, MAX_CLEAN_LAPS);
  const fastestMeta = cleanSorted[0]!;

  const loadedLaps: { meta: LapMeta; telemetry: TelemetryPacket[] }[] = [];
  for (const meta of cleanSorted) {
    const lap = await getLapById(meta.id);
    if (!lap || lap.telemetry.length < MIN_TELEMETRY_FRAMES) continue;
    loadedLaps.push({ meta, telemetry: lap.telemetry });
  }

  if (loadedLaps.length < 2) {
    // Telemetry too thin to analyse as a pool — fall back to the single
    // representative lap rather than aggregating over <2 laps.
    const lap = await loadRepresentativeLap(sessionId);
    if (!lap) {
      return {
        ok: false,
        lapIds: [],
        symptoms: null,
        trackConditions: null,
        consistency: emptyConsistency("very-low"),
        fallbackSingleLap: true,
        sourceScope,
        headOwnLapCount,
        lapBreakdown: breakdown,
      };
    }
    const corners = detectCorners(lap.telemetry);
    return {
      ok: true,
      lapIds: [lap.id],
      symptoms: telemetryToSymptoms(lap.telemetry, corners),
      trackConditions: telemetryToTrackConditions(lap.telemetry),
      consistency: emptyConsistency("very-low"),
      fallbackSingleLap: true,
      sourceScope,
      headOwnLapCount,
      lapBreakdown: breakdown,
    };
  }

  const fastestLoaded = loadedLaps.find((l) => l.meta.id === fastestMeta.id) ?? loadedLaps[0]!;

  let corners: Corner[];
  if (fastestLoaded.meta.trackOrdinal != null && fastestLoaded.meta.gameId != null) {
    corners = await getCorners(fastestLoaded.meta.trackOrdinal, fastestLoaded.meta.gameId);
    if (corners.length === 0) corners = detectCorners(fastestLoaded.telemetry);
  } else {
    corners = detectCorners(fastestLoaded.telemetry);
  }

  const perLapSymptoms = loadedLaps.map((l) => telemetryToSymptoms(l.telemetry, corners));
  const symptoms = aggregateSymptoms(perLapSymptoms);
  const trackConditions = telemetryToTrackConditions(fastestLoaded.telemetry);

  const cornerConsistencyDelta = computeLapConsistencyDelta(loadedLaps.map((l) => l.telemetry), corners);
  const cornerConsistency = cornerConsistencyDelta.perCorner.length > 0 ? cornerConsistencyDelta.perCorner : null;
  const lineSpread = computeLineSpreadTrace(
    loadedLaps.map((l) => l.telemetry),
    loadedLaps.map((l) => l.meta.id),
    corners,
  );

  const consistency = computeConsistency(
    loadedLaps.map((l) => l.meta),
    cornerConsistency,
    droppedOutliers,
    lineSpread,
  );
  // A session-wide baseline pool spans multiple setup versions, so even a
  // tight lap-time spread doesn't mean "this setup is dialled in" the way it
  // does for a single branch's own laps — cap confidence one notch.
  if (sourceScope === "session-baseline" && consistency.confidence === "high") {
    consistency.confidence = "medium";
  }

  return {
    ok: true,
    lapIds: loadedLaps.map((l) => l.meta.id),
    symptoms,
    trackConditions,
    consistency,
    fallbackSingleLap: false,
    sourceScope,
    headOwnLapCount,
    lapBreakdown: breakdown,
  };
}
