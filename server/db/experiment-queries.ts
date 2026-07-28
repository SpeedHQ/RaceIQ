import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "./index";
import { experiments } from "./schema";
import { tryGetServerGame } from "../games/registry";

export interface CreateExperimentData {
  gameId: string;
  name: string;
  carOrdinal?: number | null;
  trackOrdinal?: number | null;
  carName?: string | null;
  trackName?: string | null;
  baseSetupPath?: string | null;
  notes?: string | null;
}

export async function createExperiment(data: CreateExperimentData): Promise<number> {
  // Per-game display number, counted from 1 (independent of the churned id).
  const seqRow = await db
    .select({ maxSeq: sql<number | null>`MAX(${experiments.seq})` })
    .from(experiments)
    .where(eq(experiments.gameId, data.gameId))
    .get();
  const seq = (seqRow?.maxSeq ?? 0) + 1;

  const trackOrdinal =
    data.trackOrdinal ?? (data.trackName ? tryGetServerGame(data.gameId)?.getTrackOrdinalByName?.(data.trackName) : undefined) ?? null;

  const result = await db
    .insert(experiments)
    .values({
      seq,
      gameId: data.gameId,
      name: data.name,
      carOrdinal: data.carOrdinal ?? null,
      trackOrdinal,
      carName: data.carName ?? null,
      trackName: data.trackName ?? null,
      baseSetupPath: data.baseSetupPath ?? null,
      notes: data.notes ?? null,
    })
    .returning({ id: experiments.id })
    .get();
  return result.id;
}

/** List sessions for a game, newest first. Excludes archived by default. */
export async function listExperiments(
  gameId: string,
  opts: { includeArchived?: boolean } = {},
) {
  const conds = [eq(experiments.gameId, gameId)];
  if (!opts.includeArchived) conds.push(eq(experiments.status, "active"));
  return await db
    .select()
    .from(experiments)
    .where(and(...conds))
    .orderBy(desc(experiments.updatedAt))
    .all();
}

export async function getExperiment(id: number) {
  return (await db.select().from(experiments).where(eq(experiments.id, id)).get()) ?? null;
}

export async function updateExperiment(
  id: number,
  data: Partial<Pick<CreateExperimentData, "name" | "notes" | "baseSetupPath"> & { status: string }>,
): Promise<boolean> {
  const sets: Record<string, unknown> = { updatedAt: sql`(datetime('now'))` };
  if (data.name !== undefined) sets.name = data.name;
  if (data.notes !== undefined) sets.notes = data.notes;
  if (data.baseSetupPath !== undefined) sets.baseSetupPath = data.baseSetupPath;
  if (data.status !== undefined) sets.status = data.status;
  const result = await db.update(experiments).set(sets).where(eq(experiments.id, id)).run();
  return result.rowsAffected > 0;
}

/** Set (or clear, with null) the checked-out head test for a session. */
export async function setSessionHead(sessionId: number, headVersionId: number | null): Promise<boolean> {
  const result = await db
    .update(experiments)
    .set({ headVersionId, updatedAt: sql`(datetime('now'))` })
    .where(eq(experiments.id, sessionId))
    .run();
  return result.rowsAffected > 0;
}
