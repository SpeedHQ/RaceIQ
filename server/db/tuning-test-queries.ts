import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { db } from "./index";
import { laps, tuningSessions, tuningTests } from "./schema";
import { setSessionHead } from "./tuning-session-queries";

export interface CreateTuningTestData {
  tuningSessionId: number;
  version: number;
  label: string;
  setupPath?: string | null;
  parentTestId?: number | null;
  /** AppliedChange[] from the autotune engine, serialised to JSON. */
  appliedChanges?: string | null;
  driverComment?: string | null;
  /** One-line goal of the version ("faster straight speed") — shown in the tree. */
  notes?: string | null;
  engine?: string | null;
  /** F1's captured base / target F1CarSetup JSON; null for file-based nodes. */
  setupSnapshot?: string | null;
}

export async function createTuningTest(data: CreateTuningTestData): Promise<number> {
  const result = await db
    .insert(tuningTests)
    .values({
      tuningSessionId: data.tuningSessionId,
      version: data.version,
      label: data.label,
      setupPath: data.setupPath ?? null,
      parentTestId: data.parentTestId ?? null,
      appliedChanges: data.appliedChanges ?? null,
      driverComment: data.driverComment ?? null,
      notes: data.notes ?? null,
      engine: data.engine ?? null,
      setupSnapshot: data.setupSnapshot ?? null,
    })
    .returning({ id: tuningTests.id })
    .get();
  return result.id;
}

/** Tests for a session, oldest-first (v1 base → latest) so the UI can render
 *  the version history in creation order and attach live laps to the last row.
 *  Excludes soft-deleted (`status='deleted'`, design Phase 8) nodes by default
 *  so trashed versions never leak into version-history/label/AI-context reads —
 *  pass `includeDeleted: true` for the trash view / subtree walks. */
export async function listTuningTests(sessionId: number, opts: { includeDeleted?: boolean } = {}) {
  const conds = [eq(tuningTests.tuningSessionId, sessionId)];
  if (!opts.includeDeleted) conds.push(ne(tuningTests.status, "deleted"));
  return await db
    .select()
    .from(tuningTests)
    .where(and(...conds))
    .orderBy(asc(tuningTests.version), asc(tuningTests.id))
    .all();
}

/** Walk `parentTestId` children transitively from `rootId` (inclusive) over an
 *  already-fetched test list — pure/pure-ish helper shared by delete/restore
 *  so the subtree definition can't drift between the two ops. */
export function collectSubtreeIds(
  tests: { id: number; parentTestId: number | null }[],
  rootId: number,
): number[] {
  const childrenOf = new Map<number, number[]>();
  for (const t of tests) {
    if (t.parentTestId == null) continue;
    const arr = childrenOf.get(t.parentTestId) ?? [];
    arr.push(t.id);
    childrenOf.set(t.parentTestId, arr);
  }
  const result: number[] = [];
  const seen = new Set<number>();
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(id);
    for (const c of childrenOf.get(id) ?? []) stack.push(c);
  }
  return result;
}

/** Nearest ancestor of `fromId` that is neither inside `trashedIds` nor itself
 *  `status='deleted'` — where a trashed head gets moved to. `null` when no
 *  surviving ancestor exists (falls back to the mainline tip via
 *  `resolveActiveTestId`). */
export function findNearestSurvivingAncestor(
  tests: { id: number; parentTestId: number | null; status: string }[],
  fromId: number,
  trashedIds: Set<number>,
): number | null {
  const byId = new Map(tests.map((t) => [t.id, t]));
  let cur = byId.get(fromId);
  while (cur?.parentTestId != null) {
    const parent = byId.get(cur.parentTestId);
    if (!parent) return null;
    if (!trashedIds.has(parent.id) && parent.status !== "deleted") return parent.id;
    cur = parent;
  }
  return null;
}

/** Bulk status flip used by delete/restore. No-op on an empty id list. */
export async function setTestsStatus(ids: number[], status: string): Promise<void> {
  if (!ids.length) return;
  await db.update(tuningTests).set({ status }).where(inArray(tuningTests.id, ids)).run();
}

export interface DeleteSubtreeResult {
  deletedIds: number[];
  headMoved: boolean;
  prevHeadTestId: number | null;
  newHeadTestId: number | null;
}

/**
 * Soft-delete `testId` and its whole descendant subtree (design Phase 8):
 * flips `status` to 'deleted' on every node reachable via `parentTestId`
 * (including the target itself). Reversible — rows are never removed, so
 * `restoreTestSubtree` can flip them back. If `currentHeadTestId` falls
 * inside the trashed subtree, the session head is moved off it to the
 * nearest surviving ancestor (or cleared, falling back to the mainline tip).
 */
export async function deleteTestSubtree(
  sessionId: number,
  testId: number,
  currentHeadTestId: number | null,
): Promise<DeleteSubtreeResult> {
  const allTests = await listTuningTests(sessionId, { includeDeleted: true });
  const deletedIds = collectSubtreeIds(allTests, testId);
  await setTestsStatus(deletedIds, "deleted");

  const trashedSet = new Set(deletedIds);
  let headMoved = false;
  let newHeadTestId = currentHeadTestId;
  if (currentHeadTestId != null && trashedSet.has(currentHeadTestId)) {
    newHeadTestId = findNearestSurvivingAncestor(allTests, testId, trashedSet);
    await setSessionHead(sessionId, newHeadTestId);
    headMoved = true;
  }

  return { deletedIds, headMoved, prevHeadTestId: currentHeadTestId, newHeadTestId };
}

