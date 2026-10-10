import { cacheDelete } from "./telemetry-replay-storage";
import { eq } from "drizzle-orm";
import { db } from "./index";
import { laps, sessions } from "./schema";
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

/** Replace lap rows atomically; cache invalidation follows successful commit. */
export async function replaceLapsForSession(
  sessionId: number,
  replacements: ReadonlyArray<{
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
  sessionIdentity?: { carOrdinal: number; trackOrdinal: number; identity?: { carId?: string | null; trackId?: string | null } },
): Promise<void> {
  const deletedIds = await db.transaction(async (tx) => {
    const rows = await tx.select({ id: laps.id }).from(laps).where(eq(laps.sessionId, sessionId)).all();
    const deleted = rows.map(({ id }) => id);
    if (deleted.length > 0) await tx.delete(laps).where(eq(laps.sessionId, sessionId));
    for (const replacement of replacements) {
      await tx.insert(laps).values({
        sessionId,
        lapNumber: replacement.lapNumber,
        lapTime: replacement.lapTime,
        isValid: replacement.isValid,
        isFavorite: replacement.isFavorite,
        rawByteOffset: replacement.rawByteOffset,
        rawFrameCount: replacement.rawFrameCount,
        tuneId: replacement.tuneId,
        notes: replacement.notes,
        invalidReason: replacement.invalidReason,
        sectorTimes: replacement.sectors,
        ...replacement.versionIdentity,
      });
    }
    if (sessionIdentity) {
      await tx.update(sessions).set({
        carOrdinal: sessionIdentity.carOrdinal,
        trackOrdinal: sessionIdentity.trackOrdinal,
        ...sessionIdentity.identity,
      }).where(eq(sessions.id, sessionId));
    }
    return deleted;
  });
  for (const id of deletedIds) cacheDelete(id);
}


