/**
 * Undo (docs/architecture/setup-engineer.md) — reverses the newest
 * not-yet-undone `experiment_actions` row for a session by applying its
 * `kind`-specific inverse, then flips `undone`. Shared by the HTTP endpoint
 * (`POST /api/experiments/:id/undo`) and the AI's `undo_last_action`
 * tool so both surfaces run identical logic.
 *
 * Idempotent by construction: `listActions(id, true)` only ever returns rows
 * with `undone=false`, so a second call naturally picks the next action back
 * (or finds nothing) rather than re-applying the same inverse.
 *
 * Guard (design issue F): undoing apply-changes/branch/add-base
 * soft-deletes the tuning-test node the action created. If laps have since
 * been driven on that node (or it grew children), those would be orphaned
 * onto a trashed node — so, like delete, the WHOLE subtree is soft-deleted
 * (laps survive on the trashed node; restore brings them back) and a warning
 * is returned instead of silently stranding anything.
 */
import { getExperiment, setSessionHead, updateExperiment } from "../db/experiment-queries";
import {
  deleteTestSubtree,
  getLapCountsByTest,
  getExperimentVersion,
  listExperimentVersions,
  restoreTestSubtree,
  setExperimentVersionNote,
  setExperimentVersionNotes,
} from "../db/experiment-version-queries";
import { listActions, markUndone, type ExperimentAction } from "../db/experiment-action-queries";
import { setLapExperimentExcluded, unstampLapsFromExperiment } from "../db/experiment-lap-queries";

export interface UndoResult {
  ok: boolean;
  error?: string;
  undone: boolean;
  kind?: ExperimentAction["kind"];
  actionId?: number;
  warning?: string;
}

export async function undoLastAction(sessionId: number): Promise<UndoResult> {
  const session = await getExperiment(sessionId);
  if (!session) return { ok: false, undone: false, error: "Tuning session not found" };

  const pending = await listActions(sessionId, true); // newest-first, undone=false only
  const action = pending[0];
  if (!action) return { ok: true, undone: false };
  // Idempotency belt-and-braces: listActions already filters undone=false, but
  // re-check in case of a race between the read and the write below.
  if (action.undone) return { ok: true, undone: false };

  let warning: string | undefined;

  switch (action.kind) {
    case "apply-changes":
    case "branch":
    case "add-base": {
      const payload = action.inversePayload as { versionId: number; prevHeadTestId: number | null } | null;
      if (payload?.versionId != null) {
        const test = await getExperimentVersion(payload.versionId);
        if (test && test.status !== "deleted") {
          const [counts, allTests] = await Promise.all([getLapCountsByTest(sessionId), listExperimentVersions(sessionId, { includeDeleted: true })]);
          const lapCount = counts.get(payload.versionId)?.lapCount ?? 0;
          const hasChildren = allTests.some((t) => t.parentVersionId === payload.versionId);
          if (lapCount > 0 || hasChildren) {
            const parts = [lapCount > 0 ? `${lapCount} lap${lapCount === 1 ? "" : "s"}` : null, hasChildren ? "child branches" : null].filter(Boolean);
            warning = `This version has ${parts.join(" and ")} — undoing trashes them too; they're restorable from the trash.`;
          }
          await deleteTestSubtree(sessionId, payload.versionId, session.headVersionId ?? null);
        }
        await setSessionHead(sessionId, payload.prevHeadTestId);
      }
      break;
    }
    case "import-laps": {
      const payload = action.inversePayload as { lapIds: number[] } | null;
      if (payload?.lapIds?.length) await unstampLapsFromExperiment(sessionId, payload.lapIds);
      break;
    }
    case "set-head": {
      const payload = action.inversePayload as { prevHeadTestId: number | null } | null;
      await setSessionHead(sessionId, payload?.prevHeadTestId ?? null);
      break;
    }
    case "delete": {
      const payload = action.inversePayload as { rootTestId: number; prevHeadTestId: number | null } | null;
      if (payload?.rootTestId != null) {
        await restoreTestSubtree(sessionId, payload.rootTestId);
        if (payload.prevHeadTestId != null) await setSessionHead(sessionId, payload.prevHeadTestId);
      }
      break;
    }
    case "restore": {
      const payload = action.inversePayload as { rootTestId: number } | null;
      if (payload?.rootTestId != null) {
        await deleteTestSubtree(sessionId, payload.rootTestId, session.headVersionId ?? null);
      }
      break;
    }
    case "rename-note": {
      const payload = action.inversePayload as Partial<{ name: string; notes: string | null; baseSetupPath: string | null; status: string }> | null;
      if (payload) await updateExperiment(sessionId, payload);
      break;
    }
    case "edit-test-note": {
      const payload = action.inversePayload as { versionId: number; prevDriverComment: string | null } | null;
      if (payload?.versionId != null) await setExperimentVersionNote(payload.versionId, payload.prevDriverComment);
      break;
    }
    case "edit-test-notes": {
      const payload = action.inversePayload as { versionId: number; prevNotes: string | null } | null;
      if (payload?.versionId != null) await setExperimentVersionNotes(payload.versionId, payload.prevNotes);
      break;
    }
    case "set-lap-excluded": {
      const payload = action.inversePayload as { lapId: number; prevExcluded: boolean } | null;
      if (payload?.lapId != null) {
        const result = await setLapExperimentExcluded(payload.lapId, action.experimentId, payload.prevExcluded);
        if (!result.ok) return { ok: false, undone: false, error: "Lap is no longer in this experiment" };
      }
      break;
    }
    default:
      break;
  }

  await markUndone(action.id);
  return { ok: true, undone: true, kind: action.kind, actionId: action.id, warning };
}
