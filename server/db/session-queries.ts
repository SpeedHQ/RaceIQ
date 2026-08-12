import { deleteLap } from "./lap-mutation-queries";
import { getLapById } from "./lap-read-queries";
import { eq, desc, and, or, sql, inArray, notInArray, isNull } from "drizzle-orm";
import { db } from "./index";
import { sessions, laps, sessionResults, pitEvents } from "./schema";
import type { SessionMeta, SessionOwnership } from "../../shared/racing/sessions/types";
import type { GameId } from "../../shared/games/ids";
import type { TelemetryVersionIdentity } from "../../shared/telemetry/version";
import { tryGetGame } from "../../shared/games/registry";
import { existsSync, unlinkSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { resolveDataDir } from "../runtime/config/data-dir";
import { getTrackLengthMeters } from "../../shared/racing/tracks/recording/outlines";
import type { RecapLapInput, RecapSessionInput } from "../lap-analysis/recap";

export async function insertSession(
  carOrdinal: number,
  trackOrdinal: number,
  gameId: GameId,
  sessionType?: string,
  versionIdentity?: TelemetryVersionIdentity,
  ownership?: SessionOwnership,
): Promise<number> {
  const result = await db
    .insert(sessions)
    .values({ carOrdinal, trackOrdinal, gameId, sessionType, ownership, ...versionIdentity })
    .returning({ id: sessions.id })
    .get();
  return result.id;
}

/**
 * Update session metadata (e.g. session type discovered after session start).
 */

export async function updateSession(
  id: number,
  updates: { sessionType?: string; notes?: string | null }
): Promise<void> {
  await db.update(sessions).set(updates).where(eq(sessions.id, id)).run();
}

export async function updateSessionCarTrack(sessionId: number, carOrdinal: number, trackOrdinal: number): Promise<void> {
  await db.update(sessions).set({ carOrdinal, trackOrdinal }).where(eq(sessions.id, sessionId)).run();
}


export async function updateSessionRawFile(
  sessionId: number,
  rawFile: string,
  lapDetectorVersion: string,
  versionIdentity?: TelemetryVersionIdentity,
): Promise<void> {
  await db
    .update(sessions)
    .set({ rawFile, lapDetectorVersion, ...versionIdentity })
    .where(eq(sessions.id, sessionId))
    .run();
}

/**
 * Aggregate lap stats scoped to an optional game. Uses SQL COUNT/SUM so
 * totals don't get capped by getLaps()'s 200-row limit — home-page game
 * cards and per-game pages now both report the full picture.
 */

export async function countStaleSessions(currentIds: string | string[]): Promise<number> {
  const ids = Array.isArray(currentIds) ? currentIds : [currentIds];
  const rows = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(
      and(
        sql`${sessions.rawFile} IS NOT NULL`,
        or(isNull(sessions.lapDetectorVersion), notInArray(sessions.lapDetectorVersion, ids))
      )
    )
    .all();
  return rows.length;
}

/**
 * Get IDs of sessions with stale lap detector version that have a raw file.
 */

export async function getStaleSessions(currentIds: string | string[]): Promise<number[]> {
  const ids = Array.isArray(currentIds) ? currentIds : [currentIds];
  const rows = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(
      and(
        sql`${sessions.rawFile} IS NOT NULL`,
        or(isNull(sessions.lapDetectorVersion), notInArray(sessions.lapDetectorVersion, ids))
      )
    )
    .all();
  return rows.map(r => r.id);
}

/**
 * Get sessions with uncompressed raw files (.bin) older than the given age in ms.
 */

export async function getUncompressedSessions(olderThanMs: number): Promise<{ id: number; rawFile: string }[]> {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  const rows = await db
    .select({ id: sessions.id, rawFile: sessions.rawFile })
    .from(sessions)
    .where(
      and(
        sql`${sessions.rawFile} IS NOT NULL`,
        sql`${sessions.rawFile} NOT LIKE '%.gz'`,
        sql`${sessions.createdAt} < ${cutoff}`
      )
    )
    .all();
  return rows.filter((r): r is { id: number; rawFile: string } => r.rawFile !== null);
}
function isOwnedSessionRawFile(rawFile: string): boolean {
  const sessionsDir = resolve(resolveDataDir(), "sessions");
  const relativePath = relative(sessionsDir, resolve(rawFile));
  return relativePath.length > 0 && relativePath !== ".." && !relativePath.startsWith(`..${sep}`);
}

async function unlinkOwnedSessionRawFile(rawFile: string | null): Promise<void> {
  if (!rawFile || !isOwnedSessionRawFile(rawFile)) return;
  const stillReferenced = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.rawFile, rawFile))
    .limit(1)
    .get();
  if (stillReferenced) return;
  try {
    if (existsSync(rawFile)) unlinkSync(rawFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}


/**
 * Delete a session and all its laps. Returns number of laps deleted.
 */

export async function deleteSession(sessionId: number): Promise<number> {
  const session = await db
    .select({ rawFile: sessions.rawFile })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .get();
  const sessionLaps = await db.select({ id: laps.id }).from(laps).where(eq(laps.sessionId, sessionId)).all();
  let count = 0;
  for (const lap of sessionLaps) {
    if (await deleteLap(lap.id)) count++;
  }
  await db.delete(sessions).where(eq(sessions.id, sessionId)).run();
  await unlinkOwnedSessionRawFile(session?.rawFile ?? null);
  return count;
}

/** Get all lap metadata needed to preserve rows during reprocessing. */

export async function deleteEmptySessions(activeSessionId?: number): Promise<number> {
  const empties = await db
    .select({ id: sessions.id, rawFile: sessions.rawFile })
    .from(sessions)
    .leftJoin(laps, eq(laps.sessionId, sessions.id))
    .groupBy(sessions.id)
    .having(sql`count(${laps.id}) = 0`)
    .all();
  const filtered = activeSessionId
    ? empties.filter((e) => e.id !== activeSessionId)
    : empties;
  if (filtered.length === 0) return 0;
  for (const { rawFile } of filtered) {
    if (!rawFile) continue;
    try {
      if (existsSync(rawFile)) unlinkSync(rawFile);
    } catch (err) {
      console.warn(`[DB] Failed to unlink raw file ${rawFile}:`, err instanceof Error ? err.message : err);
    }
  }
  const ids = filtered.map(r => r.id);
  await db.delete(sessions).where(inArray(sessions.id, ids)).run();
  return ids.length;
}

/**
 * Get all sessions with lap counts, newest first.
 */

export async function getSessions(gameId?: GameId): Promise<SessionMeta[]> {
  const query = db
    .select({
      id: sessions.id,
      carOrdinal: sessions.carOrdinal,
      trackOrdinal: sessions.trackOrdinal,
      createdAt: sessions.createdAt,
      gameId: sessions.gameId,
      sessionType: sessions.sessionType,
      notes: sessions.notes,
      source: sessions.source,
      catalogVersion: sessions.catalogVersion,
      catalogHash: sessions.catalogHash,
      catalogSchemaVersion: sessions.catalogSchemaVersion,
      parserVersion: sessions.parserVersion,
      resolverVersion: sessions.resolverVersion,
      derivationVersion: sessions.derivationVersion,
      ownership: sessions.ownership,
    })
    .from(sessions)
    .orderBy(desc(sessions.id));

  const rows = gameId
    ? await query.where(eq(sessions.gameId, gameId)).all()
    : await query.all();

  // Get lap counts and best lap per session
  const result: SessionMeta[] = [];
  for (const session of rows) {
    const lapRows = await db
      .select({ id: laps.id, lapTime: laps.lapTime, isValid: laps.isValid })
      .from(laps)
      .where(eq(laps.sessionId, session.id))
      .all();

    const validLaps = lapRows.filter((l) => l.isValid && l.lapTime > 0);
    const bestLapTime = validLaps.length > 0 ? Math.min(...validLaps.map((l) => l.lapTime)) : undefined;
    const normalizedSession = {
      ...session,
      sessionType: session.sessionType ?? undefined,
    };
    const resultRow = await db
      .select({
        id: sessionResults.id,
        classification: sessionResults.classification,
        finishingPosition: sessionResults.finishingPosition,
        qualifyingPosition: sessionResults.qualifyingPosition,
        isPodium: sessionResults.isPodium,
        isFastestLap: sessionResults.isFastestLap,
        pitCount: sessionResults.pitCount,
      })
      .from(sessionResults)
      .where(eq(sessionResults.sessionId, session.id))
      .get();
    const pitDurationRow = resultRow
      ? await db
        .select({ duration: sql<number | null>`sum(${pitEvents.durationSeconds})` })
        .from(pitEvents)
        .where(eq(pitEvents.resultId, resultRow.id))
        .get()
      : null;
    result.push({
      ...normalizedSession,
      lapCount: lapRows.length,
      bestLapTime,
      resultClassification: resultRow?.classification ?? null,
      finishingPosition: resultRow?.finishingPosition ?? null,
      qualifyingPosition: resultRow?.qualifyingPosition ?? null,
      isPodium: resultRow?.isPodium ?? null,
      isFastestLap: resultRow?.isFastestLap ?? null,
      pitCount: resultRow?.pitCount ?? null,
      pitDurationSeconds: pitDurationRow?.duration ?? null,
      notes: session.notes ?? undefined,
      source: session.source ?? undefined,
      gameId: session.gameId as GameId,
      catalogVersion: session.catalogVersion ?? undefined,
      catalogHash: session.catalogHash ?? undefined,
      catalogSchemaVersion: session.catalogSchemaVersion ?? undefined,
      parserVersion: session.parserVersion ?? undefined,
      resolverVersion: session.resolverVersion ?? undefined,
      derivationVersion: session.derivationVersion ?? undefined,
      ownership: session.ownership === "others" ? "others" : "mine",
    });
  }
  return result;
}

/**
 * Fetch-only data needed for a session recap: the session row, its laps, the
 * track's length (metres, null when no outline), and the best valid lap time
 * for the same track + car + game from every OTHER session. No math here —
 * see server/lap-analysis/recap.ts::computeRecap for the rules.
 *
 * Returns null when the session doesn't exist or its gameId doesn't match.
 */

export async function getSessionRecapData(
  id: number,
  gameId: GameId,
): Promise<{
  session: RecapSessionInput;
  laps: RecapLapInput[];
  trackLengthM: number | null;
  allTimeBestSec: number | null;
  allTimeBestSectors: Array<number | null> | null;
  sectorStarts: number[] | null;
} | null> {
  const sessionRow = await db
    .select({
      id: sessions.id,
      carOrdinal: sessions.carOrdinal,
      trackOrdinal: sessions.trackOrdinal,
      gameId: sessions.gameId,
      createdAt: sessions.createdAt,
      ownership: sessions.ownership,
    })
    .from(sessions)
    .where(eq(sessions.id, id))
    .get();

  if (!sessionRow || sessionRow.gameId !== gameId) return null;

  const lapRows = await db
    .select({
      id: laps.id,
      lapNumber: laps.lapNumber,
      lapTime: laps.lapTime,
      isValid: laps.isValid,
      sectorTimes: laps.sectorTimes,
      invalidReason: laps.invalidReason,
    })
    .from(laps)
    .where(eq(laps.sessionId, id))
    .orderBy(laps.lapNumber)
    .all();

  const trackLengthM = getTrackLengthMeters(sessionRow.trackOrdinal, gameId);
  const sessionSectorCount =
    lapRows.find(
      (lap) =>
        Boolean(lap.isValid) &&
        lap.sectorTimes != null &&
        lap.sectorTimes.length >= 2 &&
        lap.sectorTimes.every((time) => time > 0),
    )?.sectorTimes?.length ?? 0;

  let sectorStarts: number[] | null = null;
  const gameAdapter = tryGetGame(gameId);
  if (gameAdapter?.nativeSectors && gameAdapter.getNativeSectorLayout && sessionSectorCount >= 2) {
    for (const row of lapRows) {
      if (row.sectorTimes?.length !== sessionSectorCount) continue;
      const lap = await getLapById(row.id);
      const layout = lap?.telemetry
        .map((packet) => gameAdapter.getNativeSectorLayout!(packet))
        .find((candidate) => candidate?.starts.length === sessionSectorCount);
      if (layout) {
        sectorStarts = [...layout.starts];
        break;
      }
    }
  }

  const bestOtherRow = await db
    .select({ lapTime: laps.lapTime })
    .from(laps)
    .innerJoin(sessions, eq(laps.sessionId, sessions.id))
    .where(
      and(
        eq(sessions.trackOrdinal, sessionRow.trackOrdinal),
        eq(sessions.carOrdinal, sessionRow.carOrdinal),
        eq(sessions.gameId, gameId),
        sql`${sessions.id} != ${id}`,
        eq(laps.isValid, true),
        sql`${laps.lapTime} > 0`,
      ),
    )
    .orderBy(laps.lapTime)
    .limit(1)
    .get();

  const otherSectorRows = await db
    .select({ sectorTimes: laps.sectorTimes })
    .from(laps)
    .innerJoin(sessions, eq(laps.sessionId, sessions.id))
    .where(
      and(
        eq(sessions.trackOrdinal, sessionRow.trackOrdinal),
        eq(sessions.carOrdinal, sessionRow.carOrdinal),
        eq(sessions.gameId, gameId),
        sql`${sessions.id} != ${id}`,
        eq(laps.isValid, true),
        sql`${laps.lapTime} > 0`,
        sql`${laps.sectorTimes} IS NOT NULL`,
      ),
    )
    .all();
  const allTimeBestSectors = otherSectorRows.reduce<Array<number | null>>(
    (best, row) => {
      if (row.sectorTimes?.length !== sessionSectorCount) return best;
      for (let index = 0; index < (row.sectorTimes?.length ?? 0); index++) {
        const time = row.sectorTimes![index];
        if (time > 0 && (best[index] === undefined || best[index] === null || time < best[index]!)) {
          best[index] = time;
        }
      }
      return best;
    },
    [],
  );

  return {
    session: {
      id: sessionRow.id,
      carOrdinal: sessionRow.carOrdinal,
      trackOrdinal: sessionRow.trackOrdinal,
      gameId: sessionRow.gameId as GameId,
      createdAt: sessionRow.createdAt,
      ownership: sessionRow.ownership === "others" ? "others" : "mine",
    },
    laps: lapRows.map((l) => ({ ...l, isValid: Boolean(l.isValid) })),
    trackLengthM,
    allTimeBestSec: bestOtherRow?.lapTime ?? null,
    allTimeBestSectors:
      allTimeBestSectors.length > 0 ? allTimeBestSectors : null,
    sectorStarts,
  };
}
