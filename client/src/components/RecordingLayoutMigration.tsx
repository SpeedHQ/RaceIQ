import { queryKeys } from "@/hooks/query-keys";
import { useIsMutating, useMutationState } from "@tanstack/react-query";
import { useEffect, useId, useLayoutEffect, useState } from "react";
import { ArrowRight, Folder, FolderInput, FolderTree, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useRecordingLayoutMigration, useSelectRecordingDirectory, useStartRecordingLayoutMigration } from "@/hooks/recording-storage";
import { m } from "@/paraglide/messages";
import { previewRecordingDirectories } from "@/lib/recording-storage-paths";

export function RecordingLayoutMigration({ compact = false, onSuccessDismissed, onPrecedenceChange }: { compact?: boolean; onSuccessDismissed?: () => void; onPrecedenceChange?: (active: boolean) => void }) {
  const status = useRecordingLayoutMigration();
  const locationId = useId();
  const start = useStartRecordingLayoutMigration();
  const startCount = useIsMutating({ mutationKey: queryKeys.recordingLayoutMigrationStart, exact: true });
  const requestedDirectories = useMutationState({
    filters: { mutationKey: queryKeys.recordingLayoutMigrationStart, status: "pending", exact: true },
    select: (mutation) => typeof mutation.state.variables === "string" ? mutation.state.variables : null,
  });
  const [deferred, setDeferred] = useState(false);
  const [successDismissed, setSuccessDismissed] = useState(false);
  const [observedRunning, setObservedRunning] = useState(false);
  const [choiceOpen, setChoiceOpen] = useState(false);
  const [chooseNew, setChooseNew] = useState(false);
  const [destination, setDestination] = useState("");
  const selectDirectory = useSelectRecordingDirectory();
  const [pickerError, setPickerError] = useState(false);
  const progress = status.data?.progress;
  const running = progress?.status === "running" || startCount > 0;
  const completed = progress?.status === "success" && observedRunning;
  const retryable = progress?.status === "partial" || progress?.status === "error" || start.isError;
  const hasWork = Boolean(status.data && (status.data.fileCount > 0 || retryable));
  const pendingTarget = status.data?.destinationDirectory;
  const lockedTarget = Boolean(pendingTarget && !completed);
  const newLocation = lockedTarget ? pendingTarget !== status.data?.directory : chooseNew;
  const target = lockedTarget ? pendingTarget! : newLocation ? destination : status.data?.directory ?? "";
  const displayedDirectory = pendingTarget ?? requestedDirectories.at(-1) ?? target;
  const previews = previewRecordingDirectories(target);
  const selecting = selectDirectory.isPending;
  const docked = !compact && (running || completed);
  const dialogOpen = compact ? choiceOpen && !running && !completed : running || (hasWork && !completed && !deferred) || (completed && !successDismissed);
  const percent = progress && progress.total > 0 ? Math.min(100, Math.round(progress.done / progress.total * 100)) : 0;
  const errorCode = start.error && "code" in start.error ? String(start.error.code) : "";
  const errorText = errorCode === "INVALID_DIRECTORY" ? m.storage_directory_error_invalid_directory()
    : errorCode === "UNSUPPORTED_FILESYSTEM" ? m.recording_layout_migration_unsupported_filesystem()
    : errorCode === "DESTINATION_CONFLICT" ? m.storage_directory_error_destination_conflict()
    : ["MIGRATION_ACTIVE", "MOVE_ACTIVE", "IMPORT_ACTIVE", "RECORDING_ACTIVE"].includes(errorCode) ? m.recording_layout_migration_busy()
    : errorCode === "LAYOUT_MIGRATION_PENDING" ? m.recording_layout_migration_pending()
    : m.recording_layout_migration_retry_error();
  useEffect(() => {
    // A completed server job is not a new notification after reload or remount.
    if (running) { setObservedRunning(true); setSuccessDismissed(false); setDeferred(false); }
  }, [running]);
  useLayoutEffect(() => {
    if (!compact) onPrecedenceChange?.(dialogOpen);
  }, [compact, dialogOpen, onPrecedenceChange]);
  useEffect(() => {
    if (status.data?.directory) setDestination(status.data.directory);
  }, [status.data?.directory]);

  const errors = <>
    {status.isError && <p role="alert" className="text-sm text-status-danger">{m.recording_layout_migration_check_error()}</p>}
    {progress?.status === "partial" && <p role="alert" className="text-sm text-status-danger">{m.recording_layout_migration_partial({ migrated: progress.migrated, failed: progress.failed })}</p>}
    {(progress?.status === "error" || start.isError) && <p role="alert" className="text-sm text-status-danger">{start.isError ? errorText : m.recording_layout_migration_retry_error()}</p>}
  </>;
  const apply = <Button type="button" variant="app-primary" className="w-full sm:w-auto" disabled={running || selecting || !target.trim() || !hasWork} onClick={() => start.mutate(target, { onSuccess: () => setChoiceOpen(false) })}>
    {retryable ? m.recording_layout_migration_retry() : newLocation ? m.recording_layout_migration_move_action() : m.recording_layout_migration_action()}
    {!retryable && <ArrowRight aria-hidden="true" className="size-4" />}
  </Button>;
  const dialog = <Dialog open={dialogOpen} modal={!docked} onOpenChange={(open) => {
    if (!open && !running && !completed && !selecting) { if (compact) setChoiceOpen(false); else setDeferred(true); }
  }}>
    <DialogContent size={docked ? "sm" : "md"} showCloseButton={false} overlayClassName={docked ? "hidden" : undefined}
      className={docked ? "top-auto left-auto right-4 bottom-4 w-[min(24rem,calc(100%-2rem))] translate-x-0 translate-y-0 gap-3 rounded-lg p-4 shadow-none ring-0" : "w-[calc(100%-2rem)] max-h-[90dvh] overflow-y-auto gap-5 p-5 shadow-none ring-0 sm:p-6"}>
      <DialogHeader className={docked ? undefined : "gap-3"}>
        <div className="flex items-center gap-3">
          {!docked && <FolderTree aria-hidden="true" className="size-5 shrink-0 text-app-accent" />}
          <DialogTitle className={docked ? undefined : "text-app-title font-semibold leading-tight"}>{completed ? m.recording_layout_migration_success_title() : running ? m.recording_layout_migration_running() : m.recording_layout_migration_title()}</DialogTitle>
        </div>
        <DialogDescription className={docked ? "break-all font-mono text-app-compact" : "text-app-detail leading-relaxed text-app-text-secondary"}>{docked ? displayedDirectory : m.recording_layout_migration_description()}</DialogDescription>
      </DialogHeader>
      {!docked && <>
        {status.data && <p className="text-app-detail text-app-text-secondary">{m.recording_layout_migration_count({ files: status.data.fileCount, sessions: status.data.sessionCount })}</p>}
        <fieldset className="space-y-2.5 disabled:opacity-60" disabled={lockedTarget || selecting}>
          <legend className="mb-3 text-app-detail font-medium">{m.recording_layout_migration_location_label()}</legend>
          <label className={`flex cursor-pointer items-start gap-3 rounded-md border p-3 transition-colors ${!newLocation ? "border-app-accent bg-app-accent/5" : "border-app-border hover:border-app-border-hover"}`}>
            <input type="radio" aria-label={m.recording_layout_migration_keep_location()} aria-describedby={`${locationId}-keep-description`} className="mt-0.5 size-4 shrink-0 accent-app-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-app-accent" name={compact ? "layout-target-settings" : "layout-target-prompt"} checked={!newLocation} onChange={() => setChooseNew(false)} />
            <span className="min-w-0 space-y-1"><span className="block text-app-detail font-medium">{m.recording_layout_migration_keep_location()}</span><span id={`${locationId}-keep-description`} className="block text-app-compact leading-relaxed text-app-text-secondary">{m.recording_layout_migration_keep_location_help()}</span><span className="block break-all font-mono text-app-compact leading-relaxed text-app-text-muted">{status.data?.directory}</span></span>
          </label>
          <div className={`rounded-md border transition-colors ${newLocation ? "border-app-accent bg-app-accent/5" : "border-app-border hover:border-app-border-hover"}`}>
            <label className="flex cursor-pointer items-start gap-3 p-3">
              <input type="radio" aria-label={m.recording_layout_migration_choose_location()} aria-describedby={`${locationId}-move-description`} className="mt-0.5 size-4 shrink-0 accent-app-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-app-accent" name={compact ? "layout-target-settings" : "layout-target-prompt"} checked={newLocation} onChange={() => setChooseNew(true)} />
              <span className="min-w-0 space-y-1"><span className="block text-app-detail font-medium">{m.recording_layout_migration_choose_location()}</span><span id={`${locationId}-move-description`} className="block text-app-compact leading-relaxed text-app-text-secondary">{m.recording_layout_migration_choose_location_help()}</span></span>
            </label>
            {newLocation && <div className="space-y-2 border-t border-app-border p-3">
              <label htmlFor={`${locationId}-destination`} className="text-app-compact font-medium">{m.storage_directory_path_label()}</label>
              <div className="flex flex-col gap-2 sm:flex-row"><Input id={`${locationId}-destination`} aria-label={m.storage_directory_path_label()} className="min-w-0 flex-1 font-mono text-app-compact" value={target} disabled={lockedTarget || selecting} onChange={(event) => setDestination(event.target.value)} autoComplete="off" />
                {!lockedTarget && <Button type="button" variant="app-outline" size="app-sm" disabled={selecting || running} onClick={() => { setPickerError(false); selectDirectory.mutate(target || undefined, { onSuccess: ({ directory }) => { if (directory) { setDestination(directory); setChooseNew(true); } }, onError: () => setPickerError(true) }); }}><FolderInput aria-hidden="true" className="size-4" />{selecting ? m.common_loading() : m.storage_directory_browse()}</Button>}</div>
              <p className="text-app-compact leading-relaxed text-app-text-muted">{m.storage_directory_native_picker_hint()}</p>
            </div>}
          </div>
        </fieldset>
        {previews && <div className="space-y-3 border-t border-app-border pt-4"><p className="text-app-detail font-medium">{m.recording_layout_migration_preview()}</p><div className="grid gap-3 sm:grid-cols-2">
          <div className="flex min-w-0 items-start gap-2"><Folder aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-app-text-muted" /><div className="min-w-0 space-y-1"><p className="text-app-compact text-app-text-secondary">{m.recording_layout_migration_your_recordings()}</p><code className="block break-all font-mono text-app-compact text-app-text">{previews.own}</code></div></div>
          <div className="flex min-w-0 items-start gap-2"><Folder aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-app-text-muted" /><div className="min-w-0 space-y-1"><p className="text-app-compact text-app-text-secondary">{m.recording_layout_migration_other_recordings()}</p><code className="block break-all font-mono text-app-compact text-app-text">{previews.others}</code></div></div>
        </div></div>}
        <p className="flex items-start gap-2 text-app-compact leading-relaxed text-app-text-secondary"><ShieldCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-app-text-muted" />{m.recording_layout_migration_organization()}</p>
      </>}
        {pickerError && <p role="alert" className="text-sm text-status-danger">{m.storage_directory_browse_error()}</p>}
      {running && <><p className="text-xs text-app-text-muted">{progress?.phase === "relocating" ? m.storage_directory_phase_copying() : m.recording_layout_migration_running()}</p><Progress done={progress?.done ?? 0} total={progress?.total ?? 0} percent={percent} /></>}
      {errors}
      {completed && <p role="status" className="text-sm text-status-success">{m.recording_layout_migration_success({ migrated: progress.migrated })}</p>}
      {!running && <DialogFooter className={docked ? "gap-2" : "sticky bottom-0 z-10 -mx-5 -mb-5 gap-2 border-app-border bg-app-surface-alt px-5 py-4 sm:-mx-6 sm:-mb-6 sm:px-6"}>
        {completed ? <Button type="button" variant="app-primary" onClick={() => { setSuccessDismissed(true); onSuccessDismissed?.(); }}>{m.common_close()}</Button> : <>
          {!docked && <Button type="button" variant="app-outline" disabled={selecting} onClick={() => { if (compact) setChoiceOpen(false); else setDeferred(true); }}>{m.recording_layout_migration_later()}</Button>}
          {apply}
        </>}
      </DialogFooter>}
    </DialogContent>
  </Dialog>;
  if (compact && status.isSuccess && !running && !completed && !retryable && !hasWork && !pendingTarget && !selecting) return null;
  if (!compact) return dialog;
  return <section className="space-y-3 rounded-lg border border-app-border bg-app-surface-alt/50 p-4" aria-labelledby="recording-layout-migration-maintenance-title">
    <div className="flex flex-wrap items-center justify-between gap-3"><h3 id="recording-layout-migration-maintenance-title" className="text-sm font-semibold">{m.recording_layout_migration_title()}</h3><Button type="button" variant="app-outline" size="app-sm" disabled={status.isFetching} onClick={() => void status.refetch()}>{m.recording_layout_migration_refresh()}</Button></div>
    {status.isPending && <p role="status" className="text-sm text-app-text-secondary">{m.recording_layout_migration_checking()}</p>}
    {pendingTarget && <p className="break-all font-mono text-xs text-app-text-muted">{pendingTarget}</p>}
    {status.data && status.data.fileCount > 0 && !running && !completed && <p className="text-sm text-app-text-secondary">{m.recording_layout_migration_count({ files: status.data.fileCount, sessions: status.data.sessionCount })}</p>}
    {errors}
    {running && <Progress done={progress?.done ?? 0} total={progress?.total ?? 0} percent={percent} />}
    {completed && <p role="status" className="text-xs text-status-success">{m.recording_layout_migration_success({ migrated: progress.migrated })}</p>}
    {!running && hasWork && !completed && <Button type="button" variant="app-primary" onClick={() => setChoiceOpen(true)}>{retryable ? m.recording_layout_migration_retry() : m.recording_layout_migration_action()}</Button>}
    {dialog}
  </section>;
}


function Progress({ done, total, percent }: { done: number; total: number; percent: number }) {
  return <div className="space-y-2"><p role="status" className="text-xs text-app-text-muted">{m.recording_layout_migration_progress({ done, total })}</p><div role="progressbar" aria-label={m.recording_layout_migration_progress_label()} aria-valuemin={0} aria-valuemax={total} aria-valuenow={done} aria-valuetext={`${percent}%`} className="h-1.5 overflow-hidden rounded-full bg-app-progress-track"><div className="h-full bg-app-accent transition-all" style={{ width: `${percent}%` }} /></div></div>;
}
