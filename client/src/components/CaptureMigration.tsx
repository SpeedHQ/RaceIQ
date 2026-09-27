import { ArrowRight, CheckCircle2, CircleArrowUp, RefreshCw } from "lucide-react";
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
  const [successDismissed, setSuccessDismissed] = useState(false);

  async function refreshStatus() {
    setRefreshing(true);
    try {
      const response = await client.api.sessions["capture-migration-status"].$get();
      if (!response.ok) throw new Error("status");
      const data = await response.json();
      telemetryStore.actions.setCaptureMigration({ sessionCount: data.sessionCount, captureCount: data.captureCount });
      telemetryStore.actions.restoreCaptureMigrationProgress(data.migrationProgress);
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
    setSuccessDismissed(false);
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
  const compactProgress = progress.status !== "idle";
  const dialogOpen = required || running || (progress.status === "success" && !successDismissed);

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
        <p className="text-xs text-app-text-muted">{available ? m.capture_migration_available({ captures: available.captureCount }) : m.capture_migration_check_description()}</p>
        {running && <MigrationStatus progress={progress} percent={percent} />}
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
    <Dialog open={dialogOpen} modal={!compactProgress}>
      <DialogContent
        showCloseButton={false}
        overlayClassName={compactProgress ? "hidden" : "bg-app-bg/80"}
        size={compactProgress ? "sm" : "md"}
        className={compactProgress ? "top-auto left-auto right-4 bottom-4 w-72 translate-x-0 translate-y-0 gap-0 rounded-lg border-status-info/30 p-4 shadow-xl" : "gap-5 p-6 sm:p-8"}
      >
        <DialogHeader className={compactProgress ? "mb-2 gap-0" : "gap-3"}>
          <div className={compactProgress ? "flex items-center gap-2" : "flex items-center gap-3"}>
            <span className={compactProgress
              ? `shrink-0 ${progress.status === "success" ? "text-status-success" : "text-status-info"}`
              : `flex size-10 shrink-0 items-center justify-center rounded-xl ${progress.status === "success" ? "bg-status-success/10 text-status-success" : "bg-app-accent/10 text-app-accent"}`}>
              {progress.status === "success" ? <CheckCircle2 aria-hidden="true" className={compactProgress ? "size-4" : "size-5"} /> : <CircleArrowUp aria-hidden="true" className={compactProgress ? "size-4" : "size-5"} />}
            </span>
            <DialogTitle className={compactProgress ? "text-sm font-semibold leading-snug" : "text-lg font-semibold leading-tight"}>
              {running ? m.capture_migration_running_title() : progress.status === "success" ? m.capture_migration_complete({ migrated: progress.migrated }) : m.capture_migration_title()}
            </DialogTitle>
          </div>
          {!compactProgress && <DialogDescription className="leading-relaxed text-app-text-secondary">{m.capture_migration_prompt_description()}</DialogDescription>}
        </DialogHeader>
        {!compactProgress && (
          <>
            <div className="rounded-xl border border-app-border bg-app-surface-alt/60 p-4">
              <p className="font-semibold text-app-text">{available ? m.capture_migration_available({ captures: available.captureCount }) : m.capture_migration_running()}</p>
              <div className="mt-3 flex items-start gap-2 border-t border-app-border pt-3">
                <ArrowRight aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-app-accent" />
                <p className="text-sm text-app-text-secondary">{m.capture_migration_savings()}. {m.capture_migration_savings_note()}</p>
              </div>
            </div>
          </>
        )}
        {running && <p className="mb-3 text-xs text-app-text-muted">{m.capture_migration_background()}</p>}
        {statusError && <p role="alert" className="mb-3 text-xs text-status-danger">{m.capture_migration_request_failed()}</p>}
        {running && <p role="status" className="text-xs text-app-text-muted">{m.capture_migration_progress({ done: progress.done, total: progress.total })}</p>}
        {progress.status === "partial" && <p role="alert" className="mb-3 text-xs text-status-danger">{m.capture_migration_partial({ migrated: progress.migrated, failed: progress.failed })}</p>}
        {progress.status === "error" && <p role="alert" className="mb-3 text-xs text-status-danger">{progress.error ?? m.capture_migration_request_failed()}</p>}
        {!running && (
          <Button
            type="button"
            variant="app-primary"
            size="app-md"
            className="w-full"
            disabled={!required && progress.status !== "success"}
            onClick={() => {
              if (progress.status === "success") setSuccessDismissed(true);
              else void convert();
            }}
          >
            {progress.status === "success"
              ? m.common_close()
              : progress.status === "partial" || progress.status === "error"
                ? m.capture_migration_retry()
                : m.capture_migration_convert()}
          </Button>
        )}
      </DialogContent>
    </Dialog>
  );
}

function MigrationStatus({ progress, percent }: { progress: CaptureMigrationState; percent: number }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2 text-xs text-app-text-muted">
        <span>{m.capture_migration_progress({ done: progress.done, total: progress.total })}</span>
        <span aria-hidden="true" className="tabular-nums">{percent}%</span>
      </div>
      <div role="progressbar" aria-label={m.capture_migration_progress_label()} aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.done} aria-valuetext={`${percent}%`} className="h-1.5 overflow-hidden rounded-full bg-app-text/10">
        <div className="h-full rounded-full bg-app-accent transition-all duration-300" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}
