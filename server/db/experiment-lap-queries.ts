import { eq, desc, and, inArray, isNotNull, isNull, ne } from "drizzle-orm";
import { db } from "./index";
import { lapMetaProjection, toLapMeta } from "./lap-meta";
import { experiments, sessions, laps, tunes } from "./schema";
import type { EligibilityDecisionSet, LapQualitySummary } from "../../shared/racing/quality/contracts";
import type { LapClassification } from "../../shared/racing/laps/classification";
import type { LapMeta } from "../../shared/racing/sessions/types";
import type { GameId } from "../../shared/games/ids";

export async function setLapExperimentExcluded(
  lapId: number,
  excluded: boolean,
): Promise<
  | { ok: true; prev: boolean; experimentId: number }
  | { ok: false; prev?: never; experimentId?: never }
> {
  return db.transaction(async (tx) => {
    const row = await tx
      .select({
        experimentExcluded: laps.experimentExcluded,
        experimentId: laps.experimentId,
      })
      .from(laps)
      .innerJoin(sessions, eq(laps.sessionId, sessions.id))
      .innerJoin(experiments, eq(laps.experimentId, experiments.id))
      .where(
        and(
          eq(laps.id, lapId),
          eq(laps.experimentId, experiments.id),
          eq(sessions.gameId, experiments.gameId),
          isNotNull(experiments.trackOrdinal),
          eq(sessions.trackOrdinal, experiments.trackOrdinal),
          ne(sessions.ownership, "others"),
        ),
      )
      .get();
    if (!row?.experimentId) return { ok: false };

    await tx
      .update(laps)
      .set({
        experimentExcluded: excluded ? 1 : null,
        experimentExcludedSource: "manual",
      })
      .where(and(eq(laps.id, lapId), eq(laps.experimentId, row.experimentId)))
      .run();
    return {
      ok: true,
      prev: Boolean(row.experimentExcluded),
      experimentId: row.experimentId,
    };
  });
}

/**
 * Read the scope laps `reconcileAutoExclusions` (server/experiments/auto-exclude.ts)
 * ranks over: every lap sharing `(experiment_id, tune_id)`, with just the
 * columns the fastest-5 rule needs.
 */

export async function getLapsForExclusionScope(
  experimentId: number,
  tuneId: number,
): Promise<
  (Pick<LapClassification, "phase" | "conditions" | "paceEligibility"> & {
    id: number;
    lapTime: number;
    isValid: boolean;
    quality: LapQualitySummary | null;
    eligibility: EligibilityDecisionSet | null;
    qualityGeneration: string | null;
    qualitySchemaVersion: string | null;
    qualityPolicyVersion: string | null;
    qualityConfigVersion: string | null;
    invalidReason: string | null;
    experimentExcluded: boolean;
    experimentExcludedSource: "auto" | "manual" | null;
  })[]
> {
  const rows = await db
    .select({
      id: laps.id,
      lapTime: laps.lapTime,
      isValid: laps.isValid,
      phase: laps.phase,
      conditions: laps.conditions,
      paceEligibility: laps.paceEligibility,
      quality: laps.quality,
      eligibility: laps.eligibility,
      qualityGeneration: laps.qualityGeneration,
      qualitySchemaVersion: laps.qualitySchemaVersion,
      qualityPolicyVersion: laps.qualityPolicyVersion,
      qualityConfigVersion: laps.qualityConfigVersion,
      invalidReason: laps.invalidReason,
      experimentExcluded: laps.experimentExcluded,
      experimentExcludedSource: laps.experimentExcludedSource,
    })
    .from(laps)
    .where(and(eq(laps.experimentId, experimentId), eq(laps.tuneId, tuneId)))
    .all();
  return rows.map((r) => ({
    id: r.id,
    lapTime: r.lapTime,
    isValid: Boolean(r.isValid),
    phase: r.phase,
    conditions: r.conditions,
    paceEligibility: r.paceEligibility,
    quality: r.quality,
    eligibility: r.eligibility,
    qualityGeneration: r.qualityGeneration,
    qualitySchemaVersion: r.qualitySchemaVersion,
    qualityPolicyVersion: r.qualityPolicyVersion,
    qualityConfigVersion: r.qualityConfigVersion,
    invalidReason: r.invalidReason,
    experimentExcluded: Boolean(r.experimentExcluded),
    experimentExcludedSource: (r.experimentExcludedSource as "auto" | "manual" | null) ?? null,
  }));
}

/**
 * Write an auto-pass exclusion decision for a lap. Always stamps
 * `experimentExcludedSource = 'auto'` — manual decisions never go through this
 * path (see `setLapExperimentExcluded`).
 */

