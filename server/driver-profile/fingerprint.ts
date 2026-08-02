/**
 * Pure deterministic assembly for Driver Profiler fingerprints.
 *
 * Detector aggregation lives in detectors.ts, trend calculation in trend.ts,
 * and DB-backed loading in load.ts. Same inputs always produce deeply equal
 * output: no DB, clock, LLM, or randomness enters this module.
 */
import type { LapStyleSummary } from "../../shared/lib/driving-style";
import type { LapInsight } from "../../shared/lib/lap-insights";
import type { GameId, LapMeta } from "../../shared/types";
import type { Confidence } from "../experiments/lap-evidence/aggregate";
import {
  computeStyleAxes,
  MIN_LAPS_FOR_STYLE,
  rankWeaknesses,
  rollUpDetectors,
  type DetectorStat,
  type RankedWeakness,
  type StyleAxes,
} from "./detectors";
import { buildDriverTrend, type DriverTrend } from "./trend";

type ProfileScopeKind = "car-track" | "global";

export interface ProfileScope {
  kind: ProfileScopeKind;
  gameId: GameId;
  carOrdinal: number | null;
  trackOrdinal: number | null;
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

function confidenceFor(lapCount: number): Confidence {
  if (lapCount >= 10) return "high";
  if (lapCount >= 5) return "medium";
  if (lapCount >= MIN_LAPS_FOR_STYLE) return "low";
  return "very-low";
}

export function emptyFingerprint(
  scope: ProfileScope,
  laps: Partial<LapPoolReport> = {},
  notes: string[] = [],
  trend: DriverTrend = buildDriverTrend([]),
): DriverFingerprint {
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
 * Pure core: laps plus parallel detector/style results in, fingerprint out.
 * Sorting by lap id makes output stable when input order differs.
 */
export function buildDriverFingerprint(input: {
  scope: ProfileScope;
  laps: readonly LapMeta[];
  perLapInsights: readonly (readonly LapInsight[])[];
  perLapStyle?: readonly (LapStyleSummary | undefined)[];
  trend?: DriverTrend;
  pool?: Partial<LapPoolReport>;
  notes?: readonly string[];
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
  if (pool.droppedNoTelemetry) {
    notes.push(`${pool.droppedNoTelemetry} lap${pool.droppedNoTelemetry === 1 ? "" : "s"} had no usable telemetry.`);
  }
  return {
    ok: trend.recent.total > 0,
    scope,
    laps: {
      lapIds,
      analyzed: lapCount,
      candidates: pool.candidates ?? trend.recent.total,
      droppedNoTelemetry: pool.droppedNoTelemetry ?? 0,
    },
    confidence: confidenceFor(lapCount),
    style,
    trend,
    weaknesses,
    unquantifiedWeaknesses,
    detectors,
    notes: lapCount === 0 ? [...notes, "No usable laps for this scope."] : notes,
  };
}
