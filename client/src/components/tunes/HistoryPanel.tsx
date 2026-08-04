import { type ExperimentActionRow, useExperimentHistory, useUndo } from "../../hooks/experiment-history";
import { useExperimentVersions } from "../../hooks/experiments";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
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

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="md" showCloseButton={false} overlayClassName="bg-app-bg/60" layout="scrollable">
        <DialogHeader>
          <DialogTitle className="text-sm font-semibold text-app-text">History</DialogTitle>
        </DialogHeader>

        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-app-text-dim">{nextPending ? `Undo reverses: ${describeAction(nextPending)}` : "Nothing left to undo."}</p>
          <Button variant="app-primary" size="app-sm" onClick={() => undo.mutate({ sessionId })} disabled={!nextPending || undo.isPending} className="shrink-0">
            {undo.isPending ? "Undoing…" : "Undo last"}
          </Button>
        </div>

        <div className="rounded border border-app-border p-3">
          <div className="text-app-caption uppercase tracking-wider text-app-text-muted mb-1.5">Focus</div>
          <FocusTimeline experimentId={sessionId} versions={versions} />
        </div>

        {undo.data?.warning && <div className="text-xs text-status-warning">{undo.data.warning}</div>}
        {undo.isError && <div className="text-xs text-status-danger">{(undo.error as Error)?.message ?? "Undo failed"}</div>}

        <div className="min-h-[120px] max-h-[45vh] overflow-y-auto border border-app-border rounded">
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
      </DialogContent>
    </Dialog>
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
