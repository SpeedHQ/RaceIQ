import { useRef, useState } from "react";
import type { OpponentRemovalPreview, OpponentRemovalSkip } from "@raceiq/shared/racing/sessions/opponent-removal";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useSessions } from "@/hooks/session-queries";
import { previewOpponentRemoval, useOpponentRemovalStatus, useStartOpponentRemoval } from "@/hooks/opponent-removal";
import { formatBytes } from "@/lib/format-bytes";
import { m } from "@/paraglide/messages";
import { getLocale } from "@/paraglide/runtime";
import { parseUtcTimestamp } from "@/lib/utc-date";

function skipReason(reason: OpponentRemovalSkip["reason"]): string {
  switch (reason) {
    case "not-found": return m.storage_opponents_skip_not_found();
    case "not-recorded": return m.storage_opponents_skip_not_recorded();
    case "already-removed": return m.storage_opponents_skip_already_removed();
    case "unsupported-format": return m.storage_opponents_skip_unsupported_format();
    case "unowned": return m.storage_opponents_skip_unowned();
    case "shared-reference": return m.storage_opponents_skip_shared_reference();
    case "invalid-source": return m.storage_opponents_skip_invalid_source();
  }
}

export function OpponentRemovalControls({ disabled = false }: { disabled?: boolean }) {
  const sessions = useSessions({ allGames: true });
  const statusQuery = useOpponentRemovalStatus();
  const start = useStartOpponentRemoval();
  const [selected, setSelected] = useState<number[]>([]);
  const [preview, setPreview] = useState<OpponentRemovalPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirming = useRef(false);
  const status = statusQuery.data;
  const running = status?.status === "running";
  const locked = disabled || running || previewing || start.isPending || statusQuery.isLoading || statusQuery.isError;
  const candidates = (sessions.data ?? []).filter((session) => session.gameId === "lmu");

  const loadPreview = async () => {
    if (locked || !selected.length) return;
    setPreviewing(true);
    setError(null);
    try {
      const nextPreview = await previewOpponentRemoval({ sessionIds: [...selected].sort((a, b) => a - b) });
      confirming.current = false;
      setPreview(nextPreview);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setPreviewing(false); }
  };
  const confirm = async () => {
    if (!preview || confirming.current || start.isPending) return;
    confirming.current = true;
    setError(null);
    try {
      await start.mutateAsync(preview.request);
      setPreview(null);
    } catch (cause) {
      confirming.current = false;
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return <section className="mt-5 min-w-0 space-y-3 border-t border-app-border pt-5" aria-label={m.storage_opponents_remove()}>
    <h3 className="text-sm font-semibold text-app-text">{m.storage_opponents_remove()}</h3>
    <p className="text-sm text-app-text-secondary">{m.storage_opponents_scope()}</p>
    <fieldset disabled={locked} className="min-w-0">
      <legend className="mb-2 text-sm font-medium text-app-text">{m.storage_opponents_select()}</legend>
      {sessions.isLoading && <p role="status">{m.common_loading()}</p>}
      {sessions.isError && <p role="alert" className="text-sm text-status-danger">{sessions.error.message}</p>}
      {!sessions.isLoading && !sessions.isError && candidates.length === 0 && <p className="text-sm text-app-text-dim">{m.compare_opponent_no_laps()}</p>}
      <div className="max-h-56 space-y-2 overflow-y-auto">
        {candidates.map((session) => <label key={session.id} className="flex min-w-0 items-start gap-2 text-sm">
          <input type="checkbox" checked={selected.includes(session.id)}
            disabled={!selected.includes(session.id) && selected.length >= 1000}
            onChange={(event) => {
              setSelected((current) => event.target.checked ? [...current, session.id] : current.filter((id) => id !== session.id));
              setError(null);
            }} />
          <span className="min-w-0 break-words">#{session.id} — {parseUtcTimestamp(session.createdAt).toLocaleString(getLocale())} — {session.trackId} — {session.carId}</span>
        </label>)}
      </div>
    </fieldset>
    <Button variant="app-outline" size="app-sm" disabled={locked || sessions.isError || !selected.length} onClick={() => void loadPreview()}>
      {previewing ? m.common_loading() : m.storage_opponents_preview()}
    </Button>
    {statusQuery.isError && <p role="alert" className="text-sm text-status-danger">{statusQuery.error.message}</p>}
    {!preview && error && <p role="alert" className="text-sm text-status-danger">{error}</p>}
    {status && status.status !== "idle" && <div aria-live="polite" className="space-y-2 text-sm">
      {running && <p role="status">{m.common_loading()} {m.storage_opponents_progress({ done: status.done, total: status.total })}</p>}
      {!running && <p>{m.storage_opponents_result({ sessions: status.removedSessionIds.length, size: formatBytes(status.freedBytes) })}</p>}
      {status.error && <p role="alert" className="text-status-danger">{status.error}</p>}
      {status.cleanupPendingSessionIds.length > 0 && <p role="alert">{m.storage_opponents_pending({ sessions: status.cleanupPendingSessionIds.join(", ") })}</p>}
      {status.skipped.length > 0 && <div><p className="font-medium">{m.storage_opponents_skipped()}</p><ul>{status.skipped.map((item) => <li key={`${item.sessionIds.join(",")}:${item.reason}`}>#{item.sessionIds.join(", #")} — {skipReason(item.reason)}</li>)}</ul></div>}
      {status.failed.length > 0 && <div role="alert"><p className="font-medium">{m.storage_opponents_failed()}</p><ul>{status.failed.map((item) => <li key={item.sessionIds.join(",")}>#{item.sessionIds.join(", #")} — {item.message}</li>)}</ul></div>}
    </div>}
    <Dialog open={preview !== null} onOpenChange={(open) => { if (!open && !start.isPending) { setPreview(null); setError(null); } }}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>{m.storage_opponents_remove()}</DialogTitle><DialogDescription>{m.storage_opponents_scope()}</DialogDescription></DialogHeader>
        {preview && <div className="space-y-3 text-sm">
          <p className="break-words">{m.label_sessions()}: {preview.candidateSessionIds.map((id) => `#${id}`).join(", ") || m.label_none()}</p>
          <p>{m.storage_opponents_preview_bytes({ size: formatBytes(preview.companionBytes) })}</p>
          {preview.rewriteSessionIds.length > 0 && <p>{m.storage_opponents_rewrite()}</p>}
          {preview.skipped.length > 0 && <div><p className="font-medium">{m.storage_opponents_skipped()}</p><ul>{preview.skipped.map((item) => <li key={`${item.sessionIds.join(",")}:${item.reason}`}>#{item.sessionIds.join(", #")} — {skipReason(item.reason)}</li>)}</ul></div>}
          {error && <p role="alert" className="text-status-danger">{error}</p>}
        </div>}
        <DialogFooter>
          <Button variant="app-outline" disabled={start.isPending} onClick={() => { setPreview(null); setError(null); }}>{m.common_cancel()}</Button>
          <Button variant="app-outline" disabled={start.isPending || !preview?.candidateSessionIds.length} onClick={() => void confirm()}>{start.isPending ? m.common_loading() : m.storage_opponents_confirm()}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </section>;
}