export async function setLapAutoExclusion(lapId: number, excluded: boolean): Promise<void> {
  await db
    .update(laps)
    .set({ experimentExcluded: excluded ? 1 : null, experimentExcludedSource: "auto" })
    .where(eq(laps.id, lapId))
    .run();
}

/**
 * Read back the `(experiment_id, tune_id)` scope key a just-inserted lap
 * was stamped with, so the caller can decide whether to run
 * `reconcileAutoExclusions` (skipped when either is null — see
 * docs/architecture/setup-engineer.md §Trigger).
 */

export async function getLapExperimentScope(lapId: number): Promise<{ experimentId: number | null; tuneId: number | null }> {
  const row = await db.select({ experimentId: laps.experimentId, tuneId: laps.tuneId }).from(laps).where(eq(laps.id, lapId)).get();
  return { experimentId: row?.experimentId ?? null, tuneId: row?.tuneId ?? null };
}

/**
 * Insert a completed lap with compressed telemetry.
 */

export async function getLapsForExperiment(experimentId: number): Promise<LapMeta[]> {
  const rows = await db
    .select(lapMetaProjection)
    .from(laps)
    .innerJoin(sessions, eq(laps.sessionId, sessions.id))
    .leftJoin(tunes, eq(laps.tuneId, tunes.id))
    .where(eq(laps.experimentId, experimentId))
    .orderBy(desc(laps.id))
    .all();

  return rows.map(toLapMeta);
}

/**
 * Laps explicitly stamped to one tuning TEST (setup version) — the current
 * run's pool (migration v29). Same shape as getLapsForExperiment but scoped
 * to a single branch node so the clean-lap aggregate reflects exactly the laps
 * driven on that setup. Newest-first.
 */

export async function getLapMetaForExperimentVersion(experimentVersionId: number): Promise<LapMeta[]> {
  const rows = await db
    .select(lapMetaProjection)
    .from(laps)
    .innerJoin(sessions, eq(laps.sessionId, sessions.id))
    .leftJoin(tunes, eq(laps.tuneId, tunes.id))
    .where(eq(laps.experimentVersionId, experimentVersionId))
    .orderBy(desc(laps.id))
    .all();

  return rows.map(toLapMeta);
}

/**
 * Candidate laps for "Add laps from history" (docs/architecture/setup-engineer.md): laps matching this tuning session's game + car + track that aren't
 * already stamped to ANY tuning session. Ordinal-only match — a name-seeded
 * session already resolves `trackOrdinal` from `trackName` at creation
 * (createExperiment), so by the time this query runs that fallback is
 * already baked into the ordinal; `carOrdinal`/`trackOrdinal` left null on the
 * session (never resolved) are treated as "match any" for that dimension
 * rather than excluding everything. Newest-first, same shape as getLapsForExperiment.
 */

export async function getImportableLapsForExperiment(gameId: GameId, carOrdinal: number | null, trackOrdinal: number | null): Promise<LapMeta[]> {
  const conds = [eq(sessions.gameId, gameId), isNull(laps.experimentId)];
  if (carOrdinal != null) conds.push(eq(sessions.carOrdinal, carOrdinal));
  if (trackOrdinal != null) conds.push(eq(sessions.trackOrdinal, trackOrdinal));

  const rows = await db
    .select(lapMetaProjection)
    .from(laps)
    .innerJoin(sessions, eq(laps.sessionId, sessions.id))
    .leftJoin(tunes, eq(laps.tuneId, tunes.id))
    .where(and(...conds))
    .orderBy(desc(laps.id))
    .all();

  return rows.map(toLapMeta);
}

/**
 * Stamp a batch of laps onto a tuning session (and optional test/branch) —
 * "Add laps from history" attach step. Only laps that are currently unstamped
 * (`experimentId IS NULL`) are touched, so a lapIds list stale from a
 * concurrent import can't steal laps from another session. Returns the ids
 * actually updated.
 */

export async function importLapsToExperiment(experimentId: number, lapIds: number[], experimentVersionId: number | null): Promise<number[]> {
  if (lapIds.length === 0) return [];
  const result = await db
    .update(laps)
    .set({ experimentId, experimentVersionId })
    .where(and(inArray(laps.id, lapIds), isNull(laps.experimentId)))
    .returning({ id: laps.id })
    .all();
  return result.map((r) => r.id);
}

/**
 * Undo inverse for `importLapsToExperiment`: clear only rows that still belong
 * to the same experiment. A stale undo must never clear a later reassignment.
 */
export async function unstampLapsFromExperiment(experimentId: number, lapIds: number[]): Promise<void> {
  if (lapIds.length === 0) return;
  await db
    .update(laps)
    .set({ experimentId: null, experimentVersionId: null })
    .where(and(inArray(laps.id, lapIds), eq(laps.experimentId, experimentId)))
    .run();
}
