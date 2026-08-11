import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { ExperimentVersion } from "@/hooks/experiments";
import { useSetTestNote } from "@/hooks/experiments";

/** Generic free-text per-node editor. Seeds from the node's stored value,
 *  saves via the supplied mutation, and only enables Save when the text
 *  actually changed. Backs both the driver comment and the engineer notes. */
function NodeTextEditor({
  label,
  value,
  placeholder,
  pending,
  error,
  onSave,
  rows = 2,
}: {
  label: string;
  value: string | null;
  placeholder: string;
  pending: boolean;
  error: unknown;
  onSave: (next: string | null, done: () => void) => void;
  rows?: number;
}) {
  const [draft, setDraft] = useState(value ?? "");
  // Re-seed when the server value changes (e.g. after undo) unless the user is
  // mid-edit with unsaved changes.
  const [dirty, setDirty] = useState(false);
  const current = value ?? "";
  const trimmed = draft.trim();
  const changed = trimmed !== current;

  return (
    <div className="px-3 py-2 border-b border-app-border/40 space-y-1">
      <div className="text-app-caption uppercase tracking-wider text-app-text-muted">{label}</div>
      <textarea
        value={dirty ? draft : current}
        onChange={(e) => {
          setDirty(true);
          setDraft(e.target.value);
        }}
        rows={rows}
        placeholder={placeholder}
        className="w-full resize-y rounded-md border border-app-border bg-app-surface/60 px-2 py-1 text-app-compact text-app-text placeholder:text-app-text-dim focus:border-app-text-dim focus:outline-none"
      />
      {dirty && changed && (
        <div className="flex items-center gap-2">
          <Button variant="app-outline" size="app-sm" onClick={() => onSave(trimmed === "" ? null : trimmed, () => setDirty(false))} disabled={pending} className="normal-case tracking-wider">
            {pending ? "Saving…" : "Save"}
          </Button>
          <Button
            variant="app-ghost"
            size="app-sm"
            onClick={() => {
              setDirty(false);
              setDraft(current);
            }}
            className="normal-case tracking-wider text-app-text-muted hover:text-app-text"
          >
            Cancel
          </Button>
          {error != null && <span className="text-app-caption text-status-danger">{(error as Error).message}</span>}
        </div>
      )}
    </div>
  );
}

/** Driver's subjective feel comment for this version. */
function DriverCommentEditor({ sessionId, versionId, note, rows }: { sessionId: number; versionId: number; note: string | null; rows?: number }) {
  const setNote = useSetTestNote();
  return (
    <NodeTextEditor
      label="Driver comment"
      value={note}
      placeholder="How did the car feel on this version?"
      pending={setNote.isPending}
      error={setNote.error}
      rows={rows}
      onSave={(next, done) => setNote.mutate({ sessionId, versionId, driverComment: next }, { onSuccess: done })}
    />
  );
}

/** Engineer/AI note — reasoning on this version, written by the setup engineer
 *  and persisted across chat compaction. READ-ONLY in the UI: only the setup
 *  engineer agent edits it, so the driver can't accidentally clobber it. */
function EngineerNotesView({ notes }: { notes: string | null }) {
  return (
    <div className="px-3 py-2 space-y-1">
      <div className="text-app-caption uppercase tracking-wider text-app-text-muted">Engineer notes</div>
      {notes ? (
        <p className="text-app-compact text-app-text whitespace-pre-wrap max-h-64 overflow-y-auto">{notes}</p>
      ) : (
        <p className="text-app-compact text-app-text-dim italic">No engineer notes yet — the setup engineer adds these.</p>
      )}
    </div>
  );
}

/** Modal wrapping both per-node comment editors, opened from a node's "Notes" button. */
export function NotesModal({ sessionId, test, onClose }: { sessionId: number; test: ExperimentVersion; onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="wide" showCloseButton={false} overlayClassName="bg-app-bg/60" layout="scrollable">
        <DialogHeader>
          <DialogTitle className="text-sm font-semibold text-app-text">
            <span className="font-mono">{test.label}</span> — notes
          </DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-2 divide-x divide-app-border/60 border border-app-border/60 rounded-md overflow-hidden bg-app-surface/40">
          <DriverCommentEditor sessionId={sessionId} versionId={test.id} note={test.driverComment} rows={8} />
          <EngineerNotesView notes={test.notes} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
