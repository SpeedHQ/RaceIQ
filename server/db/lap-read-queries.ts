import { cacheGet, cacheSet, LapParseError, parseRawLapFrames, parseSessionLapsBatched } from "./telemetry-replay-storage";
import { toLapMeta } from "./lap-meta";
import { eq, desc, and, or, sql, inArray } from "drizzle-orm";
import { db } from "./index";
import { sessions, laps, tunes } from "./schema";
import type { TelemetryPacket } from "../../shared/telemetry/types";
import type { LapMeta } from "../../shared/racing/sessions/types";
import type { GameId } from "../../shared/games/ids";

interface LapStats {
  totalLaps: number;
  validLaps: number;
  totalTimeSec: number;
  uniqueCars: number;
  uniqueTracks: number;
  lapsByTrack: { trackOrdinal: number; count: number }[];
}


export async function getLapStats(gameId?: GameId): Promise<LapStats> {
  const owned = sql`COALESCE(sessions.ownership, 'mine') = 'mine'`;
  const whereClause = gameId ? sql`WHERE sessions.game_id = ${gameId} AND ${owned}` : sql`WHERE ${owned}`;
  const whereClauseByTrack = gameId
    ? sql`WHERE sessions.game_id = ${gameId} AND ${owned} AND laps.lap_time > 0 AND sessions.track_ordinal IS NOT NULL`
    : sql`WHERE ${owned} AND laps.lap_time > 0 AND sessions.track_ordinal IS NOT NULL`;

  const totals = await db.all<{
    totalLaps: number;
    validLaps: number;
    totalTimeSec: number;
    uniqueCars: number;
    uniqueTracks: number;
  }>(sql`
    SELECT
      COUNT(*) as totalLaps,
      SUM(CASE WHEN laps.is_valid AND laps.lap_time > 0 THEN 1 ELSE 0 END) as validLaps,
      COALESCE(SUM(CASE WHEN laps.lap_time > 0 THEN laps.lap_time ELSE 0 END), 0) as totalTimeSec,
      COUNT(DISTINCT sessions.car_ordinal) as uniqueCars,
      COUNT(DISTINCT sessions.track_ordinal) as uniqueTracks
    FROM laps
    INNER JOIN sessions ON laps.session_id = sessions.id
    ${whereClause}
  `);

  const byTrack = await db.all<{ trackOrdinal: number; count: number }>(sql`
    SELECT sessions.track_ordinal as trackOrdinal, COUNT(*) as count
    FROM laps
    INNER JOIN sessions ON laps.session_id = sessions.id
    ${whereClauseByTrack}
    GROUP BY sessions.track_ordinal
  `);

  const row = totals[0] ?? { totalLaps: 0, validLaps: 0, totalTimeSec: 0, uniqueCars: 0, uniqueTracks: 0 };
  return {
    totalLaps: Number(row.totalLaps),
    validLaps: Number(row.validLaps),
    totalTimeSec: Number(row.totalTimeSec),
    uniqueCars: Number(row.uniqueCars),
    uniqueTracks: Number(row.uniqueTracks),
    lapsByTrack: byTrack.map((r) => ({ trackOrdinal: r.trackOrdinal, count: Number(r.count) })),
  };
}

/**
 * Get all laps with session metadata, newest first.
 * Optionally filter by profileId.
 */

