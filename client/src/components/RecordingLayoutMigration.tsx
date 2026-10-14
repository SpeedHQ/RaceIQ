import { queryKeys } from "@/hooks/query-keys";
import { useIsMutating, useMutationState } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useRecordingLayoutMigration, useSelectRecordingDirectory, useStartRecordingLayoutMigration } from "@/hooks/recording-storage";
import { m } from "@/paraglide/messages";
import { previewRecordingDirectories } from "@/lib/recording-storage-paths";

export function RecordingLayoutMigration({ compact = false, onSuccessDismissed }: { compact?: boolean; onSuccessDismissed?: () => void }) {
  const status = useRecordingLayoutMigration();
  const start = useStartRecordingLayoutMigration();
  const startCount = useIsMutating({ mutationKey: queryKeys.recordingLayoutMigrationStart, exact: true });
  const requestedDirectories = useMutationState({
    filters: { mutationKey: queryKeys.recordingLayoutMigrationStart, status: "pending", exact: true },
    select: (mutation) => typeof mutation.state.variables === "string" ? mutation.state.variables : null,
  });
  const [deferred, setDeferred] = useState(false);
  const [successDismissed, setSuccessDismissed] = useState(false);
  const [choiceOpen, setChoiceOpen] = useState(false);
  const [chooseNew, setChooseNew] = useState(false);
  const [destination, setDestination] = useState("");
  const selectDirectory = useSelectRecordingDirectory();
  const [pickerError, setPickerError] = useState(false);
  const progress = status.data?.progress;
  const running = progress?.status === "running" || startCount > 0;
  const completed = progress?.status === "success";
  const retryable = progress?.status === "partial" || progress?.status === "error" || start.isError;
  const hasWork = Boolean(status.data && (status.data.fileCount > 0 || retryable));
  const pendingTarget = status.data?.destinationDirectory;
  const lockedTarget = Boolean(pendingTarget && !completed);
  const newLocation = lockedTarget ? pendingTarget !== status.data?.directory : chooseNew;
  const target = lockedTarget ? pendingTarget! : newLocation ? destination : status.data?.directory ?? "";
  const displayedDirectory = pendingTarget ?? requestedDirectories.at(-1) ?? target;
  const previews = previewRecordingDirectories(target);
  const selecting = selectDirectory.isPending;
  const docked = !compact && (running || completed || (retryable && Boolean(progress?.total)));
  const dialogOpen = compact ? choiceOpen && !running && !completed : running || (hasWork && !deferred && !completed) || (completed && !successDismissed);
  const percent = progress && progress.total > 0 ? Math.min(100, Math.round(progress.done / progress.total * 100)) : 0;
  const errorCode = start.error && "code" in start.error ? String(start.error.code) : "";
  const errorText = errorCode === "INVALID_DIRECTORY" ? m.storage_directory_error_invalid_directory()
    : errorCode === "DESTINATION_CONFLICT" ? m.storage_directory_error_destination_conflict()
    : ["MIGRATION_ACTIVE", "MOVE_ACTIVE", "IMPORT_ACTIVE", "RECORDING_ACTIVE"].includes(errorCode) ? m.recording_layout_migration_busy()
    : errorCode === "LAYOUT_MIGRATION_PENDING" ? m.recording_layout_migration_pending()
    : m.recording_layout_migration_retry_error();
  useEffect(() => {
    if (progress?.status === "running") { setDeferred(false); setSuccessDismissed(false); }
  }, [progress?.status]);
  useEffect(() => {
    if (status.data?.directory) setDestination(status.data.directory);
  }, [status.data?.directory]);

  const errors = <>
    {status.isError && <p role="alert" className="text-sm text-status-danger">{m.recording_layout_migration_check_error()}</p>}
    {progress?.status === "partial" && <p role="alert" className="text-sm text-status-danger">{m.recording_layout_migration_partial({ migrated: progress.migrated, failed: progress.failed })}</p>}
    {(progress?.status === "error" || start.isError) && <p role="alert" className="text-sm text-status-danger">{start.isError ? errorText : m.recording_layout_migration_retry_error()}</p>}
  </>;
  const apply = <Button type="button" variant="app-primary" disabled={running || selecting || !target.trim() || !hasWork} onClick={() => start.mutate(target, { onSuccess: () => setChoiceOpen(false) })}>
    {retryable ? m.recording_layout_migration_retry() : m.common_apply()}
  </Button>;
  const dialog = <Dialog open={dialogOpen} modal={!docked} onOpenChange={(open) => {
    if (!open && !running && !completed && !selecting) { if (compact) setChoiceOpen(false); else setDeferred(true); }
  }}>
    <DialogContent size={docked ? "sm" : "md"} showCloseButton={false} overlayClassName={docked ? "hidden" : undefined}
      className={docked ? "top-auto left-auto right-4 bottom-4 w-[min(24rem,calc(100%-2rem))] translate-x-0 translate-y-0 gap-3 rounded-lg p-4" : "w-[calc(100%-2rem)] max-h-[90dvh] overflow-y-auto gap-5 p-5 sm:p-7"}>
      <DialogHeader>
        <DialogTitle>{completed ? m.recording_layout_migration_success_title() : running ? m.recording_layout_migration_running() : m.recording_layout_migration_title()}</DialogTitle>
        <DialogDescription className={docked ? "break-all font-mono text-xs" : undefined}>{docked ? displayedDirectory : m.recording_layout_migration_description()}</DialogDescription>
      </DialogHeader>
      {!docked && <>
        <fieldset className="space-y-3" disabled={lockedTarget || selecting}>
          <legend className="mb-2 text-sm font-medium">{m.storage_directory_path_label()}</legend>
          <label className="flex items-start gap-2 text-sm"><input type="radio" name={compact ? "layout-target-settings" : "layout-target-prompt"} checked={!newLocation} onChange={() => setChooseNew(false)} /><span>{m.recording_layout_migration_keep_location()}<span className="mt-1 block break-all font-mono text-xs text-app-text-secondary">{status.data?.directory}</span></span></label>
          <label className="flex items-start gap-2 text-sm"><input type="radio" name={compact ? "layout-target-settings" : "layout-target-prompt"} checked={newLocation} onChange={() => setChooseNew(true)} /><span>{m.recording_layout_migration_choose_location()}</span></label>
          {newLocation && <div className="space-y-2">
            <Input aria-label={m.storage_directory_path_label()} value={target} disabled={lockedTarget || selecting} onChange={(event) => setDestination(event.target.value)} autoComplete="off" />
            {!lockedTarget && <Button type="button" variant="app-outline" size="app-sm" disabled={selecting || running} onClick={() => { setPickerError(false); selectDirectory.mutate(target || undefined, { onSuccess: ({ directory }) => { if (directory) { setDestination(directory); setChooseNew(true); } }, onError: () => setPickerError(true) }); }}>{selecting ? m.common_loading() : m.storage_directory_browse()}</Button>}
            <p className="text-xs text-app-text-dim">{m.storage_directory_native_picker_hint()}</p>
          </div>}
        </fieldset>
        {previews && <div className="space-y-2 rounded-md border border-app-border bg-app-surface-alt p-3 text-xs">
          <p className="font-medium">{m.recording_layout_migration_preview()}</p>
          <p>{m.import_ownership_mine()}<code className="mt-1 block break-all">{previews.own}</code></p>
          <p>{m.import_ownership_others()}<code className="mt-1 block break-all">{previews.others}</code></p>
        </div>}
        {status.data && <p className="text-sm text-app-text-secondary">{m.recording_layout_migration_count({ files: status.data.fileCount, sessions: status.data.sessionCount })}</p>}
      </>}
        {pickerError && <p role="alert" className="text-sm text-status-danger">{m.storage_directory_browse_error()}</p>}
      {running && <><p className="text-xs text-app-text-muted">{progress?.phase === "relocating" ? m.storage_directory_phase_copying() : m.recording_layout_migration_running()}</p><Progress done={progress?.done ?? 0} total={progress?.total ?? 0} percent={percent} /></>}
      {errors}
      {completed && <p role="status" className="text-sm text-status-success">{m.recording_layout_migration_success({ migrated: progress.migrated })}</p>}
      {!running && <DialogFooter className="flex-col-reverse gap-2 sm:flex-row">
        {completed ? <Button type="button" variant="app-primary" onClick={() => { setSuccessDismissed(true); onSuccessDismissed?.(); }}>{m.common_close()}</Button> : <>
          {!docked && <Button type="button" variant="app-outline" disabled={selecting} onClick={() => { if (compact) setChoiceOpen(false); else setDeferred(true); }}>{m.recording_layout_migration_later()}</Button>}
          {apply}
        </>}
      </DialogFooter>}
    </DialogContent>
  </Dialog>;
  if (!compact) return dialog;
  return <section className="space-y-3 rounded-lg border border-app-border bg-app-surface-alt/50 p-4" aria-labelledby="recording-layout-migration-maintenance-title">
    <div className="flex flex-wrap items-center justify-between gap-3"><h3 id="recording-layout-migration-maintenance-title" className="text-sm font-semibold">{m.recording_layout_migration_title()}</h3><Button type="button" variant="app-outline" size="app-sm" disabled={status.isFetching} onClick={() => void status.refetch()}>{m.recording_layout_migration_refresh()}</Button></div>
    <p className="break-all font-mono text-xs text-app-text-muted">{pendingTarget ?? status.data?.directory}</p>
    {status.data && <p className="text-xs text-app-text-secondary">{m.recording_layout_migration_count({ files: status.data.fileCount, sessions: status.data.sessionCount })}</p>}
    {errors}
    {running && <Progress done={progress?.done ?? 0} total={progress?.total ?? 0} percent={percent} />}
    {completed && <p role="status" className="text-xs text-status-success">{m.recording_layout_migration_success({ migrated: progress.migrated })}</p>}
    {!running && hasWork && !completed && <Button type="button" variant="app-primary" onClick={() => setChoiceOpen(true)}>{retryable ? m.recording_layout_migration_retry() : m.common_apply()}</Button>}
    {dialog}
  </section>;
}


function Progress({ done, total, percent }: { done: number; total: number; percent: number }) {
  return <div className="space-y-2"><p role="status" className="text-xs text-app-text-muted">{m.recording_layout_migration_progress({ done, total })}</p><div role="progressbar" aria-label={m.recording_layout_migration_progress_label()} aria-valuemin={0} aria-valuemax={total} aria-valuenow={done} aria-valuetext={`${percent}%`} className="h-1.5 overflow-hidden rounded-full bg-app-progress-track"><div className="h-full bg-app-accent transition-all" style={{ width: `${percent}%` }} /></div></div>;
}
