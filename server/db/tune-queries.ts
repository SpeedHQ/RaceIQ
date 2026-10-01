import { eq, and, desc, sql, asc } from "drizzle-orm";
import { db } from "./index";
import { tunes, tuneAssignments, laps, sessions } from "./schema";

interface InsertTuneData {
  gameId: string;
  name: string;
  author: string;
  carOrdinal: number;
  category: string;
  trackOrdinal?: number | null;
  description: string;
  strengths?: string;
  weaknesses?: string;
  bestTracks?: string;
  strategies?: string;
  settings: string;
  unitSystem?: string;
  source?: string;
  catalogId?: string;
}

export async function insertTune(data: InsertTuneData): Promise<number> {
  const result = await db
    .insert(tunes)
    .values({
      gameId: data.gameId,
      name: data.name,
      author: data.author,
      carOrdinal: data.carOrdinal,
      category: data.category,
      trackOrdinal: data.trackOrdinal ?? null,
      description: data.description,
      strengths: data.strengths ?? null,
      weaknesses: data.weaknesses ?? null,
      bestTracks: data.bestTracks ?? null,
      strategies: data.strategies ?? null,
      settings: data.settings,
      unitSystem: data.unitSystem ?? "metric",
      source: data.source ?? "user",
      catalogId: data.catalogId ?? null,
    })
    .returning({ id: tunes.id })
    .get();
  return result.id;
}

export async function getTunes(filters: { gameId?: string; carOrdinal?: number } = {}) {
  const conds = [];
  if (filters.gameId != null) conds.push(eq(tunes.gameId, filters.gameId));
  if (filters.carOrdinal != null) conds.push(eq(tunes.carOrdinal, filters.carOrdinal));
  const query = db.select().from(tunes).orderBy(desc(tunes.id));
  const rows = conds.length > 0
    ? await query.where(and(...conds)).all()
    : await query.all();
  if (rows.length === 0) return [];

  const bestLaps = await db
    .select({
      tuneId: laps.tuneId,
      bestLapTime: sql<number>`MIN(${laps.lapTime})`,
    })
    .from(laps)
    .innerJoin(tunes, eq(laps.tuneId, tunes.id))
    .innerJoin(sessions, eq(laps.sessionId, sessions.id))
    .where(and(
      sql`${laps.tuneId} IS NOT NULL`,
      eq(laps.isValid, true),
      sql`${laps.lapTime} > 0`,
      eq(sessions.gameId, tunes.gameId),
      eq(sessions.carOrdinal, tunes.carOrdinal),
      sql`(${tunes.trackOrdinal} IS NULL OR ${sessions.trackOrdinal} = ${tunes.trackOrdinal})`,
      ...(filters.gameId != null ? [eq(tunes.gameId, filters.gameId)] : []),
      ...(filters.carOrdinal != null ? [eq(tunes.carOrdinal, filters.carOrdinal)] : []),
    ))
    .groupBy(laps.tuneId)
    .all();
  const bestLapByTuneId = new Map(bestLaps.map((row) => [row.tuneId, row.bestLapTime]));
  return rows.map((row) => ({
    ...row,
    bestLapTime: bestLapByTuneId.get(row.id) ?? null,
  }));
}

export async function getTuneById(id: number) {
  return (await db.select().from(tunes).where(eq(tunes.id, id)).get()) ?? null;
}

export async function updateTune(id: number, data: Partial<Omit<InsertTuneData, "carOrdinal" | "gameId">> & { carOrdinal?: number }): Promise<boolean> {
  const sets: Record<string, any> = { updatedAt: sql`(datetime('now'))` };
  if (data.name !== undefined) sets.name = data.name;
  if (data.author !== undefined) sets.author = data.author;
  if (data.carOrdinal !== undefined) sets.carOrdinal = data.carOrdinal;
  if (data.category !== undefined) sets.category = data.category;
  if (data.trackOrdinal !== undefined) sets.trackOrdinal = data.trackOrdinal;
  if (data.description !== undefined) sets.description = data.description;
  if (data.strengths !== undefined) sets.strengths = data.strengths;
  if (data.weaknesses !== undefined) sets.weaknesses = data.weaknesses;
  if (data.bestTracks !== undefined) sets.bestTracks = data.bestTracks;
  if (data.strategies !== undefined) sets.strategies = data.strategies;
  if (data.settings !== undefined) sets.settings = data.settings;
  if (data.unitSystem !== undefined) sets.unitSystem = data.unitSystem;
  const result = await db.update(tunes).set(sets).where(eq(tunes.id, id)).returning().all();
  return result.length > 0;
}

