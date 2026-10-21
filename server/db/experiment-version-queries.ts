import { laps, experiments, experimentVersions, experimentActions } from "./schema";
import { setSessionHead } from "./experiment-queries";
import { DEFAULT_EXPERIMENT_FOCUS, type ExperimentFocus, versionKindForFocus, type VersionKind } from "@raceiq/shared/racing/experiments/focus";
import { and, asc, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { db } from "./index";

interface CreateExperimentVersionData {
  experimentId: number;
  version: number;
  label: string;
  setupPath?: string | null;
  parentVersionId?: number | null;
  /** AppliedChange[] from the autotune engine, serialised to JSON. */
  appliedChanges?: string | null;
  driverComment?: string | null;
  /** One-line goal of the version ("faster straight speed") — shown in the tree. */
  notes?: string | null;
  engine?: string | null;
  /** F1's captured base / target F1CarSetup JSON; null for file-based nodes. */
  setupSnapshot?: string | null;
  /** What this arm varies. Omitted → the experiment's current focus decides
   *  ('driving' focus produces drills), which is what makes a focus switch
   *  actually change the next arm rather than just relabelling the UI. */
  kind?: VersionKind;
}

export async function createExperimentVersion(data: CreateExperimentVersionData): Promise<number> {
  // An arm's kind is fixed at creation from the focus in force at that moment,
  // and never rewritten afterwards — switching focus later must not turn the
  // setup versions already recorded into drills.
  let kind = data.kind;
  if (!kind) {
    const parent = await db
      .select({ focus: experiments.focus })
      .from(experiments)
      .where(eq(experiments.id, data.experimentId))
      .get();
    kind = versionKindForFocus((parent?.focus as ExperimentFocus | undefined) ?? DEFAULT_EXPERIMENT_FOCUS);
  }

  const result = await db
    .insert(experimentVersions)
    .values({
      kind,
      experimentId: data.experimentId,
      version: data.version,
      label: data.label,
      setupPath: data.setupPath ?? null,
      parentVersionId: data.parentVersionId ?? null,
      appliedChanges: data.appliedChanges ?? null,
      driverComment: data.driverComment ?? null,
      notes: data.notes ?? null,
      engine: data.engine ?? null,
      setupSnapshot: data.setupSnapshot ?? null,
    })
    .returning({ id: experimentVersions.id })
    .get();
  return result.id;
}

/** Insert a version, move head and append undo record atomically. */
export async function createExperimentVersionAndSetHead(
  data: CreateExperimentVersionData,
  expectedHeadVersionId: number | null,
  action?: { kind: string; inversePayload: unknown },
): Promise<number | null> {
  try {
    return await db.transaction(async (tx) => {
      const current = await tx.select({ headVersionId: experiments.headVersionId, focus: experiments.focus })
        .from(experiments).where(eq(experiments.id, data.experimentId)).get();
      if (!current || current.headVersionId !== expectedHeadVersionId) throw new Error("stale-experiment-head");
      const kind = data.kind ?? versionKindForFocus((current.focus as ExperimentFocus | undefined) ?? DEFAULT_EXPERIMENT_FOCUS);
      const inserted = await tx.insert(experimentVersions).values({
        kind, experimentId: data.experimentId, version: data.version, label: data.label,
        setupPath: data.setupPath ?? null, parentVersionId: data.parentVersionId ?? null,
        appliedChanges: data.appliedChanges ?? null, driverComment: data.driverComment ?? null,
        notes: data.notes ?? null, engine: data.engine ?? null, setupSnapshot: data.setupSnapshot ?? null,
      }).returning({ id: experimentVersions.id }).get();
      const moved = await tx.update(experiments)
        .set({ headVersionId: inserted.id, updatedAt: sql`(datetime('now'))` })
        .where(and(
          eq(experiments.id, data.experimentId),
          expectedHeadVersionId == null ? isNull(experiments.headVersionId) : eq(experiments.headVersionId, expectedHeadVersionId),
        )).run();
      if (moved.rowsAffected === 0) throw new Error("stale-experiment-head");
      if (action) {
        const inversePayload = action.inversePayload && typeof action.inversePayload === "object" &&
          "versionId" in action.inversePayload && action.inversePayload.versionId === "INSERTED_ID"
          ? { ...action.inversePayload, versionId: inserted.id }
          : action.inversePayload;
        await tx.insert(experimentActions).values({
          experimentId: data.experimentId, kind: action.kind,
          inversePayload: JSON.stringify(inversePayload),
        }).run();
      }
      return inserted.id;
    });
  } catch (error) {
    if (error instanceof Error && error.message === "stale-experiment-head") return null;
    throw error;
  }
}

/** Tests for a session, oldest-first (v1 base → latest) so the UI can render
 *  the version history in creation order and attach live laps to the last row.
 *  Excludes soft-deleted (`status='deleted'`, design Phase 8) nodes by default
 *  so trashed versions never leak into version-history/label/AI-context reads —
 *  pass `includeDeleted: true` for the trash view / subtree walks. */
export async function listExperimentVersions(sessionId: number, opts: { includeDeleted?: boolean } = {}) {
  const conds = [eq(experimentVersions.experimentId, sessionId)];
  if (!opts.includeDeleted) conds.push(ne(experimentVersions.status, "deleted"));
  return await db
    .select()
    .from(experimentVersions)
    .where(and(...conds))
    .orderBy(asc(experimentVersions.version), asc(experimentVersions.id))
    .all();
}

/** Walk `parentVersionId` children transitively from `rootId` (inclusive) over an
 *  already-fetched test list — pure/pure-ish helper shared by delete/restore
 *  so the subtree definition can't drift between the two ops. */
function collectSubtreeIds(
  tests: { id: number; parentVersionId: number | null }[],
  rootId: number,
): number[] {
  const childrenOf = new Map<number, number[]>();
  for (const t of tests) {
    if (t.parentVersionId == null) continue;
    const arr = childrenOf.get(t.parentVersionId) ?? [];
    arr.push(t.id);
    childrenOf.set(t.parentVersionId, arr);
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
function findNearestSurvivingAncestor(
  tests: { id: number; parentVersionId: number | null; status: string }[],
  fromId: number,
  trashedIds: Set<number>,
): number | null {
  const byId = new Map(tests.map((t) => [t.id, t]));
  let cur = byId.get(fromId);
  while (cur?.parentVersionId != null) {
    const parent = byId.get(cur.parentVersionId);
    if (!parent) return null;
    if (!trashedIds.has(parent.id) && parent.status !== "deleted") return parent.id;
    cur = parent;
  }
  return null;
}

/** Bulk status flip used by delete/restore. No-op on an empty id list. */
async function setTestsStatus(ids: number[], status: string): Promise<void> {
  if (!ids.length) return;
  await db.update(experimentVersions).set({ status }).where(inArray(experimentVersions.id, ids)).run();
}

interface DeleteSubtreeResult {
  deletedIds: number[];
  headMoved: boolean;
  prevHeadTestId: number | null;
  newHeadTestId: number | null;
}

/**
 * Soft-delete `versionId` and its whole descendant subtree (design Phase 8):
 * flips `status` to 'deleted' on every node reachable via `parentVersionId`
 * (including the target itself). Reversible — rows are never removed, so
 * `restoreTestSubtree` can flip them back. If `currentHeadTestId` falls
 * inside the trashed subtree, the session head is moved off it to the
 * nearest surviving ancestor (or cleared, falling back to the mainline tip).
 */
export async function deleteTestSubtree(
  sessionId: number,
  versionId: number,
  currentHeadTestId: number | null,
  expectedHeadVersionId?: number | null,
  action?: { kind: string; inversePayload: unknown },
): Promise<DeleteSubtreeResult> {
  if (expectedHeadVersionId === undefined) {
    const allTests = await listExperimentVersions(sessionId, { includeDeleted: true });
    const deletedIds = collectSubtreeIds(allTests, versionId);
    const trashedSet = new Set(deletedIds);
    let newHeadTestId = currentHeadTestId;
    if (currentHeadTestId != null && trashedSet.has(currentHeadTestId)) {
      newHeadTestId = findNearestSurvivingAncestor(allTests, versionId, trashedSet);
    }
    await setTestsStatus(deletedIds, "deleted");
    let headMoved = false;
    if (newHeadTestId !== currentHeadTestId) {
      headMoved = await setSessionHead(sessionId, newHeadTestId, currentHeadTestId);
      if (!headMoved) newHeadTestId = currentHeadTestId;
    }
    return { deletedIds, headMoved, prevHeadTestId: currentHeadTestId, newHeadTestId };
  }
  const result = await db.transaction(async (tx) => {
    const current = await tx.select({ headVersionId: experiments.headVersionId }).from(experiments).where(eq(experiments.id, sessionId)).get();
    if (!current || current.headVersionId !== expectedHeadVersionId) return null;
    const allTests = await tx.select({
      id: experimentVersions.id, parentVersionId: experimentVersions.parentVersionId, status: experimentVersions.status,
    }).from(experimentVersions).where(eq(experimentVersions.experimentId, sessionId)).all();
    const statusById = new Map(allTests.map((test) => [test.id, test.status]));
    const deletedIds = collectSubtreeIds(allTests, versionId).filter((id) => statusById.get(id) !== "deleted");
    if (!deletedIds.length) return null;
    const trashedSet = new Set(deletedIds);
    let newHeadTestId = currentHeadTestId;
    if (currentHeadTestId != null && trashedSet.has(currentHeadTestId)) {
      newHeadTestId = findNearestSurvivingAncestor(allTests, versionId, trashedSet);
    }
    if (deletedIds.length) await tx.update(experimentVersions).set({ status: "deleted" })
      .where(and(eq(experimentVersions.experimentId, sessionId), inArray(experimentVersions.id, deletedIds))).run();
    if (newHeadTestId !== currentHeadTestId) {
      const predicates = [eq(experiments.id, sessionId),
        expectedHeadVersionId == null ? isNull(experiments.headVersionId) : eq(experiments.headVersionId, expectedHeadVersionId)];
      const moved = await tx.update(experiments).set({ headVersionId: newHeadTestId, updatedAt: sql`(datetime('now'))` })
        .where(and(...predicates)).run();
      if (!moved.rowsAffected) throw new Error("stale-experiment-head");
    }
    if (action) {
      const payload = typeof action.inversePayload === "object" && action.inversePayload != null
        ? action.inversePayload as Record<string, unknown> : {};
      await tx.insert(experimentActions).values({
        experimentId: sessionId, kind: action.kind,
        inversePayload: JSON.stringify({ ...payload, testIds: deletedIds, prevHeadTestId: current.headVersionId }),
      }).run();
    }
    return { deletedIds, newHeadTestId };
  });
  return { deletedIds: result?.deletedIds ?? [], headMoved: !!result && result.newHeadTestId !== currentHeadTestId,
    prevHeadTestId: currentHeadTestId, newHeadTestId: result?.newHeadTestId ?? currentHeadTestId };
}

/**
 * Restore path (design Phase 8): flips every node in `versionId`'s subtree that
 * is currently `status='deleted'` back to 'active'. Nodes in the subtree that
 * survived under another status are left untouched.
 */
export async function restoreTestSubtree(sessionId: number, versionId: number): Promise<number[]> {
  const allTests = await listExperimentVersions(sessionId, { includeDeleted: true });
  const subtreeIds = collectSubtreeIds(allTests, versionId);
  const byId = new Map(allTests.map((t) => [t.id, t]));
  const restoredIds = subtreeIds.filter((tid) => byId.get(tid)?.status === "deleted");
  await setTestsStatus(restoredIds, "active");
  return restoredIds;
}

export async function getExperimentVersion(id: number) {
  return (await db.select().from(experimentVersions).where(eq(experimentVersions.id, id)).get()) ?? null;
}

/**
 * Backfill/update a test node's F1 `setup_snapshot` (Phase 10). Used both to
 * stamp the base node once telemetry with `f1?.setup` first arrives (design
 * "base-capture timing") and by the live "capture current setup" action.
 * Never touches `setupPath` — file-based games don't call this.
 */
export async function updateExperimentVersionSetupSnapshot(id: number, setupSnapshot: string): Promise<void> {
  await db.update(experimentVersions).set({ setupSnapshot }).where(eq(experimentVersions.id, id)).run();
}

/** Set (or clear, with null) a version node's free-text driver note. This is the
 *  user's own annotation on a node — distinct from the applied-changes summary.
 *  Returns the prior value so the caller can log an inverse for undo. */
export async function setExperimentVersionNote(id: number, note: string | null): Promise<string | null> {
  const before = await getExperimentVersion(id);
  await db.update(experimentVersions).set({ driverComment: note }).where(eq(experimentVersions.id, id)).run();
  return before?.driverComment ?? null;
}

/** Set (or clear, with null) a version node's engineer/AI note — distinct from
 *  the driver's feel comment. Returns the prior value so the caller can log an
 *  inverse for undo. */
export async function setExperimentVersionNotes(id: number, notes: string | null): Promise<string | null> {
  const before = await getExperimentVersion(id);
  await db.update(experimentVersions).set({ notes }).where(eq(experimentVersions.id, id)).run();
  return before?.notes ?? null;
}

export async function setExperimentVersionNoteGuarded(
  id: number, note: string | null, sessionId: number, expectedHeadVersionId: number | null,
  action?: { kind: string; inversePayload: unknown },
): Promise<{ ok: boolean; previous: string | null }> {
  return db.transaction(async (tx) => {
    const current = await tx.select({ headVersionId: experiments.headVersionId })
      .from(experiments).where(eq(experiments.id, sessionId)).get();
    if (!current || current.headVersionId !== expectedHeadVersionId) return { ok: false, previous: null };
    const before = await tx.select({ driverComment: experimentVersions.driverComment })
      .from(experimentVersions).where(and(eq(experimentVersions.id, id), eq(experimentVersions.experimentId, sessionId))).get();
    if (!before) return { ok: false, previous: null };
    await tx.update(experimentVersions).set({ driverComment: note })
      .where(and(eq(experimentVersions.id, id), eq(experimentVersions.experimentId, sessionId))).run();
    const previous = before.driverComment ?? null;
    if (action) await tx.insert(experimentActions).values({
      experimentId: sessionId, kind: action.kind,
      inversePayload: JSON.stringify({ ...action.inversePayload as object, prevDriverComment: previous }),
    }).run();
    return { ok: true, previous };
  });
}

export async function setExperimentVersionNotesGuarded(
  id: number, notes: string | null, sessionId: number, expectedHeadVersionId: number | null,
  action?: { kind: string; inversePayload: unknown },
): Promise<{ ok: boolean; previous: string | null }> {
  return db.transaction(async (tx) => {
    const current = await tx.select({ headVersionId: experiments.headVersionId })
      .from(experiments).where(eq(experiments.id, sessionId)).get();
    if (!current || current.headVersionId !== expectedHeadVersionId) return { ok: false, previous: null };
    const before = await tx.select({ notes: experimentVersions.notes })
      .from(experimentVersions).where(and(eq(experimentVersions.id, id), eq(experimentVersions.experimentId, sessionId))).get();
    if (!before) return { ok: false, previous: null };
    await tx.update(experimentVersions).set({ notes })
      .where(and(eq(experimentVersions.id, id), eq(experimentVersions.experimentId, sessionId))).run();
    const previous = before.notes ?? null;
    if (action) await tx.insert(experimentActions).values({
      experimentId: sessionId, kind: action.kind,
      inversePayload: JSON.stringify({ ...action.inversePayload as object, prevNotes: previous }),
    }).run();
    return { ok: true, previous };
  });
}

/** Resolve one session's version node by its user-facing version number — used
 *  by the setup-engineer agent's note tool, which reasons in version numbers
 *  (never internal test ids). Null when no such version exists. */
export async function getExperimentVersionsByLabel(sessionId: number, version: number) {
  return await db
    .select()
    .from(experimentVersions)
    .where(and(eq(experimentVersions.experimentId, sessionId), eq(experimentVersions.version, version)))
    .get();
}

/** Next version number for a session — max(version) + 1, or 1 when none exist. */
export async function nextVersion(sessionId: number): Promise<number> {
  const row = await db
    .select({ maxVersion: sql<number | null>`MAX(${experimentVersions.version})` })
    .from(experimentVersions)
    .where(eq(experimentVersions.experimentId, sessionId))
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
    .select({ headVersionId: experiments.headVersionId })
    .from(experiments)
    .where(eq(experiments.id, sessionId))
    .get();
  if (session?.headVersionId != null) return session.headVersionId;

  const tip = await db
    .select({ id: experimentVersions.id })
    .from(experimentVersions)
    .where(eq(experimentVersions.experimentId, sessionId))
    .orderBy(desc(experimentVersions.version), desc(experimentVersions.id))
    .get();
  return tip?.id ?? null;
}

/** Lap count + best (min positive) lap time per experiment_version_id for a session. */
export async function getLapCountsByTest(
  sessionId: number,
): Promise<Map<number, { lapCount: number; bestLapMs: number | null }>> {
  const rows = await db
    .select({
      versionId: laps.experimentVersionId,
      lapCount: sql<number>`COUNT(*)`,
      bestLapMs: sql<number | null>`MIN(CASE WHEN ${laps.lapTime} > 0 THEN ${laps.lapTime} END)`,
    })
    .from(laps)
    .where(eq(laps.experimentId, sessionId))
    .groupBy(laps.experimentVersionId)
    .all();

  const map = new Map<number, { lapCount: number; bestLapMs: number | null }>();
  for (const r of rows) {
    if (r.versionId == null) continue;
    map.set(r.versionId, { lapCount: Number(r.lapCount), bestLapMs: r.bestLapMs ?? null });
  }
  return map;
}
