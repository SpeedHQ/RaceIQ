import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "./index";
import { experimentFocusEvents, experiments } from "./schema";
import { tryGetServerGame } from "../games/registry";
import { DEFAULT_EXPERIMENT_FOCUS, type ExperimentFocus } from "../../shared/experiment-focus";

export interface CreateExperimentData {
  gameId: string;
  name: string;
  carOrdinal?: number | null;
  trackOrdinal?: number | null;
  carName?: string | null;
  trackName?: string | null;
  baseSetupPath?: string | null;
  notes?: string | null;
  /** What the experiment opens on. Mutable afterwards via setExperimentFocus. */
  focus?: ExperimentFocus;
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

  const focus = data.focus ?? DEFAULT_EXPERIMENT_FOCUS;

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
      focus,
    })
    .returning({ id: experiments.id })
    .get();

  // Open the ledger with the focus the experiment started on, so the history is
  // a complete timeline rather than one that only begins at the first switch.
  await db.insert(experimentFocusEvents).values({ experimentId: result.id, focus }).run();
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

/**
 * Switch what the experiment is working on, and record the switch.
 *
 * Returns the ledger row when the focus actually changed, or null when it was
 * already on that focus — a no-op switch must not litter the ledger with
 * entries that say nothing happened, and the UI relies on that to render the
 * history as real eras rather than clicks.
 */
export async function setExperimentFocus(
  experimentId: number,
  focus: ExperimentFocus,
  opts: { note?: string | null } = {},
): Promise<{ id: number; focus: ExperimentFocus; fromVersionId: number | null; createdAt: string } | null> {
  const current = await db
    .select({ focus: experiments.focus, headVersionId: experiments.headVersionId })
    .from(experiments)
    .where(eq(experiments.id, experimentId))
    .get();
  if (!current) return null;
  if (current.focus === focus) return null;

  await db
    .update(experiments)
    .set({ focus, updatedAt: sql`(datetime('now'))` })
    .where(eq(experiments.id, experimentId))
    .run();

  // The head at the moment of the switch — where this focus era begins in the
  // version tree.
  const row = await db
    .insert(experimentFocusEvents)
    .values({ experimentId, focus, fromVersionId: current.headVersionId ?? null, note: opts.note ?? null })
    .returning({ id: experimentFocusEvents.id, focus: experimentFocusEvents.focus, fromVersionId: experimentFocusEvents.fromVersionId, createdAt: experimentFocusEvents.createdAt })
    .get();
  return { id: row.id, focus: row.focus as ExperimentFocus, fromVersionId: row.fromVersionId, createdAt: row.createdAt };
}

/** The focus ledger for one experiment, oldest first — it reads as a timeline. */
export async function listExperimentFocusEvents(experimentId: number) {
  return await db
    .select()
    .from(experimentFocusEvents)
    .where(eq(experimentFocusEvents.experimentId, experimentId))
    .orderBy(experimentFocusEvents.id)
    .all();
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
