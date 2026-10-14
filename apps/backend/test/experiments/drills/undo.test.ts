import { describe, expect, test } from "bun:test";
import { createExperiment, getExperiment, setSessionHead } from "@raceiq/backend-core/db/experiment-queries";
import {
  createExperimentVersion,
  deleteTestSubtree,
  getExperimentVersion,
  listExperimentVersions,
  restoreTestSubtree,
  setExperimentVersionNotes,
} from "@raceiq/backend-core/db/experiment-version-queries";
import { recordAction, listActions } from "@raceiq/backend-core/db/experiment-action-queries";
import { undoLastAction } from "@raceiq/backend-core/experiments/undo"

/** Phase 9 — undo inverse logic. Exercises the shared `undoLastAction` core
 *  used by both the HTTP endpoint and the AI's `undo_last_action` tool:
 *  newest-first ordering, idempotency, and the delete/set-head inverses. */
describe("undoLastAction", () => {
  test("undoes set-head, restoring the prior head", async () => {
    const sid = await createExperiment({ gameId: "acc", name: "undo-head" });
    const v1 = await createExperimentVersion({ experimentId: sid, version: 1, label: "v1", parentVersionId: null });
    const v2 = await createExperimentVersion({ experimentId: sid, version: 2, label: "v2", parentVersionId: v1 });
    await setSessionHead(sid, v1);

    // Simulate the /head route: capture prevHead before moving, then log it.
    const prevHeadTestId = (await getExperiment(sid))!.headVersionId;
    await setSessionHead(sid, v2);
    await recordAction(sid, "set-head", { prevHeadTestId });

    expect((await getExperiment(sid))!.headVersionId).toBe(v2);
    const result = await undoLastAction(sid);
    expect(result.ok).toBe(true);
    expect(result.undone).toBe(true);
    expect(result.kind).toBe("set-head");
    expect((await getExperiment(sid))!.headVersionId).toBe(v1);
  });

  test("undoes edit-test-notes, restoring the prior engineer note", async () => {
    const sid = await createExperiment({ gameId: "acc", name: "undo-notes" });
    const v1 = await createExperimentVersion({ experimentId: sid, version: 1, label: "v1", parentVersionId: null });

    // Simulate the add-note tool / PATCH route: set the note, log the prior value.
    const prevNotes = await setExperimentVersionNotes(v1, "trying softer front ARB");
    await recordAction(sid, "edit-test-notes", { versionId: v1, prevNotes });
    expect((await getExperimentVersion(v1))?.notes).toBe("trying softer front ARB");

    const result = await undoLastAction(sid);
    expect(result.ok).toBe(true);
    expect(result.kind).toBe("edit-test-notes");
    // Prior value was null (fresh node) → note cleared.
    expect((await getExperimentVersion(v1))?.notes).toBeNull();
  });

  test("undo of delete restores the subtree and prior head; second undo call is a no-op", async () => {
    const sid = await createExperiment({ gameId: "acc", name: "undo-delete" });
    const v1 = await createExperimentVersion({ experimentId: sid, version: 1, label: "v1", parentVersionId: null });
    const v2 = await createExperimentVersion({ experimentId: sid, version: 2, label: "v2", parentVersionId: v1 });
    await setSessionHead(sid, v2);

    // Simulate the /tests/:versionId/delete route's own recordAction call shape.
    const session = await getExperiment(sid);
    const delResult = await deleteTestSubtree(sid, v2, session!.headVersionId ?? null);
    await recordAction(sid, "delete", {
      rootTestId: v2,
      testIds: delResult.deletedIds,
      headChanged: delResult.headMoved,
      ...(delResult.headMoved ? { prevHeadTestId: delResult.prevHeadTestId } : {}),
    });

    // v2 is gone from the active list, head moved back to v1 (nearest surviving ancestor).
    const activeAfterDelete = await listExperimentVersions(sid);
    expect(activeAfterDelete.some((t) => t.id === v2)).toBe(false);
    expect((await getExperiment(sid))!.headVersionId).toBe(v1);

    const result = await undoLastAction(sid);
    expect(result.ok).toBe(true);
    expect(result.undone).toBe(true);
    expect(result.kind).toBe("delete");
    const activeAfterUndo = await listExperimentVersions(sid);
    expect(activeAfterUndo.some((t) => t.id === v2)).toBe(true);
    expect((await getExperiment(sid))!.headVersionId).toBe(v2);

    // Idempotent: nothing left to undo now.
    const second = await undoLastAction(sid);
    expect(second.ok).toBe(true);
    expect(second.undone).toBe(false);
  });

  test("undoing sibling delete preserves unchanged head", async () => {
    const sid = await createExperiment({ gameId: "acc", name: "undo-sibling-delete" });
    const a = await createExperimentVersion({ experimentId: sid, version: 1, label: "a", parentVersionId: null });
    const b = await createExperimentVersion({ experimentId: sid, version: 2, label: "b", parentVersionId: null });
    await setSessionHead(sid, a);
    const delResult = await deleteTestSubtree(sid, b, a);
    await recordAction(sid, "delete", {
      rootTestId: b, testIds: delResult.deletedIds, headChanged: delResult.headMoved,
    });
    await undoLastAction(sid);
    expect((await getExperiment(sid))!.headVersionId).toBe(a);
    expect((await getExperimentVersion(b))!.status).toBe("active");
  });

  test("undoing partial restore deletes only restored IDs and relocates restored head", async () => {
    const sid = await createExperiment({ gameId: "acc", name: "undo-partial-restore" });
    const parent = await createExperimentVersion({ experimentId: sid, version: 1, label: "parent", parentVersionId: null });
    const child = await createExperimentVersion({ experimentId: sid, version: 2, label: "child", parentVersionId: parent });
    await deleteTestSubtree(sid, parent, child);
    const restoredChildIds = await restoreTestSubtree(sid, child);
    await recordAction(sid, "restore", { rootTestId: child, testIds: restoredChildIds });
    const restoredParentIds = await restoreTestSubtree(sid, parent);
    await recordAction(sid, "restore", { rootTestId: parent, testIds: restoredParentIds });
    await setSessionHead(sid, parent);

    await undoLastAction(sid);

    expect((await getExperimentVersion(parent))!.status).toBe("deleted");
    expect((await getExperimentVersion(child))!.status).toBe("active");
    expect((await getExperiment(sid))!.headVersionId).toBeNull();
  });

  test("undo of restore with empty recorded IDs changes nothing", async () => {
    const sid = await createExperiment({ gameId: "acc", name: "undo-empty-restore" });
    const v1 = await createExperimentVersion({ experimentId: sid, version: 1, label: "v1", parentVersionId: null });
    await recordAction(sid, "restore", { rootTestId: v1, testIds: [] });

    await undoLastAction(sid);

    expect((await getExperimentVersion(v1))!.status).toBe("active");
  });

  test("newest-first: undoing twice reverses actions in reverse chronological order", async () => {
    const sid = await createExperiment({ gameId: "acc", name: "undo-order" });
    const v1 = await createExperimentVersion({ experimentId: sid, version: 1, label: "v1", parentVersionId: null });
    await setSessionHead(sid, v1);

    await setSessionHead(sid, null);
    await recordAction(sid, "set-head", { prevHeadTestId: v1 });

    await setSessionHead(sid, v1);
    await recordAction(sid, "set-head", { prevHeadTestId: null });

    const pending = await listActions(sid, true);
    expect(pending.length).toBe(2);
    // newest-first: the last recorded action (prevHeadTestId: null) comes first.
    expect(pending[0].inversePayload).toEqual({ prevHeadTestId: null });

    const first = await undoLastAction(sid);
    expect(first.undone).toBe(true);
    expect((await getExperiment(sid))!.headVersionId).toBe(null);

    const second = await undoLastAction(sid);
    expect(second.undone).toBe(true);
    expect((await getExperiment(sid))!.headVersionId).toBe(v1);

    const third = await undoLastAction(sid);
    expect(third.undone).toBe(false);
  });
  test("stale branch head leaves inverse effects and action log untouched", async () => {
    const sid = await createExperiment({ gameId: "acc", name: "undo-stale-head" });
    const v1 = await createExperimentVersion({ experimentId: sid, version: 1, label: "v1" });
    const v2 = await createExperimentVersion({ experimentId: sid, version: 2, label: "v2", parentVersionId: v1 });
    await setSessionHead(sid, v2);
    await recordAction(sid, "set-head", { prevHeadTestId: v1 });

    const result = await undoLastAction(sid, v1);
    expect(result.ok).toBe(false);
    expect(result.undone).toBe(false);
    expect((await getExperiment(sid))!.headVersionId).toBe(v2);
    expect((await listActions(sid, true))).toHaveLength(1);
  });
});
