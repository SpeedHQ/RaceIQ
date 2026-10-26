import { isDeepStrictEqual } from "node:util";
import { cacheDelete } from "./telemetry-replay-storage";
import { and, eq, or, sql } from "drizzle-orm";
import { db } from "./index";
import { sessions, laps, lapGuidReconciliation, originalActivitySourceLaps, lapMetrics, lapAnalyses, compareAnalyses } from "./schema";
import { createLapGuid } from "./lap-guid";
import { withDatabaseWrite } from "./write-coordination";
import type { TelemetryVersionIdentity } from "@raceiq/shared/telemetry/version";
import type { LapClassification } from "@raceiq/shared/racing/lap-classification";
import type { DriverAttributionStint, LapDriverAttribution } from "@raceiq/shared/driver-attribution";
import { isWholeLapSelf } from "@raceiq/shared/driver-attribution";
import { getRecordingInstallationId } from "./recording-origin";
import { getActiveExperiment } from "../experiments/active";
import { resolveActiveTestId } from "./experiment-version-queries";
import { fastestLapUpsert } from "./online-fastest-lap-queries";

export async function updateLapNotes(id: number, notes: string | null): Promise<void> {
  await withDatabaseWrite(() => db.update(laps).set({ notes }).where(eq(laps.id, id)).run());
}


