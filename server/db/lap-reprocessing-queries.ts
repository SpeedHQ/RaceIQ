import { randomUUID } from "node:crypto";
import { cacheDelete } from "./telemetry-replay-storage";
import { clearSessionCaptureCache } from "../session-capture/source-loader";
import { and, eq, isNotNull, or, inArray, sql } from "drizzle-orm";
import { db } from "./index";
import { laps, sessions, lapMetrics, lapAnalyses, compareAnalyses, lineSpreadCache, sessionCaptureSplitJobs } from "./schema";
import type { TelemetryVersionIdentity } from "@raceiq/shared/telemetry/version";

export async function getLapsForSession(sessionId: number): Promise<Array<{
  id: number; lapNumber: number; lapTime: number; isValid: boolean; isFavorite: boolean;
  notes: string | null; tuneId: number | null;
  rawByteOffset: number | null; rawFrameCount: number | null;
  sectorTimes: number[] | null;
}>> {
  const rows = await db
    .select({
      id: laps.id,
      lapNumber: laps.lapNumber,
      lapTime: laps.lapTime,
      isValid: laps.isValid,
      isFavorite: laps.isFavorite,
      notes: laps.notes,
      tuneId: laps.tuneId,
      rawByteOffset: laps.rawByteOffset,
      rawFrameCount: laps.rawFrameCount,
      sectorTimes: laps.sectorTimes,
    })
    .from(laps)
    .where(eq(laps.sessionId, sessionId))
    .orderBy(laps.lapNumber)
    .all();
  return rows.map(r => ({ ...r, isValid: Boolean(r.isValid), isFavorite: Boolean(r.isFavorite) }));
}

/** Update lap frame index and metadata after reprocessing. */

export async function updateLapRawIndex(
  lapId: number,
  rawByteOffset: number | null,
  rawFrameCount: number,
  lapTime: number,
  isValid: boolean,
  invalidReason: string | null,
  sectors: number[] | null,
  versionIdentity?: TelemetryVersionIdentity,
): Promise<void> {
  await db.update(laps).set({
    rawByteOffset,
    rawFrameCount,
    lapTime,
    isValid,
    invalidReason,
    sectorTimes: sectors,
    ...versionIdentity,
  }).where(eq(laps.id, lapId));
  cacheDelete(lapId);
}

/** Reconcile lap rows atomically, preserving IDs and user-owned fields for matched laps. */
export async function replaceLapsForSession(
  sessionId: number,
  replacements: ReadonlyArray<{
    lapId: number | null;
    lapNumber: number;
    lapTime: number;
    isValid: boolean;
    isFavorite: boolean;
    rawByteOffset: number | null;
    rawFrameCount: number;
    tuneId: number | null;
    notes: string | null;
    invalidReason: string | null;
    sectors: number[] | null;
    versionIdentity?: TelemetryVersionIdentity;
  }>,
  sessionIdentity?: { carId: string; trackId: string },
): Promise<void> {
  const invalidatedIds = await db.transaction(async (tx) => {
    const matchedIds = new Set(replacements.flatMap(({ lapId }) => lapId === null ? [] : [lapId]));
    const rows = await tx.select({
      id: laps.id, lapNumber: laps.lapNumber, rawByteOffset: laps.rawByteOffset, rawFrameCount: laps.rawFrameCount,
    }).from(laps).where(eq(laps.sessionId, sessionId)).all();
    const ownershipChanged = Boolean(sessionIdentity) || rows.length !== replacements.length || replacements.some((replacement) => {
      const previous = replacement.lapId === null ? undefined : rows.find(({ id }) => id === replacement.lapId);
      return !previous || previous.lapNumber !== replacement.lapNumber ||
        previous.rawByteOffset !== replacement.rawByteOffset || previous.rawFrameCount !== replacement.rawFrameCount;
    });
    const deleted = rows.map(({ id }) => id).filter((id) => !matchedIds.has(id));
    const invalidated = [...matchedIds];
    if (ownershipChanged) {
      await tx.update(sessions).set({ captureLayoutVersion: null, captureManifestFile: null }).where(eq(sessions.id, sessionId));
      await tx.update(laps).set({ captureChunkId: null, sourceFrameStart: null, sourceFrameCount: null }).where(eq(laps.sessionId, sessionId));
      await tx.update(sessionCaptureSplitJobs).set({
        jobId: randomUUID(), attemptId: sql`${sessionCaptureSplitJobs.attemptId} + 1`,
        status: "failed", sequence: sql`${sessionCaptureSplitJobs.sequence} + 1`,
        errorCode: "stale-publication", errorMessage: "Lap ownership changed during reprocessing",
        stagingPath: null, updatedAt: new Date().toISOString(),
      }).where(and(eq(sessionCaptureSplitJobs.sessionId, sessionId), or(
        eq(sessionCaptureSplitJobs.status, "queued"), eq(sessionCaptureSplitJobs.status, "splitting"),
        eq(sessionCaptureSplitJobs.status, "verifying"), eq(sessionCaptureSplitJobs.status, "publishing"),
        eq(sessionCaptureSplitJobs.status, "ready"),
      )));
    }
    const invalidate = async (ids: readonly number[]) => {
      for (const id of ids) {
        await tx.delete(lapMetrics).where(eq(lapMetrics.lapId, id));
        await tx.delete(lapAnalyses).where(eq(lapAnalyses.lapId, id));
      }
      if (ids.length > 0) {
        await tx.delete(compareAnalyses).where(
          or(inArray(compareAnalyses.lapAId, ids), inArray(compareAnalyses.lapBId, ids)),
        );
      }
    };
    const affectedExperiments = await tx
      .selectDistinct({ experimentId: laps.experimentId })
      .from(laps)
      .where(and(eq(laps.sessionId, sessionId), isNotNull(laps.experimentId)))
      .all();
    for (const { experimentId } of affectedExperiments) {
      if (experimentId === null) continue;
      await tx.delete(lineSpreadCache).where(eq(lineSpreadCache.experimentId, experimentId));
    }
    await invalidate(rows.map(({ id }) => id));
    for (const id of deleted) await tx.delete(laps).where(eq(laps.id, id));
    for (const replacement of replacements) {
      const values = {
        lapNumber: replacement.lapNumber,
        lapTime: replacement.lapTime,
        isValid: replacement.isValid,
        rawByteOffset: replacement.rawByteOffset,
        rawFrameCount: replacement.rawFrameCount,
        invalidReason: replacement.invalidReason,
        sectorTimes: replacement.sectors,
        ...replacement.versionIdentity,
      };
      if (replacement.lapId !== null) {
        await tx.update(laps).set({ ...values, fuelPerLap: null, tyreWear: null }).where(eq(laps.id, replacement.lapId));
      } else {
        const inserted = await tx.insert(laps).values({
          sessionId,
          ...values,
          isFavorite: replacement.isFavorite,
          tuneId: replacement.tuneId,
          notes: replacement.notes,
        }).returning({ id: laps.id }).get();
        invalidated.push(inserted.id);
      }
    }
    if (sessionIdentity) {
      await tx.update(sessions).set(sessionIdentity).where(eq(sessions.id, sessionId));
    }
    return { deleted, invalidated, ownershipChanged };
  });
  for (const id of invalidatedIds.deleted) cacheDelete(id);
  for (const id of invalidatedIds.invalidated) cacheDelete(id);
  if (invalidatedIds.ownershipChanged) clearSessionCaptureCache();
}


