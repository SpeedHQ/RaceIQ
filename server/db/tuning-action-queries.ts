/**
 * Tuning-action log queries (migration v30, docs/setup-engineer-flow-design.md
 * §Phase 9). The append-only log that backs session-scoped undo: every mutating
 * op records its inverse via `recordAction`, `undo` walks newest-first via
 * `listActions` and flips `undone` via `markUndone`.
 *
 * Kept deliberately small and blob-free — `inversePayload` stores only the refs
 * needed to reverse an op (created testId, prior head id, prior lap stamps), so
 * full-session depth stays cheap.
 */
import { and, desc, eq } from "drizzle-orm";
import { db } from "./index";
import { tuningActions } from "./schema";

/** The mutating op kinds the log records. Matches the Phase 9 design list. */
export type TuningActionKind =
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

export interface TuningAction {
  id: number;
  tuningSessionId: number;
  kind: TuningActionKind;
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
  tuningSessionId: number,
  kind: TuningActionKind,
  inversePayload: unknown,
): Promise<number> {
  const result = await db
    .insert(tuningActions)
    .values({
      tuningSessionId,
      kind,
      inversePayload: inversePayload == null ? null : JSON.stringify(inversePayload),
    })
    .returning({ id: tuningActions.id })
    .get();
  return result.id;
}

/** Session actions, newest-first. `onlyPending` drops already-undone rows. */
export async function listActions(
  tuningSessionId: number,
  onlyPending = false,
): Promise<TuningAction[]> {
  const where = onlyPending
    ? and(eq(tuningActions.tuningSessionId, tuningSessionId), eq(tuningActions.undone, false))
    : eq(tuningActions.tuningSessionId, tuningSessionId);
  const rows = await db
    .select()
    .from(tuningActions)
    .where(where)
    .orderBy(desc(tuningActions.id))
    .all();
  return rows.map((r) => ({
    id: r.id,
    tuningSessionId: r.tuningSessionId,
    kind: r.kind as TuningActionKind,
    inversePayload: r.inversePayload == null ? null : safeParse(r.inversePayload),
    undone: r.undone,
    createdAt: r.createdAt,
  }));
}

/** Flip an action's `undone` flag (idempotent — undo marks after reversing). */
export async function markUndone(actionId: number): Promise<void> {
  await db.update(tuningActions).set({ undone: true }).where(eq(tuningActions.id, actionId)).run();
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}
