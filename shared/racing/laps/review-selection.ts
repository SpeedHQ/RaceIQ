import type { LapCondition, LapPhase, PaceEligibility } from "./classification";
import type { EligibilityDecision, EligibilityDecisionSet, EligibilityPolicyId, LapQualitySummary, QualityReasonCode } from "../quality/contracts";
import { evaluateGroupEligibility, isEligibilityUsable, resolveEligibilityDecision, type QualitySnapshotEvidence } from "../quality/policies";

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
const REVIEW_REQUIRED_POLICY_IDS = ["normal-pace", "corner-trace"] as const satisfies readonly EligibilityPolicyId[];

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
export type EvaluationReason = "chosen" | "invalid" | "non-pace" | "manual" | "auto" | "slower-than-cap";

export interface EvaluationSelection<T> {
  /** The curated laps, fastest first. */
  chosen: T[];
  chosenIds: Set<number>;
  reasonById: Map<number, EvaluationReason>;
  /** Exact policy reasons that rejected each lap. Empty means no policy rejection. */
  reasonCodesById: Map<number, readonly QualityReasonCode[]>;
  /** Exact source decision for a policy rejection; absent for non-policy drops. */
  rejectionDecisionById: Map<number, EligibilityDecision>;
  /** Policy-owned session/group decision used for setup evidence. */
  setupDecision: EligibilityDecision;
  /** Clean laps that only missed out on the cap — the honest "not evaluated
   *  but nothing wrong with it" bucket. */
  cappedIds: Set<number>;
}

/** Minimal lap shape the selector needs. Satisfied by both `LapMeta` (client)
 *  and the server's `ExclusionScopeLap` row projection. */
export interface EvaluableLap extends QualitySnapshotEvidence {
  id: number;
  lapTime: number;
  isValid: boolean;
  phase?: LapPhase | null;
  conditions?: LapCondition[] | null;
  paceEligibility?: PaceEligibility | null;
  invalidReason?: string | null;
  experimentExcluded?: boolean;
  experimentExcludedSource?: "auto" | "manual" | null;
  quality?: LapQualitySummary | null;
  eligibility?: EligibilityDecisionSet | null;
}

interface SetupLapPolicyDecisions {
  normalPace: EligibilityDecision;
  cornerTrace: EligibilityDecision;
}

/**
 * Consume persisted lap decisions first, falling back to policy evaluation only
 * when quality evidence exists but its decision snapshot is missing. Missing
 * evidence stays unknown (`quality_not_rebuilt`); it is never treated as zero or
 * silently accepted.
 */
function setupLapPolicyDecisions(lap: EvaluableLap): SetupLapPolicyDecisions {
  return {
    normalPace: resolveEligibilityDecision(lap, "normal-pace"),
    cornerTrace: resolveEligibilityDecision(lap, "corner-trace"),
  };
}

/**
 * Evaluate setup-analysis once through shared policy code. Consumers must not
 * duplicate its sample-pool or consistency rules. Persisted per-lap decisions
 * remain authoritative inputs; setup-analysis itself is a group decision.
 */
export function evaluateSetupSelection(laps: readonly EvaluableLap[]): EligibilityDecision {
  return evaluateGroupEligibility(
    "setup-analysis",
    laps.flatMap((lap) => {
      if (!lap.quality || lap.lapTime <= 0 || (lap.experimentExcludedSource === "manual" && lap.experimentExcluded)) {
        return [];
      }
      const decisions = setupLapPolicyDecisions(lap);
      return [
        {
          lapId: lap.id,
          lapTime: lap.lapTime,
          quality: lap.quality,
          eligibility: {
            ...(lap.eligibility ?? {}),
            "normal-pace": decisions.normalPace,
            "corner-trace": decisions.cornerTrace,
          } as EligibilityDecisionSet,
        },
      ];
    }),
  );
}

/**
 * THE definition of "which laps does the review actually evaluate".
 *
 * manual decisions are pinned first, then non-positive timing, then policy
 * eligibility (including structural validity), then the fastest-N ranking.
 */
export function selectEvaluationLaps<T extends EvaluableLap>(
  laps: T[],
  n: number = REVIEW_LAP_CAP,
  options: { requireSetupEligibility?: boolean; requiredPolicyIds?: readonly EligibilityPolicyId[] } = {},
): EvaluationSelection<T> {
  const reasonById = new Map<number, EvaluationReason>();
  const reasonCodesById = new Map<number, readonly QualityReasonCode[]>();
  const rejectionDecisionById = new Map<number, EligibilityDecision>();
  const candidates: T[] = [];
  const setupDecision = evaluateSetupSelection(laps);
  const requiredPolicyIds = options.requiredPolicyIds ?? REVIEW_REQUIRED_POLICY_IDS;

  for (const lap of laps) {
    // Manual pins win over everything — never read, never overridden.
    if (lap.experimentExcludedSource === "manual" && lap.experimentExcluded) {
      reasonById.set(lap.id, "manual");
      reasonCodesById.set(lap.id, []);
    } else if (lap.lapTime <= 0) {
      reasonById.set(lap.id, "invalid");
      reasonCodesById.set(lap.id, []);
    } else {
      const policyFailures = requiredPolicyIds.map((policyId) => resolveEligibilityDecision(lap, policyId)).filter((decision) => !isEligibilityUsable(decision));
      if ((options.requireSetupEligibility !== false && !isEligibilityUsable(setupDecision)) || policyFailures.length > 0) {
        rejectionDecisionById.set(lap.id, policyFailures[0] ?? setupDecision);
        reasonById.set(lap.id, "non-pace");
        reasonCodesById.set(lap.id, [...new Set((policyFailures.length > 0 ? policyFailures : [setupDecision]).flatMap((decision) => decision.reasons.map((reason) => reason.code)))]);
      } else {
        candidates.push(lap);
      }
    }
  }

  const chosen = fastestLaps(candidates, n);
  const chosenIds = new Set(chosen.map((lap) => lap.id));
  const cappedIds = new Set<number>();

  for (const lap of candidates) {
    reasonCodesById.set(lap.id, []);
    if (chosenIds.has(lap.id)) {
      reasonById.set(lap.id, "chosen");
    } else {
      // Clean, just outside the cap. If the auto pass already stamped it,
      // report that source so the row matches the persisted state.
      reasonById.set(lap.id, lap.experimentExcluded ? "auto" : "slower-than-cap");
      cappedIds.add(lap.id);
    }
  }

  return {
    chosen,
    chosenIds,
    reasonById,
    reasonCodesById,
    rejectionDecisionById,
    setupDecision,
    cappedIds,
  };
}

/** Short, user-facing label per reason. Kept next to the rule it describes. */
export function evaluationReasonLabel(reason: EvaluationReason): string {
  switch (reason) {
    case "chosen":
      return "Eval";
    case "invalid":
      return "Invalid";
    case "non-pace":
      return "Non-pace";
    case "manual":
      return "Excluded";
    case "auto":
    case "slower-than-cap":
      return `Outside top ${REVIEW_LAP_CAP}`;
  }
}
