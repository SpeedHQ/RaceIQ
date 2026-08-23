import { cacheDelete } from "./telemetry-replay-storage";
import { eq, and, inArray, notInArray, or } from "drizzle-orm";
import { db } from "./index";
import { compareAnalyses, laps } from "./schema";
import type { LapClassification } from "../../shared/racing/laps/classification";
import type { TelemetryVersionIdentity } from "../../shared/telemetry/version";
import type { EligibilityDecisionSet, LapQualitySummary } from "../../shared/racing/quality/contracts";
type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface ReprocessingLap {
  id: number;
  lapNumber: number;
  lapTime: number;
  isValid: boolean;
  phase: LapClassification["phase"];
  conditions: LapClassification["conditions"];
  paceEligibility: LapClassification["paceEligibility"];
  notes: string | null;
  profileId: number | null;
  pi: number | null;
  carSetup: string | null;
  tuneId: number | null;
  experimentId: number | null;
  experimentVersionId: number | null;
  experimentExcluded: number | null;
  experimentExcludedSource: string | null;
  createdAt: string;
  rawByteOffset: number | null;
  rawFrameCount: number | null;
  sectorTimes: number[] | null;
  quality: LapQualitySummary | null;
  eligibility: EligibilityDecisionSet | null;
  qualityGeneration: string | null;
}

export async function getLapsForSession(
  sessionId: number,
): Promise<ReprocessingLap[]> {
  const rows = await db
    .select({
      id: laps.id,
      lapNumber: laps.lapNumber,
      lapTime: laps.lapTime,
      isValid: laps.isValid,
      phase: laps.phase,
      conditions: laps.conditions,
      paceEligibility: laps.paceEligibility,
      notes: laps.notes,
      profileId: laps.profileId,
      pi: laps.pi,
      carSetup: laps.carSetup,
      tuneId: laps.tuneId,
      experimentId: laps.experimentId,
      experimentVersionId: laps.experimentVersionId,
      experimentExcluded: laps.experimentExcluded,
      experimentExcludedSource: laps.experimentExcludedSource,
      createdAt: laps.createdAt,
      rawByteOffset: laps.rawByteOffset,
      rawFrameCount: laps.rawFrameCount,
      sectorTimes: laps.sectorTimes,
      quality: laps.quality,
      eligibility: laps.eligibility,
      qualityGeneration: laps.qualityGeneration,
    })
    .from(laps)
    .where(eq(laps.sessionId, sessionId))
    .orderBy(laps.lapNumber)
    .all();
  return rows.map((r) => ({ ...r, isValid: Boolean(r.isValid) }));
}

/** Update lap frame index and metadata after reprocessing. */
export interface UpdateLapRawIndexInput {
  lapId: number;
  rawByteOffset: number | null;
  rawFrameCount: number;
  lapTime: number;
  isValid: boolean;
  invalidReason: string | null;
  sectors: number[] | null;
  classification: LapClassification;
  quality: LapQualitySummary;
  eligibility: EligibilityDecisionSet;
  versionIdentity: TelemetryVersionIdentity;
}

export async function updateLapRawIndex(
  input: UpdateLapRawIndexInput,
  transaction?: DbTransaction,
): Promise<void> {
  cacheDelete(input.lapId);
  const executor = transaction ?? db;
  await executor
    .update(laps)
    .set({
      rawByteOffset: input.rawByteOffset,
      rawFrameCount: input.rawFrameCount,
      lapTime: input.lapTime,
      isValid: input.isValid,
      invalidReason: input.invalidReason,
      sectorTimes: input.sectors,
      ...input.classification,
      quality: input.quality,
      eligibility: input.eligibility,
      qualitySchemaVersion: input.quality.provenance.schemaVersion,
      qualityPolicyVersion: input.quality.provenance.policyVersion,
      qualityConfigVersion:
        input.quality.provenance.configurationVersion,
      qualityGeneration: input.quality.provenance.outputGeneration,
      ...input.versionIdentity,
    })
    .where(eq(laps.id, input.lapId))
    .run();
}

/** Insert detected replacement while preserving matched row metadata. */
export interface InsertReprocessedLapInput {
  sessionId: number;
  lapNumber: number;
  lapTime: number;
  isValid: boolean;
  rawByteOffset: number | null;
  rawFrameCount: number;
  tuneId: number | null;
  notes: string | null;
  invalidReason: string | null;
  sectors: number[] | null;
  classification: LapClassification;
  quality: LapQualitySummary;
  eligibility: EligibilityDecisionSet;
  versionIdentity: TelemetryVersionIdentity;
}

export async function insertReprocessedLap(input: InsertReprocessedLapInput): Promise<number> {
  const result = await db
    .insert(laps)
    .values({
      sessionId: input.sessionId,
      lapNumber: input.lapNumber,
      lapTime: input.lapTime,
      isValid: input.isValid,
      rawByteOffset: input.rawByteOffset,
      rawFrameCount: input.rawFrameCount,
      tuneId: input.tuneId,
      notes: input.notes,
      invalidReason: input.invalidReason,
      ...input.classification,
      sectorTimes: input.sectors,
      quality: input.quality,
      eligibility: input.eligibility,
      qualitySchemaVersion: input.quality.provenance.schemaVersion,
      qualityPolicyVersion: input.quality.provenance.policyVersion,
      qualityConfigVersion: input.quality.provenance.configurationVersion,
      qualityGeneration: input.quality.provenance.outputGeneration,
      ...input.versionIdentity,
    })
    .returning({ id: laps.id })
    .get();
  return result.id;
}

/** Delete replaceable laps while retaining explicitly archived fallback rows. */

export async function deleteLapsForSession(sessionId: number, preserveLapIds: readonly number[] = []): Promise<void> {
  const rows = await db.select({ id: laps.id }).from(laps).where(eq(laps.sessionId, sessionId)).all();
  const preserved = new Set(preserveLapIds);
  const deletedIds = rows.map(({ id }) => id).filter((id) => !preserved.has(id));
  for (const id of deletedIds) cacheDelete(id);
  if (deletedIds.length === 0) return;
  await db
    .delete(compareAnalyses)
    .where(or(inArray(compareAnalyses.lapAId, deletedIds), inArray(compareAnalyses.lapBId, deletedIds)))
    .run();
  if (preserveLapIds.length === 0) {
    await db.delete(laps).where(eq(laps.sessionId, sessionId));
    return;
  }
  await db.delete(laps).where(and(eq(laps.sessionId, sessionId), notInArray(laps.id, [preserveLapIds[0]!, ...preserveLapIds.slice(1)])));
}
