import { useSettings } from "@/hooks/settings";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useMoveRecordingDirectory, usePreflightRecordingDirectory, useRecordingDirectoryStatus, useRecordingLayoutMigration, useSelectRecordingDirectory, useStartRecordingLayoutMigration } from "@/hooks/recording-storage";
import { m } from "@/paraglide/messages";
import { previewRecordingDirectories } from "@/lib/recording-storage-paths";

export function RecordingDirectoryControl({ disabled = false, inline = false }: { disabled?: boolean; inline?: boolean }) {
  const { settingsLoaded } = useSettings();
  const status = useRecordingDirectoryStatus();
  const selectDirectory = useSelectRecordingDirectory();
  const move = useMoveRecordingDirectory();
  const layoutMigration = useRecordingLayoutMigration();
  const layoutStart = useStartRecordingLayoutMigration();
  const preflight = usePreflightRecordingDirectory();
  const [pickerError, setPickerError] = useState(false);
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [occupiedSelection, setOccupiedSelection] = useState(false);
  const activePath = status.data?.directory ?? "";
  const moving = status.data?.state === "moving";
  const layoutRunning = layoutMigration.data?.progress.status === "running";
  const pendingLayoutTarget = Boolean(layoutMigration.data?.destinationDirectory && layoutMigration.data.progress.status !== "success");
  const transitionLocked = moving || layoutRunning || pendingLayoutTarget || move.isPending || layoutStart.isPending || preflight.isPending;

  const useLayoutMigration = Boolean(layoutMigration.data && (layoutMigration.data.fileCount > 0 || ["partial", "error"].includes(layoutMigration.data.progress.status)));
  const previews = previewRecordingDirectories(path);
  const pathPreview = previews && <div className="space-y-2 rounded-md border border-app-border bg-app-surface-alt p-3 text-xs"><p className="font-medium">{m.recording_layout_migration_preview()}</p><p>{m.import_ownership_mine()}<code className="mt-1 block break-all">{previews.own}</code></p><p>{m.import_ownership_others()}<code className="mt-1 block break-all">{previews.others}</code></p></div>;
  const phaseLabel = (() => {
    switch (status.data?.phase) {
      case "copying": return m.storage_directory_phase_copying();
      case "committing": return m.storage_directory_phase_committing();
      case "removing-sources": return m.storage_directory_phase_removing_sources();
      default: return "";
    }
  })();
  const applyError = useLayoutMigration ? layoutStart.error : move.error;
  const errorCode = preflight.error && "code" in preflight.error ? String(preflight.error.code) : applyError && "code" in applyError ? String(applyError.code) : status.data?.state === "error" ? status.data.code ?? "" : "";
  const errorMessage = (() => {
    switch (errorCode) {
      case "INVALID_DIRECTORY": return m.storage_directory_error_invalid_directory();
      case "DESTINATION_CONFLICT": return m.storage_directory_error_destination_conflict();
      case "RECORDING_ACTIVE": return m.storage_directory_error_recording_active();
      case "IMPORT_ACTIVE": return m.storage_directory_error_import_active();
      case "MIGRATION_ACTIVE": return m.storage_directory_error_move_active();
      case "LAYOUT_MIGRATION_PENDING": return m.recording_layout_migration_pending();
      case "MOVE_ACTIVE": return m.storage_directory_error_move_active();
      case "INSUFFICIENT_SPACE": return m.storage_directory_error_insufficient_space();
      case "SOURCE_CLEANUP_FAILED": return m.storage_directory_error_source_cleanup_failed();
      case "RECOVERY_REQUIRED": return m.storage_directory_error_recovery_required();
      case "RELOCATION_REQUIRED": return m.storage_directory_error_relocation_required();
      case "STORAGE_IO_ERROR": return m.storage_directory_error_storage_io();
      default: return layoutStart.error ? m.recording_layout_migration_retry_error() : errorCode || move.error || preflight.error ? m.storage_directory_error_unknown() : "";
    }
  })();
  function applyDirectory(directory: string) {
    if (useLayoutMigration) {
      layoutStart.mutate(directory, { onSuccess: () => { if (!inline) { setOpen(false); setConfirm(false); } } });
      return;
    }
    move.mutate(directory, { onSuccess: () => { if (!inline) { setOpen(false); setConfirm(false); } }, onError: () => { void status.refetch(); } });
  }
  function preflightDirectory(directory: string, inlineSelection = false) {
    preflight.reset();
    preflight.mutate(directory, {
      onSuccess: ({ containsFiles }) => {
        setOccupiedSelection(containsFiles);
        if (inlineSelection && !containsFiles) applyDirectory(directory);
        else if (!inlineSelection) setConfirm(true);
      },
    });
  }
  function selectFolder() {
    setPickerError(false);
    setOccupiedSelection(false);
    move.reset();
    layoutStart.reset();
    preflight.reset();
    selectDirectory.reset();
    selectDirectory.mutate(inline ? activePath || undefined : path || undefined, {
      onSuccess: ({ directory }) => {
        if (!directory) return;
        setPath(directory);
        setPickerError(false);
        if (inline) preflightDirectory(directory, true);
      },
      onError: () => setPickerError(true),
    });
  }
  const editor = <>
      {!confirm ? <div className="space-y-3">
        <Label htmlFor="recording-directory-path">{m.storage_directory_path_label()}</Label>
        <Input id="recording-directory-path" value={path} disabled={selectDirectory.isPending || transitionLocked} onChange={(event) => { setPath(event.target.value); preflight.reset(); setOccupiedSelection(false); }} autoComplete="off" />
        <Button type="button" variant="outline" disabled={selectDirectory.isPending || transitionLocked} onClick={selectFolder}>{selectDirectory.isPending ? m.common_loading() : m.storage_directory_browse()}</Button>
        <p className="text-xs text-app-text-dim">{m.storage_directory_native_picker_hint()}</p>
        {pathPreview}
        <p className="text-xs text-app-text-dim">{m.storage_directory_destination_guidance()}</p>
        {occupiedSelection && <div role="alert" className="space-y-2 text-sm"><p>{m.storage_directory_occupied_warning()}</p><div className="flex gap-2"><Button variant="outline" disabled={transitionLocked} onClick={() => setOccupiedSelection(false)}>{m.common_cancel()}</Button><Button disabled={transitionLocked} onClick={() => { setOccupiedSelection(false); applyDirectory(path); }}>{m.storage_directory_continue()}</Button></div></div>}
        {pickerError && <p role="alert" className="text-sm text-status-danger">{m.storage_directory_browse_error()}</p>}
        <div className="space-y-2 text-xs text-app-text-dim"><p><strong>{m.storage_directory_old_label()}</strong> {activePath}</p><p><strong>{m.storage_directory_new_label()}</strong> {path}</p></div>
      </div> : <div className="space-y-3">
        <p><strong>{m.storage_directory_old_label()}</strong> <span className="break-all font-mono">{activePath}</span></p>
        <p><strong>{m.storage_directory_new_label()}</strong> <span className="break-all font-mono">{path}</span></p>
        <p className="text-xs text-app-text-dim">{m.storage_directory_move_notice()}</p>
        {occupiedSelection && <p role="alert" className="text-sm text-status-warning">{m.storage_directory_occupied_warning()}</p>}
      </div>}
      {errorMessage && <p role="alert" className="text-sm text-status-danger">{errorMessage}</p>}
      <div className="flex flex-wrap justify-end gap-2">
        {!confirm ? <>
          <Button variant="outline" disabled={transitionLocked || selectDirectory.isPending} onClick={() => setOpen(false)}>{m.common_cancel()}</Button>
          <Button disabled={!path.trim() || transitionLocked || selectDirectory.isPending} onClick={() => preflightDirectory(path)}>{preflight.isPending ? m.common_loading() : m.storage_directory_use()}</Button>
        </> : <>
          <Button variant="outline" disabled={transitionLocked} onClick={() => setConfirm(false)}>{m.common_back()}</Button>
          <Button disabled={transitionLocked} onClick={() => applyDirectory(path)}>{move.isPending || layoutStart.isPending ? m.common_saving() : m.common_apply()}</Button>
        </>}
      </div>
  </>;
  return <div className="space-y-3 rounded-lg border border-app-border bg-app-surface-alt/50 p-4">
    <div className="flex flex-wrap items-center justify-between gap-3"><div className="min-w-0 w-full sm:w-auto sm:flex-1"><Label>{m.storage_directory_active()}</Label><p className="mt-1 break-all font-mono text-sm text-app-text" title={activePath}>{activePath || m.common_loading()}</p></div><div className="flex w-full justify-end gap-2 sm:w-auto"><Button variant="outline" disabled={!activePath} onClick={() => { void navigator.clipboard.writeText(activePath); }}>{m.storage_directory_copy_path()}</Button><Button variant="outline" disabled={disabled || !settingsLoaded || !status.isSuccess || transitionLocked || selectDirectory.isPending} onClick={() => { if (inline) selectFolder(); else { setPath(activePath); setConfirm(false); setOccupiedSelection(false); preflight.reset(); move.reset(); layoutStart.reset(); setOpen(true); } }}>{m.storage_directory_change()}</Button></div></div>
    {moving && <p aria-live="polite" className="text-sm text-app-text-dim">{m.storage_directory_progress({ phase: phaseLabel, completed: status.data?.completedFiles ?? 0, total: status.data?.totalFiles ?? 0 })}</p>}
    {inline && occupiedSelection && <div role="alert" className="space-y-2 rounded border border-status-warning/30 bg-status-warning/5 px-3 py-2 text-sm text-status-warning"><p>{m.storage_directory_occupied_warning()}</p><p className="break-all font-mono text-xs">{path}</p><div className="flex gap-2"><Button variant="outline" disabled={transitionLocked} onClick={() => setOccupiedSelection(false)}>{m.common_cancel()}</Button><Button disabled={transitionLocked} onClick={() => { setOccupiedSelection(false); applyDirectory(path); }}>{m.storage_directory_continue()}</Button></div></div>}
    {inline && pickerError && <p role="alert" className="text-sm text-status-danger">{m.storage_directory_browse_error()}</p>}
    {inline && errorMessage && !pickerError && <p role="alert" className="text-sm text-status-danger">{errorMessage}</p>}
    {!inline && !open && errorMessage && <p role="alert" className="text-sm text-status-danger">{errorMessage}</p>}
    {!inline && <Dialog open={open} onOpenChange={(value) => { if (!transitionLocked && !selectDirectory.isPending) setOpen(value); }}>
      <DialogContent className="space-y-3"><DialogHeader><DialogTitle>{confirm ? m.storage_directory_confirm_title() : m.storage_directory_picker_title()}</DialogTitle><DialogDescription>{confirm ? m.storage_directory_confirm_desc() : m.storage_directory_picker_desc()}</DialogDescription></DialogHeader>{editor}</DialogContent>
    </Dialog>}
  </div>;
}
