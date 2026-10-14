import { useSettings } from "@/hooks/settings";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useMoveRecordingDirectory, useRecordingDirectoryStatus, useRecordingLayoutMigration, useSelectRecordingDirectory, useStartRecordingLayoutMigration } from "@/hooks/recording-storage";
import { m } from "@/paraglide/messages";
import { previewRecordingDirectories } from "@/lib/recording-storage-paths";

export function RecordingDirectoryControl({ disabled = false }: { disabled?: boolean }) {
  const { settingsLoaded } = useSettings();
  const status = useRecordingDirectoryStatus();
  const move = useMoveRecordingDirectory();
  const layoutMigration = useRecordingLayoutMigration();
  const layoutStart = useStartRecordingLayoutMigration();
  const selectDirectory = useSelectRecordingDirectory();
  const [pickerError, setPickerError] = useState(false);
  const [layoutError, setLayoutError] = useState("");
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState("");
  const [confirm, setConfirm] = useState(false);
  const activePath = status.data?.directory ?? "";
  const moving = status.data?.state === "moving";
  const layoutRunning = layoutMigration.data?.progress.status === "running";
  const pendingLayoutTarget = Boolean(layoutMigration.data?.destinationDirectory && layoutMigration.data.progress.status !== "success");
  const transitionLocked = moving || layoutRunning || pendingLayoutTarget || move.isPending || layoutStart.isPending;

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
  const errorCode = status.data?.state === "error" ? status.data.code ?? "" : move.error && "code" in move.error ? String(move.error.code) : "";
  const errorMessage = (() => {
    switch (errorCode) {
      case "INVALID_DIRECTORY": return m.storage_directory_error_invalid_directory();
      case "DESTINATION_NOT_EMPTY": return m.storage_directory_error_destination_not_empty();
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
      default: return errorCode ? m.storage_directory_error_unknown() : "";
    }
  })();
  function applyDirectory() {
    if (useLayoutMigration) {
      setLayoutError("");
      layoutStart.mutate(path, { onSuccess: () => { setOpen(false); setConfirm(false); }, onError: (error) => setLayoutError("code" in error && error.code === "LAYOUT_MIGRATION_PENDING" ? m.recording_layout_migration_pending() : m.recording_layout_migration_retry_error()) });
      return;
    }
    move.mutate(path, { onSuccess: () => { setOpen(false); setConfirm(false); }, onError: () => { void status.refetch(); } });
  }
  return <div className="space-y-3 rounded-lg border border-app-border bg-app-surface-alt/50 p-4">
    <div className="flex flex-wrap items-center justify-between gap-3"><div className="min-w-0 w-full sm:w-auto sm:flex-1"><Label>{m.storage_directory_active()}</Label><p className="mt-1 break-all font-mono text-sm text-app-text" title={activePath}>{activePath || m.common_loading()}</p></div><div className="flex w-full justify-end gap-2 sm:w-auto"><Button variant="outline" disabled={!activePath} onClick={() => { void navigator.clipboard.writeText(activePath); }}>{m.storage_directory_copy_path()}</Button><Button variant="outline" disabled={disabled || !settingsLoaded || !status.isSuccess || transitionLocked} onClick={() => { setPath(activePath); setConfirm(false); setOpen(true); }}>{m.storage_directory_change()}</Button></div></div>
    {moving && <p aria-live="polite" className="text-sm text-app-text-dim">{m.storage_directory_progress({ phase: phaseLabel, completed: status.data?.completedFiles ?? 0, total: status.data?.totalFiles ?? 0 })}</p>}
    {errorMessage && <p role="alert" className="text-sm text-status-danger">{errorMessage}</p>}
    <Dialog open={open} onOpenChange={(value) => { if (!transitionLocked && !selectDirectory.isPending) setOpen(value); }}><DialogContent><DialogHeader><DialogTitle>{confirm ? m.storage_directory_confirm_title() : m.storage_directory_picker_title()}</DialogTitle><DialogDescription>{confirm ? m.storage_directory_confirm_desc() : m.storage_directory_picker_desc()}</DialogDescription></DialogHeader>
      {!confirm ? <div className="space-y-3"><Label htmlFor="recording-directory-path">{m.storage_directory_path_label()}</Label><Input id="recording-directory-path" value={path} disabled={selectDirectory.isPending || transitionLocked} onChange={(event) => setPath(event.target.value)} autoComplete="off"/><Button type="button" variant="outline" disabled={selectDirectory.isPending || transitionLocked} onClick={() => { setPickerError(false); selectDirectory.mutate(path || undefined, { onSuccess: ({ directory }) => { if (directory) setPath(directory); }, onError: () => setPickerError(true) }); }}>{selectDirectory.isPending ? m.common_loading() : m.storage_directory_browse()}</Button><p className="text-xs text-app-text-dim">{m.storage_directory_native_picker_hint()}</p>{pathPreview}<p className="text-xs text-app-text-dim">{m.storage_directory_empty_guidance()}</p>{pickerError && <p role="alert" className="text-sm text-status-danger">{m.storage_directory_browse_error()}</p>}<div className="space-y-2 text-xs text-app-text-dim"><p><strong>{m.storage_directory_old_label()}</strong> {activePath}</p><p><strong>{m.storage_directory_new_label()}</strong> {path}</p></div></div> : <div className="space-y-3"><p><strong>{m.storage_directory_old_label()}</strong> <span className="break-all font-mono">{activePath}</span></p><p><strong>{m.storage_directory_new_label()}</strong> <span className="break-all font-mono">{path}</span></p><p className="text-xs text-app-text-dim">{m.storage_directory_move_notice()}</p></div>}
      {layoutError && <p role="alert" className="text-sm text-status-danger">{layoutError}</p>}
      <DialogFooter>{!confirm ? <><Button variant="outline" disabled={transitionLocked || selectDirectory.isPending} onClick={() => setOpen(false)}>{m.common_cancel()}</Button><Button disabled={!path.trim() || transitionLocked || selectDirectory.isPending} onClick={() => setConfirm(true)}>{m.storage_directory_use()}</Button></> : <><Button variant="outline" disabled={transitionLocked} onClick={() => setConfirm(false)}>{m.common_back()}</Button><Button disabled={transitionLocked} onClick={applyDirectory}>{move.isPending || layoutStart.isPending ? m.common_saving() : m.common_apply()}</Button></>}</DialogFooter>
    </DialogContent></Dialog>
  </div>;
}
