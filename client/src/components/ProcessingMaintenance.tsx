import { canStartReprocess, isReprocessPending, submitStaleSessionReprocess } from "@/lib/reprocess-state";
import { client } from "@/lib/rpc";
import { m } from "@/paraglide/messages";
import { telemetryStore, useTelemetryStore } from "@/stores/telemetry";
import { RaceResultStatus } from "./RaceResultStatus";
import { Button } from "./ui/button";

export function LapDetectorStatus() {
  const stale = useTelemetryStore((state) => state.staleLapDetection);
  const reprocessState = useTelemetryStore((state) => state.reprocessState);
  const running = isReprocessPending(reprocessState);

  async function reparse() {
    const store = telemetryStore.get();
    if (!canStartReprocess(store.reprocessState)) return;

    const total = store.reprocessState.status === "error" ? store.reprocessState.total : store.staleLapDetection?.sessionCount;
    if (!total) return;

    telemetryStore.actions.beginReprocess(total);
    try {
      await submitStaleSessionReprocess(() => client.api.sessions["reprocess-stale"].$post());
      telemetryStore.actions.setStaleLapDetection(null);
      telemetryStore.actions.completeReprocess();
    } catch {
      telemetryStore.actions.failReprocess(m.root_reprocessing_failed_description());
    }
  }

  const progress = reprocessState.status === "idle" ? null : reprocessState;
  const percent = progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;
  return (
    <section className="space-y-3 rounded-lg border border-app-border bg-app-surface-alt/50 p-4">
      <h3 className="text-sm font-semibold text-app-text">{m.diag_lap_detection_title()}</h3>
      {stale ? (
        <p className="text-xs text-app-text-muted">{m.diag_lap_detection_stale({ count: stale.sessionCount })}</p>
      ) : (
        <p className="text-xs text-status-success">{m.diag_lap_detection_current()}</p>
      )}
      {progress && (
        <div className="space-y-2">
          <div className="h-2 overflow-hidden rounded-full bg-app-text/10">
            <div className="h-full rounded-full bg-status-info transition-all" style={{ width: `${percent}%` }} />
          </div>
          <p className="text-xs text-app-text-muted">{m.diag_lap_detection_progress({ done: progress.done, total: progress.total })}</p>
        </div>
      )}
      {reprocessState.status === "error" && <p className="text-xs text-status-danger">{m.diag_lap_detection_error()}</p>}
      {stale && (
        <Button type="button" disabled={running} onClick={reparse}>
          {running ? m.root_reprocessing() : m.diag_lap_detection_reparse()}
        </Button>
      )}
    </section>
  );
}

export function ProcessingMaintenance() {
  return (
    <div className="space-y-4">
      <LapDetectorStatus />
      <RaceResultStatus />
    </div>
  );
}
