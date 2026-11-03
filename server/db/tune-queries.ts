import { paceLapCondition } from "./lap-eligibility";
import { eq, and, or, inArray, desc, sql, asc, type SQL } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import { db, readDb } from "./index"
import { tunes, tuneAssignments, laps, sessions } from "./schema";
import { withDatabaseWrite } from "./write-coordination";
import { accLegacyAlternatives, accLegacyPairs } from "./acc-legacy-identity";

function carFilter(game: AnySQLiteColumn, car: AnySQLiteColumn, value: string) {
  const alternatives = accLegacyAlternatives("car", value);
  return or(eq(car, value), and(eq(game, "acc"), inArray(car, alternatives)));
}

function accIdentityMatch(left: SQL, right: SQL, kind: "car" | "track") {
  return or(sql`${left} = ${right}`, ...accLegacyPairs(kind).map(([ordinal, native]) =>
    or(and(sql`${left} = ${ordinal}`, sql`${right} = ${native}`),
      and(sql`${left} = ${native}`, sql`${right} = ${ordinal}`))));
}


interface InsertTuneData {
  gameId: string;
  name: string;
  author: string;
  carId: string;
  category: string;
  trackId?: string | null;
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
  return await withDatabaseWrite(async () => {
    const result = await db.insert(tunes).values({
      gameId: data.gameId,
      name: data.name,
      author: data.author,
      carId: data.carId,
      category: data.category,
      trackId: data.trackId ?? null,
      description: data.description,
      strengths: data.strengths ?? null,
      weaknesses: data.weaknesses ?? null,
      bestTracks: data.bestTracks ?? null,
      strategies: data.strategies ?? null,
      settings: data.settings,
      unitSystem: data.unitSystem ?? "metric",
      source: data.source ?? "user",
      catalogId: data.catalogId ?? null,
    }).returning({ id: tunes.id }).get();
    return result.id;
  });
}

export async function getTunes(filters: { gameId?: string; carId?: string } = {}) {
  const conds = [];
  if (filters.gameId != null) conds.push(eq(tunes.gameId, filters.gameId));
  if (filters.carId != null) conds.push(carFilter(tunes.gameId, tunes.carId, filters.carId));
  const query = readDb.select().from(tunes).orderBy(desc(tunes.id));
  const rows = conds.length > 0 ? await query.where(and(...conds)).all() : await query.all();
  if (rows.length === 0) return [];

  const bestLaps = await readDb.select({
    tuneId: laps.tuneId,
    bestLapTime: sql<number>`MIN(${laps.lapTime})`,
  }).from(laps)
    .innerJoin(tunes, eq(laps.tuneId, tunes.id))
    .innerJoin(sessions, eq(laps.sessionId, sessions.id))
    .where(and(
      sql`${laps.tuneId} IS NOT NULL`,
      eq(laps.isValid, true),
      paceLapCondition(),
      sql`${laps.lapTime} > 0`,
      eq(sessions.gameId, tunes.gameId),
      or(eq(sessions.carId, tunes.carId), and(eq(tunes.gameId, "acc"), accIdentityMatch(sql`${sessions.carId}`, sql`${tunes.carId}`, "car"))),
      or(sql`${tunes.trackId} IS NULL`, eq(sessions.trackId, tunes.trackId), and(eq(tunes.gameId, "acc"), accIdentityMatch(sql`${sessions.trackId}`, sql`${tunes.trackId}`, "track"))),
      ...(filters.carId != null ? [carFilter(tunes.gameId, tunes.carId, filters.carId)] : []),
    ))
    .groupBy(laps.tuneId).all();
  const bestLapByTuneId = new Map(bestLaps.map((row) => [row.tuneId, row.bestLapTime]));
  return rows.map((row) => ({ ...row, bestLapTime: bestLapByTuneId.get(row.id) ?? null }));
}

export async function getTuneById(id: number) {
  return (await readDb.select().from(tunes).where(eq(tunes.id, id)).get()) ?? null;
}

export async function updateTune(id: number, data: Partial<Omit<InsertTuneData, "gameId">>): Promise<boolean> {
  const sets: Record<string, any> = { updatedAt: sql`(datetime('now'))` };
  if (data.name !== undefined) sets.name = data.name;
  if (data.author !== undefined) sets.author = data.author;
  if (data.carId !== undefined) sets.carId = data.carId;
  if (data.category !== undefined) sets.category = data.category;
  if (data.trackId !== undefined) sets.trackId = data.trackId;
  if (data.description !== undefined) sets.description = data.description;
  if (data.strengths !== undefined) sets.strengths = data.strengths;
  if (data.weaknesses !== undefined) sets.weaknesses = data.weaknesses;
  if (data.bestTracks !== undefined) sets.bestTracks = data.bestTracks;
  if (data.strategies !== undefined) sets.strategies = data.strategies;
  if (data.settings !== undefined) sets.settings = data.settings;
  if (data.unitSystem !== undefined) sets.unitSystem = data.unitSystem;
  return await withDatabaseWrite(async () => {
    const result = await db.update(tunes).set(sets).where(eq(tunes.id, id)).returning().all();
    return result.length > 0;
  });
}

