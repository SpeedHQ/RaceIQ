import { existsSync } from "node:fs";
import type { RecordingQualitySummary } from "../../shared/racing/quality/contracts";
import { eq } from "drizzle-orm";
import { ELIGIBILITY_POLICY_VERSION, QUALITY_CONFIG_VERSION, QUALITY_SCHEMA_VERSION } from "../../shared/racing/quality/contracts";
import { db } from "../db/index";
import { laps, sessions } from "../db/schema";
import { updateSessionQuality } from "../db/session-queries";
import { tryGetServerGame } from "../games/registry";

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
  const rawAvailable = session.rawFile != null && existsSync(session.rawFile);
  const currentDetectorId = tryGetServerGame(session.gameId)?.lapDetectorId ?? null;
  const stale = {
    detector: currentDetectorId === null || session.detectorVersion === null || session.detectorVersion !== currentDetectorId,
    schema: session.schemaVersion !== QUALITY_SCHEMA_VERSION,
    policy: session.policyVersion !== ELIGIBILITY_POLICY_VERSION,
    configuration: session.configurationVersion !== QUALITY_CONFIG_VERSION,
  };
  const measurementStale = !session.recordingQuality || stale.schema || stale.detector || stale.configuration;
  const action: QualityRebuildAction = measurementStale
    ? rawAvailable && currentDetectorId !== null
      ? "reprocess"
      : "unavailable"
    : stale.policy
      ? "rebuild_eligibility"
      : "current";
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
  if (!row?.recordingQuality) return { ...status, action: "unavailable" };
  await updateSessionQuality(sessionId, row.recordingQuality);
  return getQualityRebuildStatus(sessionId);
}
