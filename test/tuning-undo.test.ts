import { beforeAll, describe, expect, test } from "bun:test";
import { createTuningSession, getTuningSession, setSessionHead } from "../server/db/tuning-session-queries";
import {
  createTuningTest,
  deleteTestSubtree,
  getTuningTest,
  listTuningTests,
  setTuningTestNotes,
} from "../server/db/tuning-test-queries";
import { recordAction, listActions } from "../server/db/tuning-action-queries";
import { undoLastAction } from "../server/tuning-undo";

/** Phase 9 — undo inverse logic. Exercises the shared `undoLastAction` core
 *  used by both the HTTP endpoint and the AI's `undo_last_action` tool:
 *  newest-first ordering, idempotency, and the delete/set-head inverses. */
describe("undoLastAction", () => {
  test("undoes set-head, restoring the prior head", async () => {
    const sid = await createTuningSession({ gameId: "acc", name: "undo-head" });
    const v1 = await createTuningTest({ tuningSessionId: sid, version: 1, label: "v1", parentTestId: null });
    const v2 = await createTuningTest({ tuningSessionId: sid, version: 2, label: "v2", parentTestId: v1 });
    await setSessionHead(sid, v1);

    // Simulate the /head route: capture prevHead before moving, then log it.
    const prevHeadTestId = (await getTuningSession(sid))!.headTestId;
    await setSessionHead(sid, v2);
    await recordAction(sid, "set-head", { prevHeadTestId });

    expect((await getTuningSession(sid))!.headTestId).toBe(v2);
    const result = await undoLastAction(sid);
    expect(result.ok).toBe(true);
    expect(result.undone).toBe(true);
    expect(result.kind).toBe("set-head");
    expect((await getTuningSession(sid))!.headTestId).toBe(v1);
  });

  test("undoes edit-test-notes, restoring the prior engineer note", async () => {
    const sid = await createTuningSession({ gameId: "acc", name: "undo-notes" });
    const v1 = await createTuningTest({ tuningSessionId: sid, version: 1, label: "v1", parentTestId: null });

    // Simulate the add-note tool / PATCH route: set the note, log the prior value.
    const prevNotes = await setTuningTestNotes(v1, "trying softer front ARB");
    await recordAction(sid, "edit-test-notes", { testId: v1, prevNotes });
    expect((await getTuningTest(v1))?.notes).toBe("trying softer front ARB");

    const result = await undoLastAction(sid);
    expect(result.ok).toBe(true);
    expect(result.kind).toBe("edit-test-notes");
    // Prior value was null (fresh node) → note cleared.
    expect((await getTuningTest(v1))?.notes).toBeNull();
  });

  test("undo of delete restores the subtree and prior head; second undo call is a no-op", async () => {
    const sid = await createTuningSession({ gameId: "acc", name: "undo-delete" });
    const v1 = await createTuningTest({ tuningSessionId: sid, version: 1, label: "v1", parentTestId: null });
    const v2 = await createTuningTest({ tuningSessionId: sid, version: 2, label: "v2", parentTestId: v1 });
    await setSessionHead(sid, v2);

    // Simulate the /tests/:testId/delete route's own recordAction call shape.
    const session = await getTuningSession(sid);
    const delResult = await deleteTestSubtree(sid, v2, session!.headTestId ?? null);
    await recordAction(sid, "delete", {
      rootTestId: v2,
      testIds: delResult.deletedIds,
      prevHeadTestId: delResult.headMoved ? delResult.prevHeadTestId : null,
    });

    // v2 is gone from the active list, head moved back to v1 (nearest surviving ancestor).
    const activeAfterDelete = await listTuningTests(sid);
    expect(activeAfterDelete.some((t) => t.id === v2)).toBe(false);
    expect((await getTuningSession(sid))!.headTestId).toBe(v1);

    const result = await undoLastAction(sid);
    expect(result.ok).toBe(true);
    expect(result.undone).toBe(true);
    expect(result.kind).toBe("delete");
    const activeAfterUndo = await listTuningTests(sid);
    expect(activeAfterUndo.some((t) => t.id === v2)).toBe(true);
    expect((await getTuningSession(sid))!.headTestId).toBe(v2);

    // Idempotent: nothing left to undo now.
    const second = await undoLastAction(sid);
    expect(second.ok).toBe(true);
    expect(second.undone).toBe(false);
  });

  test("newest-first: undoing twice reverses actions in reverse chronological order", async () => {
    const sid = await createTuningSession({ gameId: "acc", name: "undo-order" });
    const v1 = await createTuningTest({ tuningSessionId: sid, version: 1, label: "v1", parentTestId: null });
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
    expect((await getTuningSession(sid))!.headTestId).toBe(null);

    const second = await undoLastAction(sid);
    expect(second.undone).toBe(true);
    expect((await getTuningSession(sid))!.headTestId).toBe(v1);

    const third = await undoLastAction(sid);
    expect(third.undone).toBe(false);
  });
});
