import { RefreshCw } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { client } from "@/lib/rpc";
import { m } from "@/paraglide/messages";
import { telemetryStore, useTelemetryStore, type CaptureMigrationState } from "@/stores/telemetry";

export function CaptureMigration({ compact = false }: { compact?: boolean }) {
  const available = useTelemetryStore((state) => state.captureMigration);
  const progress = useTelemetryStore((state) => state.captureMigrationState);
  const [statusError, setStatusError] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  async function refreshStatus() {
    setRefreshing(true);
    try {
      const response = await client.api.sessions["capture-migration-status"].$get();
      if (!response.ok) throw new Error("status");
      const data = await response.json();
      telemetryStore.actions.setCaptureMigration({ sessionCount: data.sessionCount, captureCount: data.captureCount });
      setStatusError(false);
    } catch {
      setStatusError(true);
    } finally {
      setRefreshing(false);
    }
  }

  async function convert() {
    const current = telemetryStore.get().captureMigrationState;
    const count = available ? available.captureCount : current.total;
    if (!count || current.status === "running") return;
    telemetryStore.actions.beginCaptureMigration(count);
    try {
      const response = await client.api.sessions["migrate-captures"].$post();
      if (!response.ok) throw new Error("migration");
      const result = await response.json();
      telemetryStore.actions.finishCaptureMigration(result);
      await refreshStatus();
    } catch {
      telemetryStore.actions.failCaptureMigration(m.capture_migration_request_failed());
    }
  }

  const running = progress.status === "running";
  const percent = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;
  const required = Boolean(available && available.captureCount > 0);
  const showStatus = progress.status !== "idle";

  if (compact) {
    return (
      <section className="space-y-3 rounded-lg border border-app-border bg-app-surface-alt/50 p-4" aria-labelledby="capture-migration-maintenance-title">
        <div className="flex items-center justify-between gap-3">
          <h3 id="capture-migration-maintenance-title" className="text-sm font-semibold text-app-text">{m.capture_migration_title()}</h3>
          <Button type="button" variant="app-outline" size="app-sm" disabled={refreshing} onClick={() => void refreshStatus()}>
            <RefreshCw aria-hidden="true" className={refreshing ? "size-3 animate-spin" : "size-3"} />{m.capture_migration_refresh()}
          </Button>
        </div>
        {statusError && <p role="alert" className="text-xs text-status-danger">{m.capture_migration_request_failed()}</p>}
        <p className="text-xs text-app-text-muted">{available ? m.capture_migration_available({ sessions: available.sessionCount, captures: available.captureCount }) : m.capture_migration_check_description()}</p>
        {showStatus && <MigrationStatus progress={progress} percent={percent} />}
        {progress.status === "partial" && <p role="alert" className="text-xs text-status-danger">{m.capture_migration_partial({ migrated: progress.migrated, failed: progress.failed })}</p>}
        {progress.status === "error" && <p role="alert" className="text-xs text-status-danger">{progress.error ?? m.capture_migration_request_failed()}</p>}
        {required && (
          <Button type="button" variant="app-primary" size="app-md" disabled={running} onClick={() => void convert()}>
            {running ? <RefreshCw aria-hidden="true" className="size-3 animate-spin" /> : null}
            {running ? m.capture_migration_running() : progress.status === "partial" || progress.status === "error" ? m.capture_migration_retry() : m.capture_migration_convert()}
          </Button>
        )}
        {progress.status === "success" && <p role="status" className="text-xs text-status-success">{m.capture_migration_complete({ migrated: progress.migrated })}</p>}
      </section>
    );
  }

  return (
    <Dialog open={required || running}>
      <DialogContent showCloseButton={false} overlayClassName="bg-app-bg/80" size="md">
        <DialogHeader>
          <DialogTitle>{m.capture_migration_title()}</DialogTitle>
          <DialogDescription>{m.capture_migration_prompt_description()}</DialogDescription>
        </DialogHeader>
        <p className="text-sm text-app-text-muted">{available ? m.capture_migration_available({ sessions: available.sessionCount, captures: available.captureCount }) : m.capture_migration_running()}</p>
        {statusError && <p role="alert" className="text-xs text-status-danger">{m.capture_migration_request_failed()}</p>}
        {progress.status !== "idle" && <MigrationStatus progress={progress} percent={percent} />}
        {progress.status === "partial" && <p role="alert" className="text-xs text-status-danger">{m.capture_migration_partial({ migrated: progress.migrated, failed: progress.failed })}</p>}
        {progress.status === "error" && <p role="alert" className="text-xs text-status-danger">{progress.error ?? m.capture_migration_request_failed()}</p>}
        {progress.status === "success" && <p role="status" className="text-xs text-status-success">{m.capture_migration_complete({ migrated: progress.migrated })}</p>}
        <Button type="button" variant="app-primary" size="app-md" disabled={running || !required} onClick={() => void convert()}>
          {running ? m.capture_migration_running() : progress.status === "partial" || progress.status === "error" ? m.capture_migration_retry() : m.capture_migration_convert()}
        </Button>
      </DialogContent>
    </Dialog>
  );
}

function MigrationStatus({ progress, percent }: { progress: CaptureMigrationState; percent: number }) {
  return (
    <div className="space-y-2">
      {progress.status !== "error" && <div role="progressbar" aria-label={m.capture_migration_progress_label()} aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.done} aria-valuetext={`${percent}%`} className="h-2 overflow-hidden rounded-full bg-app-text/10"><div className={`h-full transition-all ${progress.status === "success" ? "bg-status-success" : "bg-status-info"}`} style={{ width: `${percent}%` }} /></div>}
      <p className="text-xs text-app-text-muted">{m.capture_migration_progress({ done: progress.done, total: progress.total })}</p>
    </div>
  );
}
