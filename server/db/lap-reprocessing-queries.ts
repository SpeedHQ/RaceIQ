import { cacheDelete } from "./telemetry-replay-storage";
import { eq, and, notInArray } from "drizzle-orm";
import { db } from "./index";
import { laps } from "./schema";
import type { TelemetryVersionIdentity } from "../../shared/telemetry/version";

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function getLapsForSession(sessionId: number): Promise<Array<{
  id: number; lapNumber: number; lapTime: number; isValid: boolean;
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
  return rows.map(r => ({ ...r, isValid: Boolean(r.isValid) }));
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
  transaction?: DbTransaction,
): Promise<void> {
  const executor = transaction ?? db;
  cacheDelete(lapId);
  await executor.update(laps).set({
    rawByteOffset,
    rawFrameCount,
    lapTime,
    isValid,
    invalidReason,
    sectorTimes: sectors,
    ...versionIdentity,
  }).where(eq(laps.id, lapId));
}

/** Insert a detected replacement while preserving matched row metadata. */

export async function insertReprocessedLap(
  sessionId: number,
  lapNumber: number,
  lapTime: number,
  isValid: boolean,
  rawByteOffset: number | null,
  rawFrameCount: number,
  tuneId: number | null,
  notes: string | null,
  invalidReason: string | null,
  sectors: number[] | null,
  versionIdentity?: TelemetryVersionIdentity,
  transaction?: DbTransaction,
): Promise<number> {
  const executor = transaction ?? db;
  const result = await executor.insert(laps).values({
    sessionId, lapNumber, lapTime, isValid,
    rawByteOffset, rawFrameCount,
    tuneId, notes, invalidReason,
    sectorTimes: sectors,
    ...versionIdentity,
  }).returning({ id: laps.id }).get();
  return result.id;
}

/** Delete replaceable laps while retaining explicitly archived fallback rows. */

export async function deleteLapsForSession(
  sessionId: number,
  preserveLapIds: readonly number[] = [],
  transaction?: DbTransaction,
): Promise<void> {
  const executor = transaction ?? db;
  const rows = await executor
    .select({ id: laps.id })
    .from(laps)
    .where(eq(laps.sessionId, sessionId))
    .all();
  const preserved = new Set(preserveLapIds);
  const deletedIds = rows
    .map(({ id }) => id)
    .filter((id) => !preserved.has(id));
  for (const id of deletedIds) cacheDelete(id);
  if (deletedIds.length === 0) return;
  if (preserveLapIds.length === 0) {
    await executor.delete(laps).where(eq(laps.sessionId, sessionId));
    return;
  }
  await executor.delete(laps).where(
    and(
      eq(laps.sessionId, sessionId),
      notInArray(laps.id, [
        preserveLapIds[0]!,
        ...preserveLapIds.slice(1),
      ]),
    ),
  );
}
