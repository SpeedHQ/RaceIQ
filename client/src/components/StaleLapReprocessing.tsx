import { CheckCircle2, RefreshCw, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { canStartReprocess, submitStaleSessionReprocess } from "@/lib/reprocess-state";
import { client } from "@/lib/rpc";
import { m } from "@/paraglide/messages";
import { useTelemetryStore } from "@/stores/telemetry";

function ReprocessStatusIcon({ status }: { status: "submitting" | "progressing" | "success" | "error" }) {
  if (status === "success") {
    return <CheckCircle2 aria-hidden="true" className="size-5 shrink-0 text-status-success" />;
  }
  if (status === "error") {
    return <TriangleAlert aria-hidden="true" className="size-5 shrink-0 text-status-danger" />;
  }
  return <RefreshCw aria-hidden="true" className="size-5 shrink-0 animate-spin text-status-info" />;
}

export function StaleLapReprocessing() {
  const staleLapDetection = useTelemetryStore((state) => state.staleLapDetection);
  const reprocessState = useTelemetryStore((state) => state.reprocessState);
  const dismissReprocess = useTelemetryStore((state) => state.dismissReprocess);

  const handleReprocess = async () => {
    const store = useTelemetryStore.getState();
    if (!canStartReprocess(store.reprocessState)) return;

    const total = store.reprocessState.status === "error" ? store.reprocessState.total : store.staleLapDetection?.sessionCount;
    if (!total) return;

    store.beginReprocess(total);
    try {
      await submitStaleSessionReprocess(() => client.api.sessions["reprocess-stale"].$post());
      const currentStore = useTelemetryStore.getState();
      currentStore.setStaleLapDetection(null);
      currentStore.completeReprocess();
    } catch {
      useTelemetryStore.getState().failReprocess(m.root_reprocessing_failed_description());
    }
  };

  const showNotification = staleLapDetection && reprocessState.status === "idle";
  const showDialog = reprocessState.open;
  if (!showNotification && !showDialog) return null;

  const title =
    reprocessState.status === "success"
      ? m.root_reprocessing_complete()
      : reprocessState.status === "error"
        ? m.root_reprocessing_failed()
        : reprocessState.status === "submitting"
          ? m.root_reprocessing_starting()
          : m.root_reprocessing();

  const percent = reprocessState.status === "idle" || reprocessState.total === 0 ? 0 : Math.round((reprocessState.done / reprocessState.total) * 100);

  return (
    <>
      {showNotification && (
        <div role="status" className="fixed right-4 bottom-4 z-50 w-72 rounded-lg border border-status-info/30 bg-app-surface p-4 shadow-xl">
          <div className="mb-2 flex items-center gap-2">
            <RefreshCw aria-hidden="true" className="size-4 shrink-0 text-status-info" />
            <span className="text-sm font-semibold text-app-text">{m.root_lap_detection_updated()}</span>
          </div>
          <p className="mb-3 text-xs text-app-text-muted">
            {staleLapDetection.sessionCount === 1 ? m.root_lap_detection_updated_description_one() : m.root_lap_detection_updated_description({ count: staleLapDetection.sessionCount })}
          </p>
          <Button type="button" variant="app-primary" size="app-md" onClick={() => void handleReprocess()} className="w-full">
            <RefreshCw aria-hidden="true" className="size-3" />
            {staleLapDetection.sessionCount === 1 ? m.root_reparse_session() : m.root_reparse_sessions({ count: staleLapDetection.sessionCount })}
          </Button>
        </div>
      )}

      {showDialog && (
        <Dialog open={reprocessState.open} onOpenChange={(open) => !open && dismissReprocess()}>
          <DialogContent showCloseButton={false} className="w-96 border border-app-border bg-app-surface p-6 text-app-text sm:max-w-96">
            <DialogHeader>
              <div className="flex items-center gap-3">
                <ReprocessStatusIcon status={reprocessState.status} />
                <DialogTitle className="flex-1 text-sm font-semibold">{title}</DialogTitle>
              </div>
              <DialogDescription className={reprocessState.status === "error" ? "text-status-danger" : "text-app-text-muted"}>
                {reprocessState.status === "error"
                  ? reprocessState.message
                  : m.root_reprocessing_progress({
                      done: String(reprocessState.done),
                      total: String(reprocessState.total),
                    })}
              </DialogDescription>
            </DialogHeader>

            {reprocessState.status !== "error" && (
              <div
                role="progressbar"
                aria-label={title}
                aria-valuemin={0}
                aria-valuemax={reprocessState.total}
                aria-valuenow={reprocessState.done}
                aria-valuetext={`${percent}%`}
                className="h-2 w-full overflow-hidden rounded-full bg-app-text/10"
              >
                <div className={`h-full rounded-full transition-all duration-300 ${reprocessState.status === "success" ? "bg-status-success" : "bg-status-info"}`} style={{ width: `${percent}%` }} />
              </div>
            )}

            {reprocessState.status === "success" && <p className="text-center text-xs text-status-success">{m.root_all_sessions_updated()}</p>}

            <DialogFooter className="-mx-6 -mb-6 border-app-border bg-app-surface-alt px-6">
              <Button type="button" variant="app-outline" size="app-md" onClick={dismissReprocess}>
                {m.common_close()}
              </Button>
              {reprocessState.status === "error" && (
                <Button type="button" variant="app-primary" size="app-md" onClick={() => void handleReprocess()}>
                  <RefreshCw aria-hidden="true" />
                  {m.root_reprocess_retry()}
                </Button>
              )}
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