export async function getTuneUsage(id: number) {
  const [tune] = await readDb.select({ id: tunes.id }).from(tunes).where(eq(tunes.id, id)).limit(1);
  if (!tune) return null;
  const rows = await readDb.select({
    sessionId: sessions.id, gameId: sessions.gameId, createdAt: sessions.createdAt,
    carId: sessions.carId, trackId: sessions.trackId, lapId: laps.id, lapNumber: laps.lapNumber,
  }).from(laps).innerJoin(sessions, eq(laps.sessionId, sessions.id))
    .where(eq(laps.tuneId, id)).orderBy(asc(sessions.id), asc(laps.id)).all();
  const grouped = new Map<number, {
    sessionId: number; gameId: string; createdAt: string; carId: string | null;
    trackId: string | null; laps: { id: number; lapNumber: number }[];
  }>();
  for (const row of rows) {
    let session = grouped.get(row.sessionId);
    if (!session) {
      session = { sessionId: row.sessionId, gameId: row.gameId, createdAt: row.createdAt, carId: row.carId, trackId: row.trackId, laps: [] };
      grouped.set(row.sessionId, session);
    }
    session.laps.push({ id: row.lapId, lapNumber: row.lapNumber });
  }
  const assignments = await readDb.select({
    gameId: tuneAssignments.gameId, carId: tuneAssignments.carId, trackId: tuneAssignments.trackId,
  }).from(tuneAssignments).where(eq(tuneAssignments.tuneId, id)).orderBy(asc(tuneAssignments.gameId), asc(tuneAssignments.carId), asc(tuneAssignments.trackId)).all();
  return { sessions: [...grouped.values()], assignments };
}
export async function deleteTune(id: number): Promise<boolean> {
  return await withDatabaseWrite(async () => {
    const result = await db.delete(tunes).where(eq(tunes.id, id)).returning().all();
    return result.length > 0;
  });
}

export async function setTuneAssignment(gameId: string, carId: string, trackId: string, tuneId: number): Promise<void> {
  await withDatabaseWrite(async () => {
    await db.insert(tuneAssignments).values({ gameId, carId, trackId, tuneId })
      .onConflictDoUpdate({
        target: [tuneAssignments.gameId, tuneAssignments.carId, tuneAssignments.trackId],
        targetWhere: sql`${tuneAssignments.carId} != '' AND ${tuneAssignments.trackId} != ''`,
        set: { tuneId },
      }).run();
  });
}

export async function getTuneAssignment(gameId: string, carId: string, trackId: string) {
  const cars = gameId === "acc" ? accLegacyAlternatives("car", carId) : [carId];
  const tracks = gameId === "acc" ? accLegacyAlternatives("track", trackId) : [trackId];
  const rows = await readDb.select({
    carId: tuneAssignments.carId, trackId: tuneAssignments.trackId, tuneId: tuneAssignments.tuneId, tuneName: tunes.name,
  }).from(tuneAssignments).innerJoin(tunes, eq(tuneAssignments.tuneId, tunes.id))
    .where(and(eq(tuneAssignments.gameId, gameId), inArray(tuneAssignments.carId, cars), inArray(tuneAssignments.trackId, tracks))).all();
  const exact = rows.find((row) => row.carId === carId && row.trackId === trackId);
  return exact ?? (rows.length === 1 ? rows[0] : null);
}

export async function getTuneAssignments(filters: { gameId?: string; carId?: string } = {}) {
  const conds = [];
  if (filters.gameId != null) conds.push(eq(tuneAssignments.gameId, filters.gameId));
  if (filters.carId != null) conds.push(carFilter(tuneAssignments.gameId, tuneAssignments.carId, filters.carId));
  const query = readDb.select({
    carId: tuneAssignments.carId, trackId: tuneAssignments.trackId, tuneId: tuneAssignments.tuneId, tuneName: tunes.name,
  }).from(tuneAssignments).innerJoin(tunes, eq(tuneAssignments.tuneId, tunes.id));
  return conds.length > 0 ? await query.where(and(...conds)).all() : await query.all();
}

export async function deleteTuneAssignment(gameId: string, carId: string, trackId: string): Promise<boolean> {
  return await withDatabaseWrite(async () => {
    const cars = gameId === "acc" ? accLegacyAlternatives("car", carId) : [carId];
    const tracks = gameId === "acc" ? accLegacyAlternatives("track", trackId) : [trackId];
    const rows = await db.select({ carId: tuneAssignments.carId, trackId: tuneAssignments.trackId })
      .from(tuneAssignments)
      .where(and(eq(tuneAssignments.gameId, gameId), inArray(tuneAssignments.carId, cars), inArray(tuneAssignments.trackId, tracks))).all();
    const selected = rows.find((row) => row.carId === carId && row.trackId === trackId) ?? (rows.length === 1 ? rows[0] : undefined);
    if (!selected) return false;
    const result = await db.delete(tuneAssignments)
      .where(and(eq(tuneAssignments.gameId, gameId), eq(tuneAssignments.carId, selected.carId), eq(tuneAssignments.trackId, selected.trackId)))
      .returning().all();
    return result.length > 0;
  });
}


export async function updateLapTune(lapId: number, tuneId: number | null): Promise<boolean> {
  return await withDatabaseWrite(async () => {
    const result = await db
      .update(laps)
      .set({ tuneId })
      .where(eq(laps.id, lapId))
      .returning()
      .all();
    return result.length > 0;
  });
}
