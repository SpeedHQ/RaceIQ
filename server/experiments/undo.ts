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
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import { experiments, experimentActions, experimentVersions, laps } from "../db/schema";
import type { ExperimentAction } from "../db/experiment-action-queries";

export interface UndoResult {
  ok: boolean;
  error?: string;
  undone: boolean;
  kind?: ExperimentAction["kind"];
  actionId?: number;
  warning?: string;
  headVersionId?: number | null;
}

export async function undoLastAction(sessionId: number, expectedHeadVersionId?: number | null): Promise<UndoResult> {
  let warning: string | undefined;
  const result = await db.transaction(async (tx) => {
    const session = await tx.select({ headVersionId: experiments.headVersionId })
      .from(experiments).where(eq(experiments.id, sessionId)).get();
    if (!session) return { error: "Tuning session not found" as const };
    if (expectedHeadVersionId !== undefined && session.headVersionId !== expectedHeadVersionId) {
      return { error: "stale-experiment-head" as const };
    }
    const action = await tx.select().from(experimentActions)
      .where(and(eq(experimentActions.experimentId, sessionId), eq(experimentActions.undone, false)))
      .orderBy(desc(experimentActions.id)).get();
    if (!action) return { action: null };
    const payload = parsePayload(action.inversePayload);
    const moveHead = async (headVersionId: number | null) =>
      tx.update(experiments).set({ headVersionId }).where(eq(experiments.id, sessionId)).run();
    const flipSubtree = async (rootId: number, status: string) => {
      const rows = await tx.select({ id: experimentVersions.id, parentVersionId: experimentVersions.parentVersionId })
        .from(experimentVersions).where(eq(experimentVersions.experimentId, sessionId)).all();
      const children = new Map<number, number[]>();
      for (const row of rows) {
        if (row.parentVersionId == null) continue;
        const list = children.get(row.parentVersionId) ?? [];
        list.push(row.id);
        children.set(row.parentVersionId, list);
      }
      const ids: number[] = [];
      const visited = new Set<number>();
      const stack = [rootId];
      while (stack.length) {
        const id = stack.pop()!;
        if (visited.has(id)) continue;
        visited.add(id);
        ids.push(id);
        stack.push(...(children.get(id) ?? []));
      }
      if (ids.length) await tx.update(experimentVersions).set({ status }).where(and(
        eq(experimentVersions.experimentId, sessionId), inArray(experimentVersions.id, ids),
      )).run();
      return ids;
    };
    switch (action.kind) {
      case "apply-changes":
      case "branch":
      case "add-base": {
        const versionId = numberValue(payload.versionId);
        if (versionId != null) {
          const version = await tx.select({ status: experimentVersions.status }).from(experimentVersions)
            .where(eq(experimentVersions.id, versionId)).get();
          if (version && version.status !== "deleted") {
            const lapCountRow = await tx.select({ count: sql<number>`COUNT(*)` }).from(laps)
              .where(and(eq(laps.experimentId, sessionId), eq(laps.experimentVersionId, versionId))).get();
            const rows = await tx.select({ parentVersionId: experimentVersions.parentVersionId }).from(experimentVersions)
              .where(eq(experimentVersions.experimentId, sessionId)).all();
            const lapCount = Number(lapCountRow?.count ?? 0);
            const hasChildren = rows.some((row) => row.parentVersionId === versionId);
            if (lapCount || hasChildren) {
              const details = [lapCount ? `${lapCount} lap${lapCount === 1 ? "" : "s"}` : null, hasChildren ? "child branches" : null].filter(Boolean);
              warning = `This version has ${details.join(" and ")} — undoing trashes them too; they're restorable from the trash.`;
            }
            await flipSubtree(versionId, "deleted");
          }
        }
        await moveHead(numberValue(payload.prevHeadTestId));
        break;
      }
      case "import-laps": {
        const lapIds = numberArray(payload.lapIds);
        if (lapIds.length) await tx.update(laps).set({ experimentId: null, experimentVersionId: null })
          .where(and(eq(laps.experimentId, sessionId), inArray(laps.id, lapIds))).run();
        break;
      }
      case "set-head":
        await moveHead(numberValue(payload.prevHeadTestId));
        break;
      case "delete": {
        const rootId = numberValue(payload.rootTestId);
        if (rootId != null) {
          if (Array.isArray(payload.testIds)) {
            const ids = numberArray(payload.testIds);
            if (ids.length) await tx.update(experimentVersions).set({ status: "active" }).where(and(
              eq(experimentVersions.experimentId, sessionId), inArray(experimentVersions.id, ids),
            )).run();
          } else {
            await flipSubtree(rootId, "active");
          }
          const prevHead = numberValue(payload.prevHeadTestId);
          // Legacy payloads used null for unchanged heads; moved heads always
          // had a non-null prior version.
          const headChanged = typeof payload.headChanged === "boolean"
            ? payload.headChanged
            : prevHead != null;
          if (headChanged) await moveHead(prevHead);
        }
        break;
      }
      case "restore": {
        const hasRecordedIds = Array.isArray(payload.testIds);
        let restoredIds = hasRecordedIds ? numberArray(payload.testIds) : [];
        if (!hasRecordedIds) {
          const rootId = numberValue(payload.rootTestId);
          if (rootId != null) restoredIds = await flipSubtree(rootId, "deleted");
        } else if (restoredIds.length) {
          await tx.update(experimentVersions).set({ status: "deleted" }).where(and(
            eq(experimentVersions.experimentId, sessionId), inArray(experimentVersions.id, restoredIds),
          )).run();
        }
        const restored = new Set(restoredIds);
        const headId = session.headVersionId;
        if (headId != null && restored.has(headId)) {
          const rows = await tx.select({ id: experimentVersions.id, parentVersionId: experimentVersions.parentVersionId, status: experimentVersions.status })
            .from(experimentVersions).where(eq(experimentVersions.experimentId, sessionId)).all();
          const byId = new Map(rows.map((row) => [row.id, row]));
          let parentId = byId.get(headId)?.parentVersionId ?? null;
          while (parentId != null && (restored.has(parentId) || byId.get(parentId)?.status === "deleted")) {
            parentId = byId.get(parentId)?.parentVersionId ?? null;
          }
          await moveHead(parentId);
        }
        break;
      }
      case "rename-note": {
        const updates: { name?: string; notes?: string | null; baseSetupPath?: string | null; status?: string } = {};
        if (typeof payload.name === "string") updates.name = payload.name;
        if ("notes" in payload) updates.notes = stringOrNull(payload.notes);
        if ("baseSetupPath" in payload) updates.baseSetupPath = stringOrNull(payload.baseSetupPath);
        if (typeof payload.status === "string") updates.status = payload.status;
        if (Object.keys(updates).length) await tx.update(experiments).set(updates).where(eq(experiments.id, sessionId)).run();
        break;
      }
      case "edit-test-note": {
        const versionId = numberValue(payload.versionId);
        if (versionId != null) await tx.update(experimentVersions)
          .set({ driverComment: stringOrNull(payload.prevDriverComment) })
          .where(and(eq(experimentVersions.id, versionId), eq(experimentVersions.experimentId, sessionId))).run();
        break;
      }
      case "edit-test-notes": {
        const versionId = numberValue(payload.versionId);
        if (versionId != null) await tx.update(experimentVersions)
          .set({ notes: stringOrNull(payload.prevNotes) })
          .where(and(eq(experimentVersions.id, versionId), eq(experimentVersions.experimentId, sessionId))).run();
        break;
      }
      case "set-lap-excluded": {
        const lapId = numberValue(payload.lapId);
        if (lapId != null) await tx.update(laps).set({
          experimentExcluded: payload.prevExcluded === true ? 1 : null,
          experimentExcludedSource: "prevExcludedSource" in payload
            ? stringOrNull(payload.prevExcludedSource)
            : "manual",
        }).where(and(eq(laps.id, lapId), eq(laps.experimentId, sessionId))).run();
        break;
      }
      default:
        break;
    }
    await tx.update(experimentActions).set({ undone: true }).where(and(
      eq(experimentActions.id, action.id), eq(experimentActions.experimentId, sessionId), eq(experimentActions.undone, false),
    )).run();
    const updatedSession = await tx.select({ headVersionId: experiments.headVersionId })
      .from(experiments).where(eq(experiments.id, sessionId)).get();
    return { action, headVersionId: updatedSession?.headVersionId ?? null };
  });
  if ("error" in result) return {
    ok: false, undone: false,
    error: result.error === "stale-experiment-head"
      ? "Experiment version changed during this turn. Refresh before undoing actions."
      : result.error,
  };
  if (!result.action) return { ok: true, undone: false };
  return { ok: true, undone: true, kind: result.action.kind as ExperimentAction["kind"], actionId: result.action.id, warning, headVersionId: result.headVersionId };
}

function parsePayload(raw: string | null): Record<string, unknown> {
  if (raw == null) return {};
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberArray(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((item): item is number => typeof item === "number" && Number.isFinite(item)) : [];
}