export async function updateLapValidity(id: number, isValid: boolean, invalidReason: string | null, sectors?: number[] | null): Promise<void> {
  const values: Record<string, unknown> = { isValid, invalidReason };
  if (sectors !== undefined) values.sectorTimes = sectors;
  await withDatabaseWrite(() => db.update(laps).set(values).where(eq(laps.id, id)).run());
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

export function insertLap(
  sessionId: number,
  lapNumber: number,
  lapTime: number,
  isValid: boolean,
  rawByteOffset: number | null,
  rawFrameCount: number,
  profileId: number | null = null,
  tuneId: number | null = null,
  invalidReason: string | null = null,
  sectors: number[] | null = null,
  classification: LapClassification | null = null,
  versionIdentity?: TelemetryVersionIdentity,
  driverAttribution?: { stints: readonly DriverAttributionStint[]; attribution: LapDriverAttribution; source: { domain: string; startMs: number; endMs: number } },
): Promise<number> {
  return withDatabaseWrite(() => doInsertLap(sessionId, lapNumber, lapTime, isValid, rawByteOffset, rawFrameCount, profileId, tuneId, invalidReason, sectors, classification, versionIdentity, driverAttribution), undefined, "lap.insert");
}

async function doInsertLap(
  sessionId: number,
  lapNumber: number,
  lapTime: number,
  isValid: boolean,
  rawByteOffset: number | null,
  rawFrameCount: number,
  profileId: number | null,
  tuneId: number | null,
  invalidReason: string | null,
  sectors: number[] | null,
  classification: LapClassification | null,
  versionIdentity?: TelemetryVersionIdentity,
  driverAttribution?: { stints: readonly DriverAttributionStint[]; attribution: LapDriverAttribution; source: { domain: string; startMs: number; endMs: number } },
): Promise<number> {
  // Stamp the lap with the active tuning session (if any). This is the single
  // choke point every live lap-detector funnels through (via the DbAdapter), so
  // reading the in-memory active id here links laps to a tuning session
  // independent of race sessionId — a tuning session can span many race
  // sessions. Cheap, unconditional on game; null when no session is active.
  const activeExperimentId = getActiveExperiment();
  const activeExperimentVersionId =
    activeExperimentId != null ? await resolveActiveTestId(activeExperimentId) : null;
  return db.transaction(async (tx) => {
    const session = await tx.select({
      nativeCaptureOrigin: sessions.nativeCaptureOrigin, originalSourceRevision: sessions.originalSourceRevision,
      originalActivityId: sessions.originalActivityId, ownerUserId: sessions.ownerUserId,
      gameId: sessions.gameId, trackId: sessions.trackId, carId: sessions.carId,
      recordingOrigin: sessions.recordingOrigin, recordingInstallationId: sessions.recordingInstallationId,
    }).from(sessions).where(eq(sessions.id, sessionId)).get();
    if (!session) throw new Error(`Session ${sessionId} does not exist`);
    const lapGuid = session.nativeCaptureOrigin ? createLapGuid() : null;
    const result = await tx
      .insert(laps)
      .values({
        sessionId,
        lapNumber,
        lapTime,
        isValid,
        rawByteOffset,
        rawFrameCount,
        sectorTimes: sectors,
        classification,
        profileId,
        tuneId,
        invalidReason,
        lapGuid,
        experimentId: activeExperimentId,
        experimentVersionId: activeExperimentVersionId,
        onlineEvaluatedAt: invalidReason === "incomplete" ? null : new Date().toISOString(),
        ...(driverAttribution ? {
          driverAttributionStints: [...driverAttribution.stints],
          driverAttribution: driverAttribution.attribution,
          sourceClockDomain: driverAttribution.source.domain,
          sourceLapStartMs: driverAttribution.source.startMs,
          sourceLapEndMs: driverAttribution.source.endMs,
        } : {}),
        ...versionIdentity,
      })
      .returning({ id: laps.id })
      .get();
    await tx.insert(lapGuidReconciliation).values({
      lapId: result.id,
      lapGuid,
      sourceGuid: null,
      status: lapGuid ? "resolved" : "held_ambiguous",
    }).run();
    if (lapGuid) await tx.insert(originalActivitySourceLaps).values({
      lapGuid, originalActivityId: session.originalActivityId, ownerUserId: session.ownerUserId, sourceRevision: session.originalSourceRevision,
    }).run();
    const lapTimeMs = Math.round(lapTime * 1000);
    if (invalidReason !== "incomplete" && isValid && Number.isSafeInteger(lapTimeMs) && lapTimeMs > 0 &&
        session.recordingOrigin === "native_capture" && session.recordingInstallationId === getRecordingInstallationId() &&
        session.gameId !== "" && session.trackId !== "" && session.trackId !== "-1" && session.carId !== "" && session.carId !== "-1" &&
        driverAttribution?.attribution === "Self" &&
        isWholeLapSelf(driverAttribution.stints, driverAttribution.source.startMs, driverAttribution.source.endMs, driverAttribution.source.domain)) {
      await tx.run(fastestLapUpsert(session.gameId, session.trackId, session.carId, result.id, lapTimeMs));
    }
    return result.id;
  });
}

/** Complete the exact retained provisional row; never delete, remint, or infer a GUID. */
export async function updateCapturedLap(
  lapId: number, sessionId: number, lapNumber: number, lapTime: number, isValid: boolean,
  rawByteOffset: number | null, rawFrameCount: number, profileId: number | null,
  tuneId: number | null, invalidReason: string | null, sectors: number[] | null,
  classification: LapClassification | null,
  versionIdentity?: TelemetryVersionIdentity,
  driverAttribution?: { stints: readonly DriverAttributionStint[]; attribution: LapDriverAttribution; source: { domain: string; startMs: number; endMs: number } },
): Promise<number> {
  let updatedLap = false;
  await withDatabaseWrite(() => db.transaction(async (tx) => {
    const previous = await tx.select({
      sessionId: laps.sessionId, lapNumber: laps.lapNumber, rawByteOffset: laps.rawByteOffset,
      rawFrameCount: laps.rawFrameCount, isValid: laps.isValid, onlineEvaluatedAt: laps.onlineEvaluatedAt,
      lapTime: laps.lapTime, invalidReason: laps.invalidReason, driverAttribution: laps.driverAttribution,
      driverAttributionStints: laps.driverAttributionStints, sourceClockDomain: laps.sourceClockDomain,
      sourceLapStartMs: laps.sourceLapStartMs, sourceLapEndMs: laps.sourceLapEndMs,
    }).from(laps).where(eq(laps.id, lapId)).get();
    const session = await tx.select({
      gameId: sessions.gameId, trackId: sessions.trackId, carId: sessions.carId,
      recordingOrigin: sessions.recordingOrigin, recordingInstallationId: sessions.recordingInstallationId,
    }).from(sessions).where(eq(sessions.id, sessionId)).get();
    if (!session) throw new Error(`Session ${sessionId} does not exist`);
    if (!previous || previous.sessionId !== sessionId || previous.lapNumber !== lapNumber ||
        previous.rawByteOffset !== rawByteOffset || rawFrameCount < (previous.rawFrameCount ?? 0)) throw new Error("Provisional lap source window changed");
    if (previous.onlineEvaluatedAt !== null) {
      if (previous.rawFrameCount !== rawFrameCount || previous.lapTime !== lapTime ||
          previous.invalidReason !== invalidReason || previous.isValid !== isValid ||
          previous.driverAttribution !== (driverAttribution?.attribution ?? "Unknown") ||
          !isDeepStrictEqual(previous.driverAttributionStints, driverAttribution ? [...driverAttribution.stints] : null) ||
          previous.sourceClockDomain !== (driverAttribution?.source.domain ?? null) ||
          previous.sourceLapStartMs !== (driverAttribution?.source.startMs ?? null) ||
          previous.sourceLapEndMs !== (driverAttribution?.source.endMs ?? null)) throw new Error("Finalized lap source window changed");
      return;
    }
    updatedLap = true;
    const updated = await tx.update(laps).set({
      lapTime, isValid, rawByteOffset, rawFrameCount, profileId, tuneId, invalidReason, sectorTimes: sectors, classification,
      fuelPerLap: null, tyreWear: null, captureChunkId: null, sourceFrameStart: null, sourceFrameCount: null,
      onlineEvaluatedAt: previous.onlineEvaluatedAt ?? new Date().toISOString(),
      driverAttribution: driverAttribution?.attribution ?? "Unknown",
      driverAttributionStints: driverAttribution ? [...driverAttribution.stints] : null,
      sourceClockDomain: driverAttribution?.source.domain ?? null,
      sourceLapStartMs: driverAttribution?.source.startMs ?? null,
      sourceLapEndMs: driverAttribution?.source.endMs ?? null,
      ...versionIdentity,
    }).where(and(eq(laps.id, lapId), eq(laps.sessionId, sessionId), eq(laps.lapNumber, lapNumber),
      sql`${laps.rawByteOffset} IS ${rawByteOffset}`, eq(laps.isValid, false))).returning({ id: laps.id }).get();
    if (!updated) throw new Error("Provisional lap source window changed");
    const lapTimeMs = Math.round(lapTime * 1000);
    if (previous.onlineEvaluatedAt === null && isValid && Number.isSafeInteger(lapTimeMs) && lapTimeMs > 0 &&
        session.recordingOrigin === "native_capture" && session.recordingInstallationId === getRecordingInstallationId() &&
        session.gameId !== "" && session.trackId !== "" && session.trackId !== "-1" && session.carId !== "" && session.carId !== "-1" &&
        driverAttribution?.attribution === "Self" &&
        isWholeLapSelf(driverAttribution.stints, driverAttribution.source.startMs, driverAttribution.source.endMs, driverAttribution.source.domain)) {
      await tx.run(fastestLapUpsert(session.gameId, session.trackId, session.carId, lapId, lapTimeMs));
    }
    await tx.delete(lapMetrics).where(eq(lapMetrics.lapId, lapId));
    await tx.delete(lapAnalyses).where(eq(lapAnalyses.lapId, lapId));
    await tx.delete(compareAnalyses).where(or(eq(compareAnalyses.lapAId, lapId), eq(compareAnalyses.lapBId, lapId)));
  }));
  if (updatedLap) cacheDelete(lapId);
  return lapId;
}
export async function updateLapCarSetup(lapId: number, carSetup: object | null): Promise<void> {
  await withDatabaseWrite(() => db.update(laps).set({ carSetup: carSetup ? JSON.stringify(carSetup) : null }).where(eq(laps.id, lapId)).run());
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
  await withDatabaseWrite(() => db.update(laps).set({ fuelPerLap, tyreWear }).where(eq(laps.id, lapId)).run());
}


/** Delete one transient lap row without deleting its still-active parent session. */
export async function deleteLapOnly(id: number): Promise<void> {
  await withDatabaseWrite(() => db.delete(laps).where(eq(laps.id, id)).run());
  cacheDelete(id);
}

export async function deleteLap(id: number): Promise<boolean> {
  const visibility = sql`EXISTS (
    SELECT 1 FROM sessions s
    WHERE s.id = ${laps.sessionId}
      AND (s.ownership = 'mine' OR (s.ownership = 'others' AND s.cloud_import_origin IS NOT NULL))
  )`;
  const deleted = await withDatabaseWrite(() => db.transaction(async (tx) => {
    const lap = await tx.select({ sessionId: laps.sessionId }).from(laps)
      .where(and(eq(laps.id, id), visibility)).get();
    if (!lap) return false;
    const result = await tx.delete(laps).where(and(eq(laps.id, id), visibility)).returning().all();
    if (!result.length) return false;
    const remaining = await tx.select({ id: laps.id }).from(laps).where(eq(laps.sessionId, lap.sessionId)).limit(1).all();
    if (!remaining.length) await tx.delete(sessions).where(eq(sessions.id, lap.sessionId)).run();
    return true;
  }));
  if (deleted) cacheDelete(id);
  return deleted;
}
