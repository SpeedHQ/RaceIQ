import { isPitCycleLap } from "./lap-filters";

/**
 * Review lap curation. The Track Focus review analyses a stint's telemetry
 * across laps (racing-line spread, per-frame consistency, tyres). At full rate
 * that scales with laps × lap-length — a long track (Nordschleife ~42k
 * frames/lap) at many laps would decode gigabytes and ship a huge trace
 * payload. So the per-frame heavy paths (server /line-spread + client
 * useStintTraces) operate on a curated subset: the N fastest clean laps. The
 * driver can record as many laps as they like; the review curates the best few.
 *
 * Lap-time-based stats (consistency %, degradation slope) still run over the
 * FULL stint — they're cheap (lap-time math, no frame decode) and degradation
 * genuinely needs every lap.
 */
export const REVIEW_LAP_CAP = 5;

/** The `n` fastest laps by lap time. Input is expected to be pre-filtered to
 *  clean/eligible laps; this only ranks + trims. */
export function fastestLaps<T extends { lapTime: number }>(laps: T[], n: number = REVIEW_LAP_CAP): T[] {
  return [...laps].sort((a, b) => a.lapTime - b.lapTime).slice(0, n);
}

/**
 * Why a lap is (or isn't) part of the evaluated set.
 *
 * `slower-than-cap` is deliberately distinct from `manual`/`auto`: the lap is
 * perfectly clean and simply lost the fastest-N ranking. Conflating the two in
 * the UI reads as "the app threw away my good lap".
 */
export type EvaluationReason =
  | "chosen"
  | "invalid"
  | "pit"
  | "legacy"
  | "manual"
  | "auto"
  | "slower-than-cap";

export interface EvaluationSelection<T> {
  /** The curated laps, fastest first. */
  chosen: T[];
  chosenIds: Set<number>;
  reasonById: Map<number, EvaluationReason>;
  /** Clean laps that only missed out on the cap — the honest "not evaluated
   *  but nothing wrong with it" bucket. */
  cappedIds: Set<number>;
}

/** Minimal lap shape the selector needs. Satisfied by both `LapMeta` (client)
 *  and the server's `ExclusionScopeLap` row projection. */
export interface EvaluableLap {
  id: number;
  lapTime: number;
  isValid: boolean;
  invalidReason?: string | null;
  isLegacy?: boolean;
  tuningExcluded?: boolean;
  tuningExcludedSource?: "auto" | "manual" | null;
}

/**
 * THE definition of "which laps does the review actually evaluate".
 *
 * Previously this decision was re-derived in three places that could disagree:
 * the server auto-exclude pass, the /line-spread route, and TrackFocusView.
 * When auto-exclude had never run for a scope (legacy laps, or a lap with no
 * tuning session / tune stamped) the client's extra `fastestLaps()` trim would
 * silently drop laps that the UI still rendered as included. Everything routes
 * through here now so what's displayed is what's computed.
 *
 * Ordering mirrors the auto-exclude pass in server/tuning-auto-exclude.ts:
 * manual decisions are pinned first, then hard-ineligible laps, then the
 * fastest-N ranking over whatever remains.
 */
export function selectEvaluationLaps<T extends EvaluableLap>(
  laps: T[],
  n: number = REVIEW_LAP_CAP,
): EvaluationSelection<T> {
  const reasonById = new Map<number, EvaluationReason>();
  const candidates: T[] = [];

  for (const lap of laps) {
    // Manual pins win over everything — never read, never overridden.
    if (lap.tuningExcludedSource === "manual" && lap.tuningExcluded) {
      reasonById.set(lap.id, "manual");
    } else if (lap.isLegacy) {
      reasonById.set(lap.id, "legacy"); // no raw telemetry — nothing to analyse
    } else if (!lap.isValid || lap.lapTime <= 0) {
      reasonById.set(lap.id, "invalid");
    } else if (isPitCycleLap({ invalidReason: lap.invalidReason ?? undefined })) {
      reasonById.set(lap.id, "pit");
    } else {
      candidates.push(lap);
    }
  }

  const chosen = fastestLaps(candidates, n);
  const chosenIds = new Set(chosen.map((l) => l.id));
  const cappedIds = new Set<number>();

  for (const lap of candidates) {
    if (chosenIds.has(lap.id)) {
      reasonById.set(lap.id, "chosen");
    } else {
      // Clean, just outside the cap. If the auto pass already stamped it,
      // report that source so the row matches the persisted state.
      reasonById.set(lap.id, lap.tuningExcluded ? "auto" : "slower-than-cap");
      cappedIds.add(lap.id);
    }
  }

  return { chosen, chosenIds, reasonById, cappedIds };
}

/** Short, user-facing label per reason. Kept next to the rule it describes. */
export function evaluationReasonLabel(reason: EvaluationReason): string {
  switch (reason) {
    case "chosen":
      return "Eval";
    case "invalid":
      return "Invalid";
    case "pit":
      return "Pit lap";
    case "legacy":
      return "No telemetry";
    case "manual":
      return "Excluded";
    case "auto":
    case "slower-than-cap":
      return `Outside top ${REVIEW_LAP_CAP}`;
  }
}
