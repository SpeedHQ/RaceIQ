import { useEffect, useState } from "react";
import { useIsMutating } from "@tanstack/react-query";
import { Check, Scissors } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { queryKeys } from "@/hooks/query-keys";
import { useSplitMigration, useStartSplitMigration } from "@/hooks/split-migration";
import { m } from "@/paraglide/messages";

export function SparseSplitMigration({ layoutPrecedence, onVisibilityChange }: { layoutPrecedence: boolean; onVisibilityChange: (visible: boolean) => void }) {
  const status = useSplitMigration();
  const start = useStartSplitMigration();
  const starts = useIsMutating({ mutationKey: queryKeys.splitMigrationStart, exact: true });
  const [observedRunning, setObservedRunning] = useState(false);
  const [successDismissed, setSuccessDismissed] = useState(false);
  const progress = status.data?.progress;
  const running = progress?.status === "running" || starts > 0;
  const completed = progress?.status === "success" && observedRunning;
  const retryable = progress?.status === "partial" || progress?.status === "error" || start.isError;
  const needsConsent = (status.data?.sessionCount ?? 0) > 0 && progress?.status === "idle";
  const statusError = status.isError;
  const dialogOpen = !layoutPrecedence && (running || completed && !successDismissed || !running && !completed && (needsConsent || retryable || statusError));
  const percent = progress && progress.total > 0 ? Math.min(100, Math.round(progress.done / progress.total * 100)) : 0;

  useEffect(() => { onVisibilityChange(dialogOpen); }, [dialogOpen, onVisibilityChange]);

  useEffect(() => {
    if (running) { setObservedRunning(true); setSuccessDismissed(false); }
  }, [running]);

  return <Dialog open={dialogOpen} modal={!running && !completed}>
    <DialogContent size={running || completed ? "sm" : "md"} showCloseButton={false} overlayClassName={running || completed ? "hidden" : undefined}
      className={running || completed
        ? "top-auto left-auto right-4 bottom-4 w-[min(24rem,calc(100%-2rem))] translate-x-0 translate-y-0 gap-3 rounded-lg p-4 shadow-none ring-0"
        : "w-[calc(100%-2rem)] max-h-[90dvh] overflow-y-auto gap-5 p-5 shadow-none ring-0 sm:p-6"}>
      <DialogHeader className={running || completed ? undefined : "gap-3"}>
        <div className="flex items-center gap-3">
          {!running && !completed && <Scissors aria-hidden="true" className="size-5 shrink-0 text-app-accent" />}
          <DialogTitle className={running || completed ? undefined : "text-app-title font-semibold leading-tight"}>
            {completed ? m.sparse_split_migration_success_title() : running ? m.sparse_split_migration_running() : m.sparse_split_migration_title()}
          </DialogTitle>
        </div>
        <DialogDescription className={running || completed ? "text-app-detail text-app-text-secondary" : "text-app-detail leading-relaxed text-app-text-secondary"}>
          {running || completed ? m.sparse_split_migration_progress({ done: progress?.done ?? 0, total: progress?.total ?? 0 }) : m.sparse_split_migration_description({ sessions: status.data?.sessionCount ?? 0 })}
        </DialogDescription>
      </DialogHeader>
      {running && <>
        <p role="status" aria-live="polite" className="text-xs text-app-text-muted">{m.sparse_split_migration_progress({ done: progress?.done ?? 0, total: progress?.total ?? 0 })}</p>
        <div role="progressbar" aria-label={m.sparse_split_migration_progress_label()} aria-valuemin={0} aria-valuemax={progress?.total ?? 0} aria-valuenow={progress?.done ?? 0} aria-valuetext={`${percent}%`} className="h-1.5 overflow-hidden rounded-full bg-app-progress-track"><div className="h-full bg-app-accent transition-all" style={{ width: `${percent}%` }} /></div>
      </>}
      {completed && <p role="status" className="flex items-center gap-2 text-sm text-status-success"><Check aria-hidden="true" className="size-4" />{m.sparse_split_migration_success({ migrated: progress.migrated })}</p>}
      {(progress?.status === "error" || progress?.status === "partial" || start.isError || statusError) && <p role="alert" className="text-sm text-status-danger">{start.isError ? m.sparse_split_migration_retry_error() : statusError ? m.sparse_split_migration_status_error() : m.sparse_split_migration_failure({ failed: progress?.failed ?? 0 })}</p>}
      {!running && <DialogFooter className="gap-2">
        {completed
          ? <Button type="button" variant="app-primary" onClick={() => setSuccessDismissed(true)}>{m.common_close()}</Button>
          : statusError
            ? <Button type="button" variant="app-primary" disabled={status.isFetching} onClick={() => void status.refetch()}>{m.sparse_split_migration_refresh()}</Button>
            : <Button type="button" variant="app-primary" disabled={starts > 0 || start.isPending || status.isPending || status.isFetching} onClick={() => start.mutate()}>{retryable ? m.sparse_split_migration_retry() : m.sparse_split_migration_action()}</Button>}
      </DialogFooter>}
    </DialogContent>
  </Dialog>;
}