export async function getLaps(gameId?: GameId, limit: number = 200): Promise<LapMeta[]> {
  const query = db
    .select({
      id: laps.id,
      sessionId: laps.sessionId,
      lapNumber: laps.lapNumber,
      lapTime: laps.lapTime,
      isValid: laps.isValid,
      invalidReason: laps.invalidReason,
      notes: laps.notes,
      pi: laps.pi,
      carSetup: laps.carSetup,
      createdAt: laps.createdAt,
      carOrdinal: sessions.carOrdinal,
      trackOrdinal: sessions.trackOrdinal,
      tuneId: laps.tuneId,
      tuneName: tunes.name,
      gameId: sessions.gameId,
      sectorTimes: laps.sectorTimes,
      ownership: sessions.ownership,
      source: sessions.source,
      experimentId: laps.experimentId,
      experimentVersionId: laps.experimentVersionId,
      experimentExcluded: laps.experimentExcluded,
      experimentExcludedSource: laps.experimentExcludedSource,
      fuelPerLap: laps.fuelPerLap,
      tyreWear: laps.tyreWear,
      catalogVersion: laps.catalogVersion,
      catalogHash: laps.catalogHash,
      catalogSchemaVersion: laps.catalogSchemaVersion,
      parserVersion: laps.parserVersion,
      resolverVersion: laps.resolverVersion,
      derivationVersion: laps.derivationVersion,
    })
    .from(laps)
    .innerJoin(sessions, eq(laps.sessionId, sessions.id))
    .leftJoin(tunes, eq(laps.tuneId, tunes.id))
    .orderBy(desc(laps.id))
    .limit(limit);

  const rows = gameId
    ? await query.where(eq(sessions.gameId, gameId)).all()
    : await query.all();

  return rows.map(toLapMeta);
}

/**
 * Every lap in a driver-profile scope, newest first — deliberately unlimited.
 *
 * The car/track predicate is pushed into SQL rather than applied to a capped
 * `getLaps()` page: filtering after a LIMIT silently truncates a deep history,
 * so a "global" profile would quietly stop being global once the driver had
 * more laps than the page size. These are metadata rows only (no telemetry
 * decode), so the scan is cheap; the expensive per-lap frame decode is bounded
 * separately by MAX_PROFILE_LAPS in driver-profile-aggregate.ts.
 */
export async function getLapMetaForProfileScope(gameId: GameId, carOrdinal?: number, trackOrdinal?: number): Promise<LapMeta[]> {
  const filters = [eq(sessions.gameId, gameId), sql`COALESCE(${sessions.ownership}, 'mine') = 'mine'`];
  if (carOrdinal != null) filters.push(eq(sessions.carOrdinal, carOrdinal));
  if (trackOrdinal != null) filters.push(eq(sessions.trackOrdinal, trackOrdinal));

  const rows = await db
    .select({
      id: laps.id,
      sessionId: laps.sessionId,
      lapNumber: laps.lapNumber,
      lapTime: laps.lapTime,
      isValid: laps.isValid,
      invalidReason: laps.invalidReason,
      notes: laps.notes,
      pi: laps.pi,
      carSetup: laps.carSetup,
      createdAt: laps.createdAt,
      carOrdinal: sessions.carOrdinal,
      trackOrdinal: sessions.trackOrdinal,
      tuneId: laps.tuneId,
      tuneName: tunes.name,
      gameId: sessions.gameId,
      sectorTimes: laps.sectorTimes,
      ownership: sessions.ownership,
      source: sessions.source,
      experimentId: laps.experimentId,
      experimentVersionId: laps.experimentVersionId,
      experimentExcluded: laps.experimentExcluded,
      experimentExcludedSource: laps.experimentExcludedSource,
      fuelPerLap: laps.fuelPerLap,
      tyreWear: laps.tyreWear,
    })
    .from(laps)
    .innerJoin(sessions, eq(laps.sessionId, sessions.id))
    .leftJoin(tunes, eq(laps.tuneId, tunes.id))
    .where(and(...filters))
    .orderBy(desc(laps.id))
    .all();

  return rows.map(toLapMeta);
}

/**
 * Laps explicitly linked to a tuning session (migration v25), newest-first.
 * Joined to sessions for car/track/game exactly like getLaps. This is the
 * authoritative membership query — it replaces the old created-at time-window
 * heuristic, so a tuning session correctly gathers its laps across ANY number
 * of race sessions (multiple stints) and never over-includes unrelated laps.
 *
 * Laps recorded before v25 (or while no tuning session was active) have
 * experiment_id = NULL and are therefore excluded — the link is opt-in
 * going forward.
 */

