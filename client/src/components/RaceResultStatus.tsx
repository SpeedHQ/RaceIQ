import { RefreshCw } from "lucide-react";
import { m } from "@/paraglide/messages";
import { telemetryStore, useTelemetryStore } from "../stores/telemetry";
import { Button } from "./ui/button";

export function RaceResultStatus({ compact = false }: { compact?: boolean }) {
  const stale = useTelemetryStore((s) => s.staleRaceResults);
  const progress = useTelemetryStore((s) => s.raceResultReprocessProgress);
  const error = useTelemetryStore((s) => s.raceResultReprocessError);
  const running = progress != null && progress.done < progress.total;

  async function recalculate() {
    if (!stale || running) return;
    telemetryStore.actions.setRaceResultReprocessError(null);
    telemetryStore.actions.setRaceResultReprocessProgress({ done: 0, total: stale.sessionCount });
    try {
      const response = await fetch("/api/race-results/reconcile-stale", { method: "POST" });
      if (!response.ok) throw new Error(`Server returned ${response.status}`);
    } catch (caught) {
      telemetryStore.actions.setRaceResultReprocessProgress(null);
      telemetryStore.actions.setRaceResultReprocessError(caught instanceof Error ? caught.message : m.diag_race_results_error());
    }
  }

  if (!stale && !progress && !error) {
    if (compact) return null;
    return (
      <section className="space-y-3 rounded-lg border border-app-border bg-app-surface-alt/50 p-4">
        <h3 className="text-sm font-semibold text-app-text">{m.diag_race_results_title()}</h3>
        <p className="text-xs text-status-success">{m.diag_race_results_current()}</p>
      </section>
    );
  }

  if (compact) {
    return (
      <div className="fixed bottom-4 right-4 z-50 w-72 rounded-lg border border-status-info/30 bg-app-surface p-4 shadow-xl">
        <div className="mb-2 flex items-center gap-2">
          <RefreshCw className="size-4 shrink-0 text-status-info" />
          <span className="text-sm font-semibold text-app-text">{m.root_race_results_outdated()}</span>
        </div>
        {stale && <p className="mb-3 text-xs text-app-text-muted">{m.root_race_results_outdated_desc({ count: stale.sessionCount })}</p>}
        {progress && <p className="mb-3 text-xs text-app-text-muted">{m.diag_race_results_progress({ done: progress.done, total: progress.total })}</p>}
        {error && <p className="mb-3 text-xs text-status-danger">{m.diag_race_results_error()}</p>}
        {stale && (
          <Button type="button" disabled={running} onClick={recalculate} className="w-full">
            {running ? m.root_race_results_recalculating() : m.root_recalculate_race_results({ count: stale.sessionCount })}
          </Button>
        )}
      </div>
    );
  }

  const percent = progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;
  return (
    <section className="space-y-3 rounded-lg border border-app-border bg-app-surface-alt/50 p-4">
      <div>
        <h3 className="text-sm font-semibold text-app-text">{m.diag_race_results_title()}</h3>
        {stale ? (
          <p className="mt-1 text-xs text-app-text-muted">{m.diag_race_results_stale({ count: stale.sessionCount })}</p>
        ) : (
          <p className="mt-1 text-xs text-status-success">{m.diag_race_results_current()}</p>
        )}
      </div>
      {stale && <p className="text-xs text-app-text-dim">{m.diag_race_results_versions({ stored: "older", current: stale.currentVersion })}</p>}
      {progress && (
        <div className="space-y-2">
          <div className="h-2 overflow-hidden rounded-full bg-app-text/10">
            <div className="h-full rounded-full bg-status-info transition-all" style={{ width: `${percent}%` }} />
          </div>
          <p className="text-xs text-app-text-muted">{m.diag_race_results_progress({ done: progress.done, total: progress.total })}</p>
        </div>
      )}
      {error && <p className="text-xs text-status-danger">{m.diag_race_results_error()}</p>}
      {stale && (
        <Button type="button" disabled={running} onClick={recalculate}>
          {running ? m.root_race_results_recalculating() : m.diag_race_results_recalculate()}
        </Button>
      )}
    </section>
  );
}
