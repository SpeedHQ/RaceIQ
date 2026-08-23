import { cacheDelete } from "./telemetry-replay-storage";
import { invalidateLapEvidence } from "./lap-evidence-invalidation";
import { eq } from "drizzle-orm";
import { db } from "./index";
import { sessions, laps } from "./schema";
import {
  ELIGIBILITY_POLICY_VERSION,
  QUALITY_CONFIG_VERSION,
  QUALITY_SCHEMA_VERSION,
  type EligibilityDecisionSet,
  type LapQualitySummary,
} from "../../shared/racing/quality/contracts";
import type { TelemetryVersionIdentity } from "../../shared/telemetry/version";
import { getActiveExperiment } from "../experiments/active";
import { resolveActiveTestId } from "./experiment-version-queries";
import {
  finalizeLapQualityGeneration,
  mergeRecordingQualityIntoLapQuality,
} from "../lap-analysis/quality-generation";

const FINALIZED_QUALITY_GENERATION_PATTERN = /^sha256:[0-9a-f]{64}$/;

export async function updateLapNotes(id: number, notes: string | null): Promise<void> {
  await db.update(laps).set({ notes }).where(eq(laps.id, id)).run();
}


export async function updateLapValidity(
  id: number,
  isValid: boolean,
  invalidReason: string | null,
  sectors?: number[] | null,
): Promise<void> {
  const values: Record<string, unknown> = { isValid, invalidReason };
  if (sectors !== undefined) {
    values.sectorTimes = sectors;
  }
  await db.transaction(async (tx) => {
    await tx.update(laps).set(values).where(eq(laps.id, id)).run();
    await invalidateLapEvidence({ lapIds: [id] }, tx);
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
  quality: LapQualitySummary | null;
  eligibility: EligibilityDecisionSet | null;
  versionIdentity?: TelemetryVersionIdentity;
}

export async function insertLap(input: PersistLapInput): Promise<number> {
  const {
    sessionId,
    lapNumber,
    lapTime,
    isValid,
    rawByteOffset,
    rawFrameCount,
    profileId,
    tuneId,
    invalidReason,
    sectors,
    quality,
    eligibility,
    versionIdentity,
  } = input;
  // Stamp the lap with the active tuning session (if any). This is the single
  // choke point every live lap-detector funnels through (via the DbAdapter), so
  // reading the in-memory active id here links laps to a tuning session
  // independent of race sessionId — a tuning session can span many race
  // sessions. Cheap, unconditional on game; null when no session is active.
  const activeExperimentId = getActiveExperiment();
  const activeExperimentVersionId =
    activeExperimentId != null ? await resolveActiveTestId(activeExperimentId) : null;
  let qualityToPersist = quality;
  let eligibilityToPersist = eligibility;
  if (quality) {
    const sessionQuality = await db
      .select({
        recordingQuality: sessions.recordingQuality,
        qualitySchemaVersion: sessions.qualitySchemaVersion,
        qualityPolicyVersion: sessions.qualityPolicyVersion,
        qualityConfigVersion: sessions.qualityConfigVersion,
        qualityGeneration: sessions.qualityGeneration,
      })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .get();
    const recordingQuality = sessionQuality?.recordingQuality;
    if (
      sessionQuality &&
      recordingQuality &&
      sessionQuality.qualitySchemaVersion === QUALITY_SCHEMA_VERSION &&
      sessionQuality.qualityPolicyVersion === ELIGIBILITY_POLICY_VERSION &&
      sessionQuality.qualityConfigVersion === QUALITY_CONFIG_VERSION &&
      sessionQuality.qualityGeneration ===
        recordingQuality.provenance.outputGeneration &&
      FINALIZED_QUALITY_GENERATION_PATTERN.test(
        recordingQuality.provenance.sourceGeneration,
      ) &&
      FINALIZED_QUALITY_GENERATION_PATTERN.test(
        recordingQuality.provenance.outputGeneration,
      )
    ) {
      const generated = finalizeLapQualityGeneration(
        mergeRecordingQualityIntoLapQuality(recordingQuality, quality),
        recordingQuality.provenance.sourceGeneration,
        { lapNumber, rawByteOffset, rawFrameCount },
      );
      qualityToPersist = generated.quality;
      eligibilityToPersist = generated.eligibility;
    }
  }
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
      quality: qualityToPersist,
      eligibility: eligibilityToPersist,
      qualitySchemaVersion: qualityToPersist?.provenance.schemaVersion ?? null,
      qualityPolicyVersion: qualityToPersist?.provenance.policyVersion ?? null,
      qualityConfigVersion: qualityToPersist?.provenance.configurationVersion ?? null,
      qualityGeneration: qualityToPersist?.provenance.outputGeneration ?? null,
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
  // Get session ID before deleting
  const lap = await db.select({ sessionId: laps.sessionId }).from(laps).where(eq(laps.id, id)).get();
  const result = await db.delete(laps).where(eq(laps.id, id)).returning().all();
  if (result.length > 0) {
    cacheDelete(id);
    // Clean up empty parent session
    if (lap) {
      const remaining = await db.select({ id: laps.id }).from(laps).where(eq(laps.sessionId, lap.sessionId)).limit(1).all();
      if (remaining.length === 0) {
        await db.delete(sessions).where(eq(sessions.id, lap.sessionId)).run();
      }
    }
  }
  return result.length > 0;
}
