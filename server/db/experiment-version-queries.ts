import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { db } from "./index";
import { laps, experiments, experimentVersions } from "./schema";
import { setSessionHead } from "./experiment-queries";
import { DEFAULT_EXPERIMENT_FOCUS, type ExperimentFocus, versionKindForFocus, type VersionKind } from "../../shared/racing/experiments/focus";
import { selectEvaluationLaps } from "../../shared/racing/laps/review-selection";

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
    const parent = await db.select({ focus: experiments.focus }).from(experiments).where(eq(experiments.id, data.experimentId)).get();
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
function collectSubtreeIds(tests: { id: number; parentVersionId: number | null }[], rootId: number): number[] {
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
function findNearestSurvivingAncestor(tests: { id: number; parentVersionId: number | null; status: string }[], fromId: number, trashedIds: Set<number>): number | null {
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
export async function deleteTestSubtree(sessionId: number, versionId: number, currentHeadTestId: number | null): Promise<DeleteSubtreeResult> {
  const allTests = await listExperimentVersions(sessionId, { includeDeleted: true });
  const deletedIds = collectSubtreeIds(allTests, versionId);
  await setTestsStatus(deletedIds, "deleted");

  const trashedSet = new Set(deletedIds);
  let headMoved = false;
  let newHeadTestId = currentHeadTestId;
  if (currentHeadTestId != null && trashedSet.has(currentHeadTestId)) {
    newHeadTestId = findNearestSurvivingAncestor(allTests, versionId, trashedSet);
    await setSessionHead(sessionId, newHeadTestId);
    headMoved = true;
  }

  return { deletedIds, headMoved, prevHeadTestId: currentHeadTestId, newHeadTestId };
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
  const session = await db.select({ headVersionId: experiments.headVersionId }).from(experiments).where(eq(experiments.id, sessionId)).get();
  if (session?.headVersionId != null) return session.headVersionId;

  const tip = await db
    .select({ id: experimentVersions.id })
    .from(experimentVersions)
    .where(eq(experimentVersions.experimentId, sessionId))
    .orderBy(desc(experimentVersions.version), desc(experimentVersions.id))
    .get();
  return tip?.id ?? null;
}

/** Recorded-lap count plus best pace-eligible lap time per experiment version. */
export async function getLapCountsByTest(sessionId: number): Promise<Map<number, { lapCount: number; bestLapMs: number | null }>> {
  const rows = await db
    .select({
      id: laps.id,
      versionId: laps.experimentVersionId,
      lapTime: laps.lapTime,
      isValid: laps.isValid,
      quality: laps.quality,
      eligibility: laps.eligibility,
      experimentExcluded: laps.experimentExcluded,
      experimentExcludedSource: laps.experimentExcludedSource,
    })
    .from(laps)
    .where(eq(laps.experimentId, sessionId))
    .all();

  const grouped = new Map<number, typeof rows>();
  for (const row of rows) {
    if (row.versionId == null) continue;
    const existing = grouped.get(row.versionId);
    if (existing) existing.push(row);
    else grouped.set(row.versionId, [row]);
  }

  const result = new Map<number, { lapCount: number; bestLapMs: number | null }>();
  for (const [versionId, versionLaps] of grouped) {
    const selection = selectEvaluationLaps(
      versionLaps.map((lap) => ({
        ...lap,
        experimentExcluded: lap.experimentExcluded === 1,
        experimentExcludedSource: lap.experimentExcludedSource === "auto" || lap.experimentExcludedSource === "manual" ? lap.experimentExcludedSource : null,
      })),
      Number.POSITIVE_INFINITY,
    );
    const usableLapTimes = selection.chosen.map(({ lapTime }) => lapTime);
    result.set(versionId, {
      lapCount: versionLaps.length,
      bestLapMs: usableLapTimes.length > 0 ? Math.min(...usableLapTimes) : null,
    });
  }
  return result;
}
