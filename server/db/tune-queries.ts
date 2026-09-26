import { eq, and, desc, sql } from "drizzle-orm";
import { db } from "./index";
import { tunes, tuneAssignments, laps } from "./schema";

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
  const result = await db
    .insert(tunes)
    .values({
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
    })
    .returning({ id: tunes.id })
    .get();
  return result.id;
}

export async function getTunes(filters: { gameId?: string; carId?: string } = {}) {
  const conds = [];
  if (filters.gameId != null) conds.push(eq(tunes.gameId, filters.gameId));
  if (filters.carId != null) conds.push(eq(tunes.carId, filters.carId));
  const query = db.select().from(tunes).orderBy(desc(tunes.id));
  if (conds.length > 0) return await query.where(and(...conds)).all();
  return await query.all();
}

export async function getTuneById(id: number) {
  return (await db.select().from(tunes).where(eq(tunes.id, id)).get()) ?? null;
}

export async function updateTune(id: number, data: Partial<Omit<InsertTuneData, "gameId">>): Promise<boolean> {
  const sets: Record<string, any> = { updatedAt: sql`(datetime('now'))` };
  if (data.name !== undefined) sets.name = data.name;
  if (data.author !== undefined) sets.author = data.author;
  if (data.carId !== undefined) sets.carId = data.carId;
  if (data.category !== undefined) sets.category = data.category;
  if (data.trackId !== undefined) sets.trackId = data.trackId;
  if (data.strengths !== undefined) sets.strengths = data.strengths;
  if (data.weaknesses !== undefined) sets.weaknesses = data.weaknesses;
  if (data.bestTracks !== undefined) sets.bestTracks = data.bestTracks;
  if (data.strategies !== undefined) sets.strategies = data.strategies;
  if (data.settings !== undefined) sets.settings = data.settings;
  if (data.unitSystem !== undefined) sets.unitSystem = data.unitSystem;
  const result = await db.update(tunes).set(sets).where(eq(tunes.id, id)).returning().all();
  return result.length > 0;
}

export async function deleteTune(id: number): Promise<boolean> {
  const result = await db.delete(tunes).where(eq(tunes.id, id)).returning().all();
  return result.length > 0;
}

export async function setTuneAssignment(gameId: string, carId: string, trackId: string, tuneId: number): Promise<void> {
  const existing = await db
    .select({ id: tuneAssignments.id })
    .from(tuneAssignments)
    .where(and(eq(tuneAssignments.gameId, gameId), eq(tuneAssignments.carId, carId), eq(tuneAssignments.trackId, trackId)))
    .get();
  if (existing) {
    await db.update(tuneAssignments).set({ tuneId }).where(eq(tuneAssignments.id, existing.id)).run();
  } else {
    await db.insert(tuneAssignments).values({ gameId, carId, trackId, tuneId }).run();
  }
}

export async function getTuneAssignment(gameId: string, carId: string, trackId: string) {
  const row = await db
    .select({
      carId: tuneAssignments.carId,
      trackId: tuneAssignments.trackId,
      tuneId: tuneAssignments.tuneId,
      tuneName: tunes.name,
    })
    .from(tuneAssignments)
    .innerJoin(tunes, eq(tuneAssignments.tuneId, tunes.id))
    .where(and(eq(tuneAssignments.gameId, gameId), eq(tuneAssignments.carId, carId), eq(tuneAssignments.trackId, trackId)))
    .get();
  return row ?? null;
}

export async function getTuneAssignments(filters: { gameId?: string; carId?: string } = {}) {
  const conds = [];
  if (filters.gameId != null) conds.push(eq(tuneAssignments.gameId, filters.gameId));
  if (filters.carId != null) conds.push(eq(tuneAssignments.carId, filters.carId));
  const query = db
    .select({
      carId: tuneAssignments.carId,
      trackId: tuneAssignments.trackId,
      tuneId: tuneAssignments.tuneId,
      tuneName: tunes.name,
    })
    .from(tuneAssignments)
    .innerJoin(tunes, eq(tuneAssignments.tuneId, tunes.id));
  if (conds.length > 0) return await query.where(and(...conds)).all();
  return await query.all();
}

export async function deleteTuneAssignment(gameId: string, carId: string, trackId: string): Promise<boolean> {
  const result = await db
    .delete(tuneAssignments)
    .where(and(eq(tuneAssignments.gameId, gameId), eq(tuneAssignments.carId, carId), eq(tuneAssignments.trackId, trackId)))
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