type LapSummary = {
  lapId: number;
  lapNumber: number;
  lapTime: number;
  carOrdinal: number;
  pi: number;
  gameId: GameId;
  sessionId: number;
  createdAt: string;
  sectorTimes: number[] | null;
  isValid: boolean;
  invalidReason: string | null;
  notes: string | null;
};


export async function getLapSummariesByTrack(trackOrdinal: number, gameId?: GameId): Promise<LapSummary[]> {
  const query = db
    .select({
      lapId: laps.id,
      lapNumber: laps.lapNumber,
      lapTime: laps.lapTime,
      carOrdinal: sessions.carOrdinal,
      pi: laps.pi,
      gameId: sessions.gameId,
      sessionId: laps.sessionId,
      createdAt: laps.createdAt,
      sectorTimes: laps.sectorTimes,
      isValid: laps.isValid,
      invalidReason: laps.invalidReason,
      notes: laps.notes,
    })
    .from(laps)
    .innerJoin(sessions, eq(laps.sessionId, sessions.id))
    .where(
      gameId
        ? and(eq(sessions.trackOrdinal, trackOrdinal), eq(sessions.gameId, gameId))
        : eq(sessions.trackOrdinal, trackOrdinal)
    )
    .orderBy(desc(laps.id));

  const rows = await query.all();
  return rows
    .filter(r => (r.lapTime ?? 0) > 0)
    .map(r => ({
      lapId: r.lapId,
      lapNumber: r.lapNumber ?? 0,
      lapTime: r.lapTime,
      carOrdinal: r.carOrdinal ?? 0,
      pi: r.pi ?? 0,
      gameId: r.gameId as GameId,
      sessionId: r.sessionId,
      createdAt: r.createdAt,
      sectorTimes: r.sectorTimes ?? null,
      isValid: Boolean(r.isValid),
      invalidReason: r.invalidReason ?? null,
      notes: r.notes ?? null,
    }));
}

export async function getLapById(
  id: number
): Promise<(LapMeta & { telemetry: TelemetryPacket[]; parseError?: string }) | null> {
  const row = await db
    .select({
      id: laps.id,
      sessionId: laps.sessionId,
      lapNumber: laps.lapNumber,
      lapTime: laps.lapTime,
      isValid: laps.isValid,
      createdAt: laps.createdAt,
      rawByteOffset: laps.rawByteOffset,
      rawFrameCount: laps.rawFrameCount,
      rawFile: sessions.rawFile,
      carOrdinal: sessions.carOrdinal,
      trackOrdinal: sessions.trackOrdinal,
      tuneId: laps.tuneId,
      tuneName: tunes.name,
      gameId: sessions.gameId,
      ownership: sessions.ownership,
      carSetup: laps.carSetup,
      sectorTimes: laps.sectorTimes,
      catalogVersion: laps.catalogVersion,
      catalogHash: laps.catalogHash,
      catalogSchemaVersion: laps.catalogSchemaVersion,
      parserVersion: laps.parserVersion,
      resolverVersion: laps.resolverVersion,
      derivationVersion: laps.derivationVersion,
    })
    .from(laps)
    .innerJoin(sessions, eq(laps.sessionId, sessions.id))
    .leftJoin(tunes, eq(laps.tuneId, tunes.id))
    .where(eq(laps.id, id))
    .get();

  if (!row) return null;
  const cached = cacheGet(id);

  if (cached) {
    return buildLapResult(row, cached);
  }
  let telemetry: TelemetryPacket[] = [];
  let parseError: string | undefined;
  const rawFile = row.rawFile;
  const rawByteOffset = row.rawByteOffset;
  const rawFrameCount = row.rawFrameCount;
  const shouldParseRaw =
    rawFile != null &&
    rawByteOffset != null &&
    rawFrameCount != null;
  if (shouldParseRaw) {
    try {
      telemetry = await parseRawLapFrames(
        rawFile,
        rawByteOffset,
        rawFrameCount,
        row.gameId as GameId,
      );
    } catch (err) {
      if (err instanceof LapParseError) {
        console.error(`[DB] Lap ${id} parse failed (${err.details.reason}): ${err.message}`, err.details);
        parseError = err.message;
      } else {
        console.error(`[DB] Failed to parse raw frames for lap ${id}:`, err);
        parseError = err instanceof Error ? err.message : String(err);
      }
    }
  }
  // Only cache successful, non-empty parses. Empty/errored results are
  // transient (often caused by a bug that gets fixed, or a buffer-flush
  // race) and caching them would require a server restart to recover.
  if (telemetry.length > 0) cacheSet(id, telemetry);
  const result = buildLapResult(row, telemetry);
  if (parseError) return { ...result, parseError };
  return result;
}

