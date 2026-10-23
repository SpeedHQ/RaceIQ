import { and, desc, eq, sql } from "drizzle-orm";
import type { GameId } from "@raceiq/shared/games/ids";
import type { LapMeta } from "@raceiq/shared/racing/sessions/types";
import { db } from "@raceiq/backend-core/db/index";
import { laps, sessions, tunes } from "@raceiq/backend-core/db/schema";
import { toLapMeta } from "@raceiq/backend-core/db/lap-meta";
import { paceLapCondition } from "@raceiq/backend-core/db/lap-eligibility";

/** Top eligible review laps, SQL-ranked and limited before serialization. */
export async function getReviewLaps(
  gameId: GameId,
  trackId: string | null,
  carId: string | null,
  limit = 5,
  sessionId?: number,
): Promise<LapMeta[]> {
  const filters = [eq(sessions.gameId, gameId), eq(laps.isValid, true), paceLapCondition(), sql`${laps.lapTime} > 0`, sql`${sessions.rawFile} IS NOT NULL`];
  if (sessionId != null) filters.push(eq(laps.sessionId, sessionId));
  else {
    if (trackId != null) filters.push(eq(sessions.trackId, trackId));
    if (carId != null) filters.push(eq(sessions.carId, carId));
  }
  const rows = await db.select({
    id: laps.id, sessionId: laps.sessionId, lapNumber: laps.lapNumber, lapTime: laps.lapTime,
    isValid: laps.isValid, classification: laps.classification, invalidReason: laps.invalidReason,
    notes: laps.notes, createdAt: laps.createdAt, pi: laps.pi, carSetup: laps.carSetup,
    tuneId: laps.tuneId, tuneName: tunes.name, carId: sessions.carId, trackId: sessions.trackId,
    gameId: sessions.gameId, sectorTimes: laps.sectorTimes, isFavorite: laps.isFavorite,
    rawByteOffset: laps.rawByteOffset, rawFrameCount: laps.rawFrameCount, rawFile: sessions.rawFile,
    ownership: sessions.ownership, source: sessions.source, experimentId: laps.experimentId,
    experimentVersionId: laps.experimentVersionId, experimentExcluded: laps.experimentExcluded,
    experimentExcludedSource: laps.experimentExcludedSource, fuelPerLap: laps.fuelPerLap,
    tyreWear: laps.tyreWear, catalogVersion: laps.catalogVersion, catalogHash: laps.catalogHash,
    catalogSchemaVersion: laps.catalogSchemaVersion, parserVersion: laps.parserVersion,
    resolverVersion: laps.resolverVersion, derivationVersion: laps.derivationVersion,
    standaloneCaptureReady: sql<boolean>`(${sessions.captureLayoutVersion} IS NULL AND ${sessions.rawFile} IS NOT NULL) OR (${sessions.captureLayoutVersion} = 1 AND ${sessions.captureManifestFile} IS NOT NULL AND ${laps.captureChunkId} IS NOT NULL) OR (${sessions.captureLayoutVersion} = 2 AND ${sessions.captureManifestFile} IS NOT NULL AND ${sessions.captureArchiveFile} IS NOT NULL AND ${laps.captureChunkId} IS NOT NULL) OR (${sessions.captureLayoutVersion} = 3 AND ${laps.captureChunkId} IS NOT NULL AND EXISTS (SELECT 1 FROM live_capture_members m JOIN live_captures c ON c.capture_epoch = m.capture_epoch WHERE m.lap_id = ${laps.id} AND c.session_id = ${sessions.id} AND json_extract(m.descriptor, '$.id') = ${laps.captureChunkId}))`,
  }).from(laps).innerJoin(sessions, eq(laps.sessionId, sessions.id)).leftJoin(tunes, eq(laps.tuneId, tunes.id))
    .where(and(...filters)).orderBy(laps.lapTime, desc(laps.id)).limit(Math.max(1, Math.min(limit, 20))).all();
  return rows.map(toLapMeta);
}
