import { cacheDelete } from "./telemetry-replay-storage";
import { and, eq, or, sql } from "drizzle-orm";
import { db } from "./index";
import { sessions, laps, lapGuidReconciliation, originalActivitySourceLaps, lapMetrics, lapAnalyses, compareAnalyses } from "./schema";
import { createLapGuid } from "./lap-guid";
import type { TelemetryVersionIdentity } from "@raceiq/shared/telemetry/version";
import { getActiveExperiment } from "../experiments/active";
import { resolveActiveTestId } from "./experiment-version-queries";

export async function updateLapNotes(id: number, notes: string | null): Promise<void> {
  await db.update(laps).set({ notes }).where(eq(laps.id, id)).run();
}


export async function updateLapValidity(id: number, isValid: boolean, invalidReason: string | null, sectors?: number[] | null): Promise<void> {
  const values: Record<string, unknown> = { isValid, invalidReason };
  if (sectors !== undefined) {
    values.sectorTimes = sectors;
  }
  await db.update(laps).set(values).where(eq(laps.id, id)).run();
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
  versionIdentity?: TelemetryVersionIdentity,
): Promise<number> {
  return doInsertLap(sessionId, lapNumber, lapTime, isValid, rawByteOffset, rawFrameCount, profileId, tuneId, invalidReason, sectors, versionIdentity);
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
  sectors: number[] | null = null,
  versionIdentity?: TelemetryVersionIdentity,
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
    const session = await tx.select({ nativeCaptureOrigin: sessions.nativeCaptureOrigin, originalSourceRevision: sessions.originalSourceRevision,
      originalActivityId: sessions.originalActivityId, ownerUserId: sessions.ownerUserId })
      .from(sessions).where(eq(sessions.id, sessionId)).get();
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
        profileId,
        tuneId,
        invalidReason,
        lapGuid,
        experimentId: activeExperimentId,
        experimentVersionId: activeExperimentVersionId,
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
    return result.id;
  });
}

/** Complete the exact retained provisional row; never delete, remint, or infer a GUID. */
export async function updateCapturedLap(
  lapId: number, sessionId: number, lapNumber: number, lapTime: number, isValid: boolean,
  rawByteOffset: number | null, rawFrameCount: number, profileId: number | null,
  tuneId: number | null, invalidReason: string | null, sectors: number[] | null,
  versionIdentity?: TelemetryVersionIdentity,
): Promise<number> {
  await db.transaction(async (tx) => {
    const previous = await tx.select({ sessionId: laps.sessionId, lapNumber: laps.lapNumber,
      rawByteOffset: laps.rawByteOffset, rawFrameCount: laps.rawFrameCount, isValid: laps.isValid })
      .from(laps).where(eq(laps.id, lapId)).get();
    if (!previous || previous.sessionId !== sessionId || previous.lapNumber !== lapNumber ||
        previous.rawByteOffset !== rawByteOffset || previous.isValid ||
        rawFrameCount < (previous.rawFrameCount ?? 0)) throw new Error("Provisional lap source window changed");
    const updated = await tx.update(laps).set({
      lapTime, isValid, rawByteOffset, rawFrameCount, profileId, tuneId, invalidReason, sectorTimes: sectors,
      fuelPerLap: null, tyreWear: null, captureChunkId: null, sourceFrameStart: null, sourceFrameCount: null,
      driverAttribution: "Unknown", driverAttributionStints: null,
      sourceClockDomain: null, sourceLapStartMs: null, sourceLapEndMs: null, ...versionIdentity,
    }).where(and(eq(laps.id, lapId), eq(laps.sessionId, sessionId), eq(laps.lapNumber, lapNumber),
      sql`${laps.rawByteOffset} IS ${rawByteOffset}`, eq(laps.isValid, false))).returning({ id: laps.id }).get();
    if (!updated) throw new Error("Provisional lap source window changed");
    await tx.delete(lapMetrics).where(eq(lapMetrics.lapId, lapId));
    await tx.delete(lapAnalyses).where(eq(lapAnalyses.lapId, lapId));
    await tx.delete(compareAnalyses).where(or(eq(compareAnalyses.lapAId, lapId), eq(compareAnalyses.lapBId, lapId)));
  });
  cacheDelete(lapId);
  return lapId;
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


/** Delete one transient lap row without deleting its still-active parent session. */
export async function deleteLapOnly(id: number): Promise<void> {
  await db.delete(laps).where(eq(laps.id, id)).run();
  cacheDelete(id);
}

export async function deleteLap(id: number): Promise<boolean> {
  const visibility = sql`EXISTS (
    SELECT 1 FROM sessions s
    WHERE s.id = ${laps.sessionId}
      AND (s.ownership = 'mine' OR (s.ownership = 'others' AND s.cloud_import_origin IS NOT NULL))
  )`;
  const lap = await db.select({ sessionId: laps.sessionId }).from(laps)
    .where(and(eq(laps.id, id), visibility)).get();
  if (!lap) return false;
  const result = await db.delete(laps).where(and(eq(laps.id, id), visibility)).returning().all();
  if (result.length > 0) {
    cacheDelete(id);
    const remaining = await db.select({ id: laps.id }).from(laps).where(eq(laps.sessionId, lap.sessionId)).limit(1).all();
    if (remaining.length === 0) await db.delete(sessions).where(eq(sessions.id, lap.sessionId)).run();
  }
  return result.length > 0;
}