type LapResultRow = {
  id: number;
  sessionId: number;
  lapNumber: number;
  lapTime: number;
  isValid: number | boolean;
  createdAt: string;
  carOrdinal: number;
  trackOrdinal: number;
  tuneId: number | null;
  tuneName: string | null;
  gameId: string;
  carSetup: string | null;
  sectorTimes: number[] | null;
  catalogVersion: string | null;
  catalogHash: string | null;
  catalogSchemaVersion: string | null;
  ownership: string | null;
  resolverVersion: string | null;
  derivationVersion: string | null;
  rawFile?: string | null;
};

function buildLapResult(
  row: LapResultRow,
  telemetry: TelemetryPacket[]
): LapMeta & { telemetry: TelemetryPacket[] } {
  return {
    id: row.id,
    sessionId: row.sessionId,
    lapNumber: row.lapNumber,
    lapTime: row.lapTime,
    isValid: Boolean(row.isValid),
    createdAt: row.createdAt,
    carOrdinal: row.carOrdinal,
    ownership: row.ownership === "others" ? "others" : "mine",
    tuneId: row.tuneId ?? undefined,
    tuneName: row.tuneName ?? undefined,
    gameId: row.gameId as GameId,
    carSetup: row.carSetup ?? undefined,
    sectorTimes: row.sectorTimes ?? undefined,
    catalogVersion: row.catalogVersion ?? undefined,
    catalogHash: row.catalogHash ?? undefined,
    catalogSchemaVersion: row.catalogSchemaVersion ?? undefined,
    parserVersion: row.parserVersion ?? undefined,
    resolverVersion: row.resolverVersion ?? undefined,
    derivationVersion: row.derivationVersion ?? undefined,
    telemetry,
  };
}


/**
 * Load several laps' telemetry at once, decoding each session's laps in a single
 * forward pass (parseSessionLapsBatched) instead of one re-warming parse per lap.
 * Serves telemetryCache hits directly and populates the cache for every lap it
 * decodes — so callers that later re-request a lap individually (e.g. the client
 * /api/laps/:id fetches) hit warm cache. Returns results in the requested id
 * order. Laps the batch pass can't resolve fall back to getLapById.
 */

