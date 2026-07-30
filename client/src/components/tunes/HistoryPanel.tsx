import { createPortal } from "react-dom";
import { type ExperimentActionRow, useExperimentHistory, useExperimentVersions, useUndo } from "../../hooks/queries";
import { FocusTimeline } from "./FocusTimeline";

/**
 * History panel (design Phase 9) — session-scoped, newest-first action log
 * with a single top-level Undo button that reverses exactly the newest
 * not-yet-undone action (idempotent: once everything's undone, the button
 * disables). Already-undone rows render struck-through so the log stays a
 * full audit trail rather than disappearing entries.
 */
export function HistoryPanel({ sessionId, onClose }: { sessionId: number; onClose: () => void }) {
  const { data: actions = [], isLoading } = useExperimentHistory(sessionId);
  // Version labels so the timeline can say WHERE a focus era began.
  const { data: versions = [] } = useExperimentVersions(sessionId);
  const undo = useUndo();
  const nextPending = actions.find((a) => !a.undone);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-app-bg/60"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="bg-app-surface border border-app-border rounded-lg shadow-xl w-[520px] max-w-[94vw] max-h-[80vh] flex flex-col gap-3 p-5"
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
        }}
      >
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold text-app-text">History</p>
          <button type="button" onClick={onClose} className="text-app-text-dim hover:text-app-text text-xl leading-none">
            ×
          </button>
        </div>

        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-app-text-dim">{nextPending ? `Undo reverses: ${describeAction(nextPending)}` : "Nothing left to undo."}</p>
          <button
            type="button"
            onClick={() => undo.mutate({ sessionId })}
            disabled={!nextPending || undo.isPending}
            className="shrink-0 px-3 py-1.5 text-xs rounded bg-app-accent hover:bg-app-accent-hover disabled:opacity-40 text-app-on-filled font-semibold"
          >
            {undo.isPending ? "Undoing…" : "Undo last"}
          </button>
        </div>

        {/* What the session was WORKING ON over time, above what was done to
            it — a switch from the car to the driver is the context that makes
            the action log below readable. */}
        <div className="rounded border border-app-border p-3">
          <div className="text-[10px] uppercase tracking-wider text-app-text-muted mb-1.5">Focus</div>
          <FocusTimeline experimentId={sessionId} versions={versions} />
        </div>

        {undo.data?.warning && <div className="text-xs text-status-warning">{undo.data.warning}</div>}
        {undo.isError && <div className="text-xs text-status-danger">{(undo.error as Error)?.message ?? "Undo failed"}</div>}

        <div className="flex-1 min-h-0 overflow-y-auto border border-app-border rounded">
          {isLoading ? (
            <div className="p-3 text-xs text-app-text-dim">Loading…</div>
          ) : actions.length === 0 ? (
            <div className="p-3 text-xs text-app-text-dim">No actions recorded yet.</div>
          ) : (
            <ul className="divide-y divide-app-border">
              {actions.map((a) => (
                <li key={a.id} className={`px-3 py-2 text-xs flex items-center justify-between gap-2 ${a.undone ? "opacity-40 line-through" : ""}`}>
                  <span className="text-app-text">{describeAction(a)}</span>
                  <span className="text-app-text-muted font-mono shrink-0">{new Date(a.createdAt).toLocaleTimeString()}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

const KIND_LABELS: Record<string, string> = {
  "apply-changes": "Applied changes",
  branch: "Branched from a version",
  "add-base": "Added a base",
  "import-laps": "Imported laps",
  "set-head": "Switched head version",
  delete: "Deleted a version",
  restore: "Restored a version",
  "rename-note": "Edited session details",
  "set-lap-excluded": "Toggled a lap's excluded flag",
};

function describeAction(a: ExperimentActionRow): string {
  return KIND_LABELS[a.kind] ?? a.kind;
}
