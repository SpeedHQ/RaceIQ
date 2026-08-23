import { REVIEW_LAP_CAP, selectEvaluationLaps } from "../../shared/racing/laps/review-selection";
import type { LapCondition, LapPhase, PaceEligibility } from "../../shared/racing/laps/classification";
import type { EligibilityDecisionSet, LapQualitySummary } from "../../shared/racing/quality/contracts";

/**
 * Tuning auto-exclude: fastest-5 lap curation
 * (docs/architecture/setup-engineer.md).
 *
 * Persists the fastest-5 decision (the same rule `shared/racing/laps/review-selection.ts` uses
 * to curate laps for the per-frame heavy review paths) onto
 * `laps.experiment_excluded`, scoped per `(experiment_id, tune_id)`, without
 * stomping deliberate user/AI exclusions.
 */

export interface ExclusionScopeLap {
  id: number;
  lapTime: number;
  isValid: boolean;
  phase: LapPhase;
  conditions: LapCondition[];
  paceEligibility: PaceEligibility;
  invalidReason: string | null;
  experimentExcluded: boolean;
  experimentExcludedSource: "auto" | "manual" | null;
  quality: LapQualitySummary | null;
  eligibility: EligibilityDecisionSet | null;
  qualityGeneration: string | null;
  qualitySchemaVersion: string | null;
  qualityPolicyVersion: string | null;
  qualityConfigVersion: string | null;
}

/** Minimal DB surface `reconcileAutoExclusions` needs. */
export interface LapExclusionWriter {
  getLapsForExclusionScope(experimentId: number, tuneId: number): Promise<ExclusionScopeLap[]>;
  setLapAutoExclusion(lapId: number, excluded: boolean): Promise<void>;
}

/** Additionally needed by `reconcileAutoExclusionsForLap` to resolve scope. */
export interface LapExperimentScopeReader {
  getLapExperimentScope(lapId: number): Promise<{ experimentId: number | null; tuneId: number | null }>;
}

function targetState(lap: ExclusionScopeLap, excluded: boolean): boolean {
  // A row is already at the auto-owned target state iff its exclusion flag
  // matches AND its source is already 'auto' (a NULL/unreconciled source
  // still needs a write even when the flag value happens to match).
  return lap.experimentExcluded === excluded && lap.experimentExcludedSource === "auto";
}

/**
 * Single-pass reconciliation of the fastest-5 rule for one
 * `(experiment_id, tune_id)` scope. See the design doc's "Auto pass"
 * section for the full algorithm; summarized:
 *
 *   1. Manual laps (`source = 'manual'`) are never read for ranking purposes
 *      and never written — they don't occupy a fastest-5 slot.
 *   2. Remaining laps route through `selectEvaluationLaps`, which consumes
 *      persisted policy decisions and the shared setup-analysis group policy.
 *   3. Selected fastest-N laps become `(NULL, 'auto')`; all other auto-owned
 *      laps become `(1, 'auto')`.
 *   4. Only rows whose state pair actually changed are written.
 */
export async function reconcileAutoExclusions(db: LapExclusionWriter, experimentId: number, tuneId: number): Promise<void> {
  const scopeLaps = await db.getLapsForExclusionScope(experimentId, tuneId);

  const autoOwned = scopeLaps.filter((lap) => lap.experimentExcludedSource !== "manual");
  const selection = selectEvaluationLaps(autoOwned, REVIEW_LAP_CAP);

  for (const lap of autoOwned) {
    const shouldExclude = !selection.chosenIds.has(lap.id);
    if (!targetState(lap, shouldExclude)) {
      await db.setLapAutoExclusion(lap.id, shouldExclude);
    }
  }
}

/**
 * Call-site wrapper for lap detectors: resolves the just-inserted lap's
 * `(experiment_id, tune_id)` scope and runs `reconcileAutoExclusions`,
 * skipping entirely when either is null (lap recorded outside a tuning
 * session, or with no tune assigned) — see the design doc's "Trigger" section.
 */
export async function reconcileAutoExclusionsForLap(db: LapExclusionWriter & LapExperimentScopeReader, lapId: number): Promise<void> {
  const { experimentId, tuneId } = await db.getLapExperimentScope(lapId);
  if (experimentId == null || tuneId == null) return;
  await reconcileAutoExclusions(db, experimentId, tuneId);
}