export async function getLapsByIds(
  ids: number[]
): Promise<(LapMeta & { telemetry: TelemetryPacket[]; parseError?: string })[]> {
  if (ids.length === 0) return [];

  const rows = await db
    .select({
      id: laps.id,
      sessionId: laps.sessionId,
      lapNumber: laps.lapNumber,
      lapTime: laps.lapTime,
      isValid: laps.isValid,
      createdAt: laps.createdAt,
      rawByteOffset: laps.rawByteOffset,
      rawFrameCount: laps.rawFrameCount,
      rawFile: sessions.rawFile,
      carOrdinal: sessions.carOrdinal,
      trackOrdinal: sessions.trackOrdinal,
      tuneId: laps.tuneId,
      tuneName: tunes.name,
      gameId: sessions.gameId,
      ownership: sessions.ownership,
      carSetup: laps.carSetup,
      sectorTimes: laps.sectorTimes,
      catalogVersion: laps.catalogVersion,
      catalogHash: laps.catalogHash,
      catalogSchemaVersion: laps.catalogSchemaVersion,
      parserVersion: laps.parserVersion,
      resolverVersion: laps.resolverVersion,
      derivationVersion: laps.derivationVersion,
    })
    .from(laps)
    .innerJoin(sessions, eq(laps.sessionId, sessions.id))
    .leftJoin(tunes, eq(laps.tuneId, tunes.id))
    .where(inArray(laps.id, ids))
    .all();

  const rowById = new Map(rows.map((r) => [r.id, r]));

  // Group cache-miss laps by session raw file so each session decodes once.
  type BatchMeta = { id: number; rawByteOffset: number; rawFrameCount: number };
  const bySession = new Map<string, { gameId: GameId; metas: BatchMeta[] }>();
  const decoded = new Map<number, TelemetryPacket[]>();

  for (const row of rows) {
    const cached = cacheGet(row.id);
    if (cached) {
      decoded.set(row.id, cached);
      continue;
    }
    if (row.rawByteOffset != null && row.rawFrameCount && row.rawFile) {
      let group = bySession.get(row.rawFile);
      if (!group) {
        group = { gameId: row.gameId as GameId, metas: [] };
        bySession.set(row.rawFile, group);
      }
      group.metas.push({ id: row.id, rawByteOffset: row.rawByteOffset, rawFrameCount: row.rawFrameCount });
    }
  }

  for (const [rawFile, group] of bySession) {
    try {
      const batch = await parseSessionLapsBatched(rawFile, group.metas, group.gameId);
      for (const [lapId, telemetry] of batch) {
        cacheSet(lapId, telemetry);
        decoded.set(lapId, telemetry);
      }
    } catch (err) {
      console.error(`[DB] Batch decode failed for ${rawFile}, falling back per-lap:`, err);
    }
  }

  // Assemble in requested order; fall back to getLapById for anything the batch
  // pass didn't resolve (unaligned offset, batch error, or a bad lap).
  const results: (LapMeta & { telemetry: TelemetryPacket[]; parseError?: string })[] = [];
  for (const id of ids) {
    const row = rowById.get(id);
    if (!row) continue;
    const telemetry = decoded.get(id);
    if (telemetry) {
      results.push(buildLapResult(row, telemetry));
    } else {
      const lap = await getLapById(id);
      if (lap) results.push(lap);
    }
  }
  return results;
}

export async function getLapsRaw(ids?: number[]) {
  const base = db
    .select({
      id: laps.id,
      sessionId: laps.sessionId,
      lapNumber: laps.lapNumber,
      lapTime: laps.lapTime,
      isValid: laps.isValid,
      pi: laps.pi,
      rawByteOffset: laps.rawByteOffset,
      rawFrameCount: laps.rawFrameCount,
      rawFile: sessions.rawFile,
      createdAt: laps.createdAt,
      carOrdinal: sessions.carOrdinal,
      trackOrdinal: sessions.trackOrdinal,
      gameId: sessions.gameId,
      catalogVersion: laps.catalogVersion,
      catalogHash: laps.catalogHash,
      catalogSchemaVersion: laps.catalogSchemaVersion,
      parserVersion: laps.parserVersion,
      resolverVersion: laps.resolverVersion,
      derivationVersion: laps.derivationVersion,
    })
    .from(laps)
    .innerJoin(sessions, eq(laps.sessionId, sessions.id));

  if (ids && ids.length > 0) {
    return await base.where(or(...ids.map((id) => eq(laps.id, id))) as any).all();
  }

  return await base.all();
}

/** Count laps per trackOrdinal for a given game. Returns a Map<trackOrdinal, count>. */

export async function getLapCountsByTrack(gameId: GameId): Promise<Map<number, number>> {
  const rows = await db
    .select({ trackOrdinal: sessions.trackOrdinal, count: sql<number>`count(*)` })
    .from(laps)
    .innerJoin(sessions, eq(laps.sessionId, sessions.id))
    .where(eq(sessions.gameId, gameId))
    .groupBy(sessions.trackOrdinal)
    .all();
  return new Map(rows.map((r) => [r.trackOrdinal, Number(r.count)]));
}

// ---------------------------------------------------------------------------
// Driver profiles (cached summary snapshots)
// ---------------------------------------------------------------------------
