import type { RecordingQualitySummary } from "../../shared/racing/quality/contracts";
import { eq } from "drizzle-orm";
import { ELIGIBILITY_POLICY_VERSION, QUALITY_CONFIG_VERSION, QUALITY_SCHEMA_VERSION } from "../../shared/racing/quality/contracts";
import { db } from "../db/index";
import { laps, sessions } from "../db/schema";
import { updateSessionQuality } from "../db/session-queries";
import { rebuildPersistedSessionRuns } from "../db/session-run-queries";
import { tryGetServerGame } from "../games/registry";
import { loadRawCaptureIdentity } from "../session-capture/identity";

export type QualityRebuildAction = "current" | "rebuild_eligibility" | "reprocess" | "unavailable";

export interface QualityRebuildStatus {
  sessionId: number;
  action: QualityRebuildAction;
  currentDetectorId: string | null;
  rawAvailable: boolean;
  lapCount: number;
  recordingQuality: RecordingQualitySummary | null;
  qualityGeneration: string | null;
  stale: {
    detector: boolean;
    schema: boolean;
    policy: boolean;
    configuration: boolean;
    source: boolean;
  };
}

export async function getQualityRebuildStatus(sessionId: number): Promise<QualityRebuildStatus> {
  const session = await db
    .select({
      gameId: sessions.gameId,
      detectorVersion: sessions.lapDetectorVersion,
      rawFile: sessions.rawFile,
      recordingQuality: sessions.recordingQuality,
      schemaVersion: sessions.qualitySchemaVersion,
      policyVersion: sessions.qualityPolicyVersion,
      configurationVersion: sessions.qualityConfigVersion,
      qualityGeneration: sessions.qualityGeneration,
    })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .get();
  if (!session) throw new Error(`Session ${sessionId} not found`);
  const lapRows = await db.select({ id: laps.id }).from(laps).where(eq(laps.sessionId, sessionId)).all();
  let rawAvailable = false;
  let sourceStale = false;
  if (session.rawFile !== null) {
    try {
      const rawCapture = await loadRawCaptureIdentity(session.rawFile);
      if (rawCapture) {
        rawAvailable = true;
        const canonicalVerification = session.recordingQuality?.canonicalVerification;
        const expectedGeneration = canonicalVerification !== undefined ? canonicalVerification.sourceGeneration : (session.recordingQuality?.archiveVerification.sourceGeneration ?? null);
        sourceStale = rawCapture.contentHash !== expectedGeneration;
      } else {
        sourceStale = true;
      }
    } catch {
      sourceStale = true;
    }
  }
  const currentDetectorId = tryGetServerGame(session.gameId)?.lapDetectorId ?? null;
  const stale = {
    detector: currentDetectorId === null || session.detectorVersion === null || session.detectorVersion !== currentDetectorId,
    schema: session.schemaVersion !== QUALITY_SCHEMA_VERSION,
    policy: session.policyVersion !== ELIGIBILITY_POLICY_VERSION,
    configuration: session.configurationVersion !== QUALITY_CONFIG_VERSION,
    source: sourceStale,
  };
  const measurementStale = !session.recordingQuality || stale.schema || stale.detector || stale.configuration || stale.source;
  const action: QualityRebuildAction = measurementStale ? (rawAvailable && currentDetectorId !== null ? "reprocess" : "unavailable") : stale.policy ? "rebuild_eligibility" : "current";
  return {
    sessionId,
    currentDetectorId,
    action,
    rawAvailable,
    lapCount: lapRows.length,
    recordingQuality: session.recordingQuality,
    qualityGeneration: session.qualityGeneration,
    stale,
  };
}

export async function rebuildSessionEligibility(sessionId: number): Promise<QualityRebuildStatus> {
  const status = await getQualityRebuildStatus(sessionId);
  if (status.action === "current") return status;
  if (status.action !== "rebuild_eligibility") return status;
  const row = await db.select({ recordingQuality: sessions.recordingQuality }).from(sessions).where(eq(sessions.id, sessionId)).get();
  const recordingQuality = row?.recordingQuality;
  if (!recordingQuality) return { ...status, action: "unavailable" };
  await db.transaction(async (tx) => {
    await updateSessionQuality(sessionId, recordingQuality, tx);
    await rebuildPersistedSessionRuns(sessionId, tx);
  });
  return getQualityRebuildStatus(sessionId);
}
