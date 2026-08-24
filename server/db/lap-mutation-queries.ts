import { cacheDelete } from "./telemetry-replay-storage";
import { eq } from "drizzle-orm";
import { db } from "./index";
import { sessions, laps } from "./schema";
import {
  DEFAULT_LAP_CLASSIFICATION,
  type LapClassification,
} from "../../shared/racing/laps/classification";
import type { EligibilityDecisionSet, LapQualitySummary } from "../../shared/racing/quality/contracts";
import type { TelemetryVersionIdentity } from "../../shared/telemetry/version";
import { getActiveExperiment } from "../experiments/active";
import { resolveActiveTestId } from "./experiment-version-queries";
import { rebuildPersistedSessionRuns } from "./session-run-queries";
import { invalidateLapEvidence } from "./lap-evidence-invalidation";
import {
  finalizeLapQualityGeneration,
  mergeRecordingQualityIntoLapQuality,
} from "../lap-analysis/quality-generation";

export async function updateLapNotes(id: number, notes: string | null): Promise<void> {
  await db.update(laps).set({ notes }).where(eq(laps.id, id)).run();
}

export async function updateLapValidity(id: number, isValid: boolean, invalidReason: string | null, sectors?: number[] | null): Promise<void> {
  const values: Record<string, unknown> = { isValid, invalidReason };
  if (sectors !== undefined) {
    values.sectorTimes = sectors;
  }
  await db.transaction(async (tx) => {
    const lap = await tx
      .select({ sessionId: laps.sessionId })
      .from(laps)
      .where(eq(laps.id, id))
      .get();
    if (!lap) return;
    await tx.update(laps).set(values).where(eq(laps.id, id)).run();
    await invalidateLapEvidence(
      { lapIds: [id], sessionId: lap.sessionId },
      tx,
    );
    await rebuildPersistedSessionRuns(lap.sessionId, tx);
  });
}

/**
 * Flip a lap's `experimentExcluded` flag (Setup Engineer `set_lap_excluded` tool,
 * docs/architecture/setup-engineer.md, and the `/api/laps/:id/experiment-excluded`
 * REST route, §Phase 7). Returns the PRIOR value plus the lap's `experimentId`
 * so the caller can log an inverse via `recordAction` for undo.
 *
 * Stamps `experimentExcludedSource = 'manual'` in BOTH directions (excluding and
 * un-excluding) — docs/architecture/setup-engineer.md.
 * This pins the lap against the auto-exclude reconciliation pass
 * (server/experiments/auto-exclude.ts) so a user's un-exclude click sticks instead of
 * the fastest-5 rule silently re-excluding it on the next lap save.
 */

export interface PersistLapInput {
  sessionId: number;
  lapNumber: number;
  lapTime: number;
  isValid: boolean;
  rawByteOffset: number | null;
  rawFrameCount: number;
  profileId: number | null;
  tuneId: number | null;
  invalidReason: string | null;
  sectors: number[] | null;
  classification?: LapClassification;
  quality: LapQualitySummary | null;
  eligibility: EligibilityDecisionSet | null;
  analysisGenerationId?: string | null;
  versionIdentity?: TelemetryVersionIdentity;
}

export async function insertLap(input: PersistLapInput): Promise<number> {
  const { sessionId, lapNumber, lapTime, isValid, rawByteOffset, rawFrameCount, profileId, tuneId, invalidReason, sectors, classification, quality, eligibility, analysisGenerationId, versionIdentity } = input;
  let persistedQuality = quality;
  let persistedEligibility = eligibility;
  if (quality && quality.provenance.outputGeneration !== "legacy") {
    const session = await db
      .select({ recordingQuality: sessions.recordingQuality })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .get();
    if (session?.recordingQuality) {
      const generated = finalizeLapQualityGeneration(
        mergeRecordingQualityIntoLapQuality(session.recordingQuality, quality),
        session.recordingQuality.provenance.sourceGeneration,
        { lapNumber, rawByteOffset, rawFrameCount },
      );
      persistedQuality = generated.quality;
      persistedEligibility = generated.eligibility;
    }
  }
  // Stamp the lap with the active tuning session (if any). This is the single
  // choke point every live lap-detector funnels through (via the DbAdapter), so
  // reading the in-memory active id here links laps to a tuning session
  // independent of race sessionId — a tuning session can span many race
  // sessions. Cheap, unconditional on game; null when no session is active.
  const activeExperimentId = getActiveExperiment();
  const activeExperimentVersionId = activeExperimentId != null ? await resolveActiveTestId(activeExperimentId) : null;
  const result = await db
    .insert(laps)
    .values({
      sessionId,
      lapNumber,
      lapTime,
      isValid,
      rawByteOffset,
      rawFrameCount,
      sectorTimes: sectors,
      profileId,
      tuneId,
      invalidReason,
      ...(classification ?? DEFAULT_LAP_CLASSIFICATION),
      quality: persistedQuality,
      eligibility: persistedEligibility,
      qualitySchemaVersion: persistedQuality?.provenance.schemaVersion ?? null,
      qualityPolicyVersion: persistedQuality?.provenance.policyVersion ?? null,
      qualityConfigVersion: persistedQuality?.provenance.configurationVersion ?? null,
      qualityGeneration: persistedQuality?.provenance.outputGeneration ?? null,
      analysisGenerationId,
      experimentId: activeExperimentId,
      experimentVersionId: activeExperimentVersionId,
      ...versionIdentity,
    })
    .returning({ id: laps.id })
    .get();
  return result.id;
}
export async function updateLapCarSetup(lapId: number, carSetup: object | null): Promise<void> {
  await db.update(laps).set({ carSetup: carSetup ? JSON.stringify(carSetup) : null }).where(eq(laps.id, lapId)).run();
}

/**
 * Backfill car/track ordinals on a session that was created before shared
 * memory static data was populated (e.g. first frames of an imported .bin
 * capture where the recorder attached before the game wrote static state).
 */
/**
 * Persist the derived per-lap metrics (migration v32) onto the lap row so the
 * next read is a plain column fetch instead of decoding every telemetry frame.
 * Null args are stored as-is (a lap with telemetry but no usable fuel/tyre
 * channel stays null and simply isn't recomputed unless its telemetry changes).
 */

export async function setLapMetrics(lapId: number, fuelPerLap: number | null, tyreWear: number | null): Promise<void> {
  await db.update(laps).set({ fuelPerLap, tyreWear }).where(eq(laps.id, lapId)).run();
}

export async function deleteLap(id: number): Promise<boolean> {
  const deleted = await db.transaction(async (tx) => {
    const lap = await tx
      .select({ sessionId: laps.sessionId })
      .from(laps)
      .where(eq(laps.id, id))
      .get();
    if (!lap) return false;

    await tx.delete(laps).where(eq(laps.id, id)).run();
    const remaining = await tx
      .select({ id: laps.id })
      .from(laps)
      .where(eq(laps.sessionId, lap.sessionId))
      .limit(1)
      .all();
    if (remaining.length === 0) {
      await tx.delete(sessions).where(eq(sessions.id, lap.sessionId)).run();
    } else {
      await rebuildPersistedSessionRuns(lap.sessionId, tx);
    }
    return true;
  });
  if (deleted) cacheDelete(id);
  return deleted;
}
