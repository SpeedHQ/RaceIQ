import { fastestLaps, REVIEW_LAP_CAP } from "../shared/review-laps";
import { isPitCycleLap } from "../shared/lap-filters";

/**
 * Tuning auto-exclude: fastest-5 lap curation
 * (docs/architecture/setup-engineer.md).
 *
 * Persists the fastest-5 decision (the same rule `shared/review-laps.ts` uses
 * to curate laps for the per-frame heavy review paths) onto
 * `laps.experiment_excluded`, scoped per `(experiment_id, tune_id)`, without
 * stomping deliberate user/AI exclusions.
 */

export interface ExclusionScopeLap {
  id: number;
  lapTime: number;
  isValid: boolean;
  invalidReason: string | null;
  experimentExcluded: boolean;
  experimentExcludedSource: "auto" | "manual" | null;
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
 *   2. Invalid or pit-cycle laps are ineligible — always `(1, 'auto')`.
 *   3. Remaining candidates are ranked via `fastestLaps()` — the same
 *      fastest-N definition the review path uses. Keepers → `(NULL, 'auto')`,
 *      the rest → `(1, 'auto')`.
 *   4. Only rows whose state pair actually changed are written.
 */
export async function reconcileAutoExclusions(
  db: LapExclusionWriter,
  experimentId: number,
  tuneId: number,
): Promise<void> {
  const scopeLaps = await db.getLapsForExclusionScope(experimentId, tuneId);

  const candidates: ExclusionScopeLap[] = [];
  const ineligible: ExclusionScopeLap[] = [];

  for (const lap of scopeLaps) {
    if (lap.experimentExcludedSource === "manual") continue; // never read, never written
    if (!lap.isValid || isPitCycleLap({ invalidReason: lap.invalidReason ?? undefined })) {
      ineligible.push(lap);
    } else {
      candidates.push(lap);
    }
  }

  const keepers = new Set(fastestLaps(candidates, REVIEW_LAP_CAP).map((l) => l.id));

  for (const lap of ineligible) {
    if (!targetState(lap, true)) await db.setLapAutoExclusion(lap.id, true);
  }

  for (const lap of candidates) {
    const shouldExclude = !keepers.has(lap.id);
    if (!targetState(lap, shouldExclude)) await db.setLapAutoExclusion(lap.id, shouldExclude);
  }
}

/**
 * Call-site wrapper for lap detectors: resolves the just-inserted lap's
 * `(experiment_id, tune_id)` scope and runs `reconcileAutoExclusions`,
 * skipping entirely when either is null (lap recorded outside a tuning
 * session, or with no tune assigned) — see the design doc's "Trigger" section.
 */
export async function reconcileAutoExclusionsForLap(
  db: LapExclusionWriter & LapExperimentScopeReader,
  lapId: number,
): Promise<void> {
  const { experimentId, tuneId } = await db.getLapExperimentScope(lapId);
  if (experimentId == null || tuneId == null) return;
  await reconcileAutoExclusions(db, experimentId, tuneId);
}
