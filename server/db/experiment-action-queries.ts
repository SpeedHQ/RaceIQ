/**
 * Tuning-action log queries (migration v30, docs/setup-engineer-flow-design.md
 * §Phase 9). The append-only log that backs session-scoped undo: every mutating
 * op records its inverse via `recordAction`, `undo` walks newest-first via
 * `listActions` and flips `undone` via `markUndone`.
 *
 * Kept deliberately small and blob-free — `inversePayload` stores only the refs
 * needed to reverse an op (created versionId, prior head id, prior lap stamps), so
 * full-session depth stays cheap.
 */
import { and, desc, eq } from "drizzle-orm";
import { db } from "./index";
import { experimentActions } from "./schema";

/** The mutating op kinds the log records. Matches the Phase 9 design list. */
export type ExperimentActionKind =
  | "apply-changes"
  | "branch"
  | "add-base"
  | "import-laps"
  | "set-head"
  | "delete"
  | "restore"
  | "rename-note"
  | "edit-test-note"
  | "edit-test-notes"
  | "set-lap-excluded";

export interface ExperimentAction {
  id: number;
  experimentId: number;
  kind: ExperimentActionKind;
  /** Parsed inverse payload (whatever the op needs to reverse itself). */
  inversePayload: unknown;
  undone: boolean;
  createdAt: string;
}

/**
 * Record one mutating op's inverse. `inversePayload` is any JSON-serialisable
 * ref set — it is stringified here so callers pass a plain object.
 */
export async function recordAction(
  experimentId: number,
  kind: ExperimentActionKind,
  inversePayload: unknown,
): Promise<number> {
  const result = await db
    .insert(experimentActions)
    .values({
      experimentId,
      kind,
      inversePayload: inversePayload == null ? null : JSON.stringify(inversePayload),
    })
    .returning({ id: experimentActions.id })
    .get();
  return result.id;
}

/** Session actions, newest-first. `onlyPending` drops already-undone rows. */
export async function listActions(
  experimentId: number,
  onlyPending = false,
): Promise<ExperimentAction[]> {
  const where = onlyPending
    ? and(eq(experimentActions.experimentId, experimentId), eq(experimentActions.undone, false))
    : eq(experimentActions.experimentId, experimentId);
  const rows = await db
    .select()
    .from(experimentActions)
    .where(where)
    .orderBy(desc(experimentActions.id))
    .all();
  return rows.map((r) => ({
    id: r.id,
    experimentId: r.experimentId,
    kind: r.kind as ExperimentActionKind,
    inversePayload: r.inversePayload == null ? null : safeParse(r.inversePayload),
    undone: r.undone,
    createdAt: r.createdAt,
  }));
}

/** Flip an action's `undone` flag (idempotent — undo marks after reversing). */
export async function markUndone(actionId: number): Promise<void> {
  await db.update(experimentActions).set({ undone: true }).where(eq(experimentActions.id, actionId)).run();
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}
