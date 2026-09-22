import type { SessionCleanupPreview, SessionCleanupRequest, SessionCleanupResult } from "@shared/racing/sessions/cleanup";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatBytes } from "@/lib/format-bytes";
import { m } from "@/paraglide/messages";

type Props = {
  request: SessionCleanupRequest | null;
  onClose: () => void;
  onCompleted: (result: SessionCleanupResult) => void;
};

export function SessionCleanupDialog({ request, onClose, onCompleted }: Props) {
  const [preview, setPreview] = useState<SessionCleanupPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SessionCleanupResult | null>(null);

  useEffect(() => {
    if (!request) {
      setPreview(null);
      setError(null);
      setResult(null);
      return;
    }
    let cancelled = false;
    setPreview(null);
    setResult(null);
    setError(null);
    setLoading(true);
    void fetch("/api/storage/session-cleanup/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) })
      .then(async (response) => {
        const data = (await response.json().catch(() => null)) as SessionCleanupPreview | { error?: string } | null;
        if (!response.ok) throw new Error((data && "error" in data ? data.error : undefined) ?? `${response.status} ${response.statusText}`);
        if (!cancelled) setPreview(data as SessionCleanupPreview);
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [request]);

  const execute = async () => {
    if (!request || !preview || preview.candidateSessionIds.length === 0 || executing) return;
    setExecuting(true);
    setError(null);
    try {
      const response = await fetch("/api/storage/session-cleanup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) });
      const data = (await response.json().catch(() => null)) as SessionCleanupResult | { error?: string } | null;
      if (response.status === 409) throw new Error(m.sessions_cleanup_active_recording());
      if (!response.ok) throw new Error((data && "error" in data ? data.error : undefined) ?? `${response.status} ${response.statusText}`);
      const cleanupResult = data as SessionCleanupResult;
      setResult(cleanupResult);
      onCompleted(cleanupResult);
      if (cleanupResult.failed.length === 0) onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setExecuting(false);
    }
  };

  if (!request) return null;
  const failed = result?.failed ?? [];
  return (
    <Dialog open onOpenChange={(open) => !open && !executing && onClose()}>
      <DialogContent size="md" showCloseButton={!executing} overlayClassName="bg-app-bg/60">
        <DialogHeader>
          <DialogTitle className="text-xs font-medium text-app-text/90 uppercase tracking-wider">{m.sessions_cleanup_title()}</DialogTitle>
        </DialogHeader>
        {loading && <p className="text-sm text-app-text-muted">{m.common_loading()}</p>}
        {error && <p role="alert" className="rounded border border-status-danger/30 bg-status-danger/10 px-3 py-2 text-sm text-status-danger">{error}</p>}
        {preview && (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="text-app-text-muted">{m.sessions_cleanup_eligible()}</dt>
            <dd className="text-app-text font-medium">{preview.candidateSessionIds.length}</dd>
            <dt className="text-app-text-muted">{m.sessions_cleanup_capture_groups()}</dt>
            <dd className="text-app-text font-medium">{preview.fileCount}</dd>
            <dt className="text-app-text-muted">{m.sessions_cleanup_reclaimable()}</dt>
            <dd className="text-app-text font-medium">{formatBytes(preview.reclaimableBytes)}</dd>
            <dt className="text-app-text-muted">{m.sessions_cleanup_protected()}</dt>
            <dd className="text-app-text">{preview.protectedSessionIds.length}</dd>
            <dt className="text-app-text-muted">{m.sessions_cleanup_unavailable()}</dt>
            <dd className="text-app-text">{preview.unavailableSessionIds.length}</dd>
          </dl>
        )}
        {failed.length > 0 && (
          <div role="alert" className="rounded border border-status-warning/30 bg-status-warning/10 px-3 py-2 text-sm text-status-warning">
            <p className="font-medium">{m.sessions_cleanup_partial_failure({ count: failed.length })}</p>
            <ul className="mt-1 list-disc pl-5">{failed.map((item) => <li key={item.sessionIds.join(",")}>{item.message}</li>)}</ul>
          </div>
        )}
        <DialogFooter className="border-0 bg-transparent p-0 -mx-0 -mb-0">
          <Button variant="app-ghost" size="app-sm" disabled={executing} onClick={onClose}>{m.common_cancel()}</Button>
          <Button variant="app-danger" size="app-sm" disabled={loading || executing || !preview || preview.candidateSessionIds.length === 0} onClick={() => void execute()}>
            {executing ? m.common_loading() : m.sessions_cleanup_confirm()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
