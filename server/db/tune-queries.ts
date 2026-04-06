import { eq, and, desc, sql } from "drizzle-orm";
import { db } from "./index";
import { tunes, tuneAssignments, laps } from "./schema";

interface InsertTuneData {
  name: string;
  author: string;
  carOrdinal: number;
  category: string;
  trackOrdinal?: number;
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

export async function getTunes(carOrdinal?: number) {
  const query = db.select().from(tunes).orderBy(desc(tunes.id));
  if (carOrdinal != null) {
    return await query.where(eq(tunes.carOrdinal, carOrdinal)).all();
  }
  return await query.all();
}

export async function getTuneById(id: number) {
  return (await db.select().from(tunes).where(eq(tunes.id, id)).get()) ?? null;
}

export async function updateTune(id: number, data: Partial<Omit<InsertTuneData, "carOrdinal">> & { carOrdinal?: number }): Promise<boolean> {
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

export async function deleteTune(id: number): Promise<boolean> {
  const result = await db.delete(tunes).where(eq(tunes.id, id)).returning().all();
  return result.length > 0;
}

export async function setTuneAssignment(carOrdinal: number, trackOrdinal: number, tuneId: number): Promise<void> {
  const existing = await db
    .select({ id: tuneAssignments.id })
    .from(tuneAssignments)
    .where(and(eq(tuneAssignments.carOrdinal, carOrdinal), eq(tuneAssignments.trackOrdinal, trackOrdinal)))
    .get();
  if (existing) {
    await db.update(tuneAssignments).set({ tuneId }).where(eq(tuneAssignments.id, existing.id)).run();
  } else {
    await db.insert(tuneAssignments).values({ carOrdinal, trackOrdinal, tuneId }).run();
  }
}

export async function getTuneAssignment(carOrdinal: number, trackOrdinal: number) {
  const row = await db
    .select({
      carOrdinal: tuneAssignments.carOrdinal,
      trackOrdinal: tuneAssignments.trackOrdinal,
      tuneId: tuneAssignments.tuneId,
      tuneName: tunes.name,
    })
    .from(tuneAssignments)
    .innerJoin(tunes, eq(tuneAssignments.tuneId, tunes.id))
    .where(and(eq(tuneAssignments.carOrdinal, carOrdinal), eq(tuneAssignments.trackOrdinal, trackOrdinal)))
    .get();
  return row ?? null;
}

export async function getTuneAssignments(carOrdinal?: number) {
  const query = db
    .select({
      carOrdinal: tuneAssignments.carOrdinal,
      trackOrdinal: tuneAssignments.trackOrdinal,
      tuneId: tuneAssignments.tuneId,
      tuneName: tunes.name,
    })
    .from(tuneAssignments)
    .innerJoin(tunes, eq(tuneAssignments.tuneId, tunes.id));
  if (carOrdinal != null) {
    return await query.where(eq(tuneAssignments.carOrdinal, carOrdinal)).all();
  }
  return await query.all();
}

export async function deleteTuneAssignment(carOrdinal: number, trackOrdinal: number): Promise<boolean> {
  const result = await db
    .delete(tuneAssignments)
    .where(and(eq(tuneAssignments.carOrdinal, carOrdinal), eq(tuneAssignments.trackOrdinal, trackOrdinal)))
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