/**
 * Restore path (design Phase 8): flips every node in `testId`'s subtree that
 * is currently `status='deleted'` back to 'active'. Nodes in the subtree that
 * survived under another status are left untouched.
 */
export async function restoreTestSubtree(sessionId: number, testId: number): Promise<number[]> {
  const allTests = await listTuningTests(sessionId, { includeDeleted: true });
  const subtreeIds = collectSubtreeIds(allTests, testId);
  const byId = new Map(allTests.map((t) => [t.id, t]));
  const restoredIds = subtreeIds.filter((tid) => byId.get(tid)?.status === "deleted");
  await setTestsStatus(restoredIds, "active");
  return restoredIds;
}

export async function getTuningTest(id: number) {
  return (await db.select().from(tuningTests).where(eq(tuningTests.id, id)).get()) ?? null;
}

/**
 * Backfill/update a test node's F1 `setup_snapshot` (Phase 10). Used both to
 * stamp the base node once telemetry with `f1?.setup` first arrives (design
 * "base-capture timing") and by the live "capture current setup" action.
 * Never touches `setupPath` — file-based games don't call this.
 */
export async function updateTuningTestSetupSnapshot(id: number, setupSnapshot: string): Promise<void> {
  await db.update(tuningTests).set({ setupSnapshot }).where(eq(tuningTests.id, id)).run();
}

/** Set (or clear, with null) a version node's free-text driver note. This is the
 *  user's own annotation on a node — distinct from the applied-changes summary.
 *  Returns the prior value so the caller can log an inverse for undo. */
export async function setTuningTestNote(id: number, note: string | null): Promise<string | null> {
  const before = await getTuningTest(id);
  await db.update(tuningTests).set({ driverComment: note }).where(eq(tuningTests.id, id)).run();
  return before?.driverComment ?? null;
}

/** Set (or clear, with null) a version node's engineer/AI note — distinct from
 *  the driver's feel comment. Returns the prior value so the caller can log an
 *  inverse for undo. */
export async function setTuningTestNotes(id: number, notes: string | null): Promise<string | null> {
  const before = await getTuningTest(id);
  await db.update(tuningTests).set({ notes }).where(eq(tuningTests.id, id)).run();
  return before?.notes ?? null;
}

/** Resolve one session's version node by its user-facing version number — used
 *  by the setup-engineer agent's note tool, which reasons in version numbers
 *  (never internal test ids). Null when no such version exists. */
export async function getTuningTestByVersion(sessionId: number, version: number) {
  return await db
    .select()
    .from(tuningTests)
    .where(and(eq(tuningTests.tuningSessionId, sessionId), eq(tuningTests.version, version)))
    .get();
}

/** Next version number for a session — max(version) + 1, or 1 when none exist. */
export async function nextVersion(sessionId: number): Promise<number> {
  const row = await db
    .select({ maxVersion: sql<number | null>`MAX(${tuningTests.version})` })
    .from(tuningTests)
    .where(eq(tuningTests.tuningSessionId, sessionId))
    .get();
  return (row?.maxVersion ?? 0) + 1;
}

/**
 * The test id the Setup Engineer should currently work from: the session's
 * persisted head if set, else the highest-version test (mainline tip), else
 * null when the session has no tests yet.
 */
export async function resolveActiveTestId(sessionId: number): Promise<number | null> {
  const session = await db
    .select({ headTestId: tuningSessions.headTestId })
    .from(tuningSessions)
    .where(eq(tuningSessions.id, sessionId))
    .get();
  if (session?.headTestId != null) return session.headTestId;

  const tip = await db
    .select({ id: tuningTests.id })
    .from(tuningTests)
    .where(eq(tuningTests.tuningSessionId, sessionId))
    .orderBy(desc(tuningTests.version), desc(tuningTests.id))
    .get();
  return tip?.id ?? null;
}

/** Lap count + best (min positive) lap time per tuning_test_id for a session. */
export async function getLapCountsByTest(
  sessionId: number,
): Promise<Map<number, { lapCount: number; bestLapMs: number | null }>> {
  const rows = await db
    .select({
      testId: laps.tuningTestId,
      lapCount: sql<number>`COUNT(*)`,
      bestLapMs: sql<number | null>`MIN(CASE WHEN ${laps.lapTime} > 0 THEN ${laps.lapTime} END)`,
    })
    .from(laps)
    .where(eq(laps.tuningSessionId, sessionId))
    .groupBy(laps.tuningTestId)
    .all();

  const map = new Map<number, { lapCount: number; bestLapMs: number | null }>();
  for (const r of rows) {
    if (r.testId == null) continue;
    map.set(r.testId, { lapCount: Number(r.lapCount), bestLapMs: r.bestLapMs ?? null });
  }
  return map;
}