export async function getTuneUsage(id: number) {
  const [tune] = await db.select({ id: tunes.id }).from(tunes).where(eq(tunes.id, id)).limit(1);
  if (!tune) return null;

  const rows = await db
    .select({
      sessionId: sessions.id,
      gameId: sessions.gameId,
      createdAt: sessions.createdAt,
      carOrdinal: sessions.carOrdinal,
      trackOrdinal: sessions.trackOrdinal,
      carId: sessions.carId,
      trackId: sessions.trackId,
      lapId: laps.id,
      lapNumber: laps.lapNumber,
    })
    .from(laps)
    .innerJoin(sessions, eq(laps.sessionId, sessions.id))
    .where(eq(laps.tuneId, id))
    .orderBy(asc(sessions.id), asc(laps.id))
    .all();
  const grouped = new Map<number, {
    sessionId: number;
    gameId: string;
    createdAt: string;
    carOrdinal: number;
    trackOrdinal: number;
    carId: string | null;
    trackId: string | null;
    laps: { id: number; lapNumber: number }[];
  }>();
  for (const row of rows) {
    let session = grouped.get(row.sessionId);
    if (!session) {
      session = {
        sessionId: row.sessionId,
        gameId: row.gameId,
        createdAt: row.createdAt,
        carOrdinal: row.carOrdinal,
        trackOrdinal: row.trackOrdinal,
        carId: row.carId,
        trackId: row.trackId,
        laps: [],
      };
      grouped.set(row.sessionId, session);
    }
    session.laps.push({ id: row.lapId, lapNumber: row.lapNumber });
  }
  const assignments = await db
    .select({
      gameId: tuneAssignments.gameId,
      carOrdinal: tuneAssignments.carOrdinal,
      trackOrdinal: tuneAssignments.trackOrdinal,
    })
    .from(tuneAssignments)
    .where(eq(tuneAssignments.tuneId, id))
    .orderBy(asc(tuneAssignments.gameId), asc(tuneAssignments.carOrdinal), asc(tuneAssignments.trackOrdinal))
    .all();
  return { sessions: [...grouped.values()], assignments };
}

export async function deleteTune(id: number): Promise<boolean> {
  const result = await db.delete(tunes).where(eq(tunes.id, id)).returning().all();
  return result.length > 0;
}

export async function setTuneAssignment(gameId: string, carOrdinal: number, trackOrdinal: number, tuneId: number): Promise<void> {
  const existing = await db
    .select({ id: tuneAssignments.id })
    .from(tuneAssignments)
    .where(and(eq(tuneAssignments.gameId, gameId), eq(tuneAssignments.carOrdinal, carOrdinal), eq(tuneAssignments.trackOrdinal, trackOrdinal)))
    .get();
  if (existing) {
    await db.update(tuneAssignments).set({ tuneId }).where(eq(tuneAssignments.id, existing.id)).run();
  } else {
    await db.insert(tuneAssignments).values({ gameId, carOrdinal, trackOrdinal, tuneId }).run();
  }
}

export async function getTuneAssignment(gameId: string, carOrdinal: number, trackOrdinal: number) {
  const row = await db
    .select({
      carOrdinal: tuneAssignments.carOrdinal,
      trackOrdinal: tuneAssignments.trackOrdinal,
      tuneId: tuneAssignments.tuneId,
      tuneName: tunes.name,
    })
    .from(tuneAssignments)
    .innerJoin(tunes, eq(tuneAssignments.tuneId, tunes.id))
    .where(and(eq(tuneAssignments.gameId, gameId), eq(tuneAssignments.carOrdinal, carOrdinal), eq(tuneAssignments.trackOrdinal, trackOrdinal)))
    .get();
  return row ?? null;
}

export async function getTuneAssignments(filters: { gameId?: string; carOrdinal?: number } = {}) {
  const conds = [];
  if (filters.gameId != null) conds.push(eq(tuneAssignments.gameId, filters.gameId));
  if (filters.carOrdinal != null) conds.push(eq(tuneAssignments.carOrdinal, filters.carOrdinal));
  const query = db
    .select({
      carOrdinal: tuneAssignments.carOrdinal,
      trackOrdinal: tuneAssignments.trackOrdinal,
      tuneId: tuneAssignments.tuneId,
      tuneName: tunes.name,
    })
    .from(tuneAssignments)
    .innerJoin(tunes, eq(tuneAssignments.tuneId, tunes.id));
  if (conds.length > 0) return await query.where(and(...conds)).all();
  return await query.all();
}

export async function deleteTuneAssignment(gameId: string, carOrdinal: number, trackOrdinal: number): Promise<boolean> {
  const result = await db
    .delete(tuneAssignments)
    .where(and(eq(tuneAssignments.gameId, gameId), eq(tuneAssignments.carOrdinal, carOrdinal), eq(tuneAssignments.trackOrdinal, trackOrdinal)))
    .returning()
    .all();
  return result.length > 0;
}

export async function updateLapTune(lapId: number, tuneId: number | null): Promise<boolean> {
  const result = await db
    .update(laps)
    .set({ tuneId })
    .where(eq(laps.id, lapId))
    .returning()
    .all();
  return result.length > 0;
}
