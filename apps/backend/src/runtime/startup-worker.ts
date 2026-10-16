import { Worker } from "node:worker_threads";
import { IS_COMPILED } from "@raceiq/backend-core/runtime/config/paths";
import type { ReprocessResult } from "@raceiq/backend-core/session-capture/reprocess";
import { isLayoutMigrationReadyForStartup, subscribeLayoutMigrationComplete } from "../session-capture/layout-migration";

type WorkerMessage = { type: "publication" } | { type: "ready" } | { type: "lap-reprocessed"; reprocessed: ReprocessResult } | { type: "clear-stale-sessions" } | { type: "error"; task: string; error: string } | { type: "stopped" };
export interface StartupWorkerHandle { stop(): Promise<void>; }

export function startStartupWorker(notifyDashboardUpdated: () => void, notifyLapReprocessed: (reprocessed: ReprocessResult) => void, clearStaleSessions: () => void): StartupWorkerHandle {
  let stopping = false;
  let started = false;
  let readinessChecked = false;
  let worker: Worker | null = null;
  let unsubscribe: (() => void) | null = null;
  let stopPromise: Promise<void> | null = null;
  let stopWorker: (() => Promise<void>) | null = null;

  const start = () => {
    if (stopping || started) return;
    started = true;
    unsubscribe?.();
    unsubscribe = null;
    launch();
  };
  const checkReadiness = async () => {
    if (stopping || readinessChecked) return;
    readinessChecked = true;
    try {
      if (await isLayoutMigrationReadyForStartup()) start();
      else console.log("[StartupWorker] Deferred until recording layout migration completes");
    } catch (error) {
      console.error("[StartupWorker] Failed to inspect recording layout migration readiness:", error);
      console.log("[StartupWorker] Deferred until recording layout migration completes");
    }
  };
  unsubscribe = subscribeLayoutMigrationComplete(start);
  void checkReadiness();

  function launch() {
    if (stopping || worker) return;
    // Bun resolves embedded worker entrypoint paths in compiled builds; dev uses module-relative URL.
    const currentWorker = new Worker(IS_COMPILED ? "./apps/backend/src/runtime/startup-worker-entry.ts" : new URL("./startup-worker-entry", import.meta.url));
    worker = currentWorker;
    let exited = false;
    let stopResolve: (() => void) | null = null;
    let stopTimer: ReturnType<typeof setTimeout> | null = null;
    let workerStopPromise: Promise<void> | null = null;
    const stopped = new Promise<void>((resolve) => { stopResolve = resolve; });
    const settle = () => {
      clearTimeout(stopTimer!);
      stopResolve?.();
    };

    currentWorker.on("message", (message: WorkerMessage) => {
      if (message.type === "publication") notifyDashboardUpdated();
      else if (message.type === "lap-reprocessed") notifyLapReprocessed(message.reprocessed);
      else if (message.type === "clear-stale-sessions") clearStaleSessions();
      else if (message.type === "error") console.error(`[StartupWorker] ${message.task} failed: ${message.error}`);
      else if (message.type === "stopped") settle();
    });
    currentWorker.on("error", (error) => {
      console.error("[StartupWorker] Worker failed:", error);
      clearTimeout(stopTimer!);
      if (stopping) void currentWorker.terminate().finally(() => stopResolve?.());
    });
    currentWorker.on("exit", (code) => {
      exited = true;
      if (!stopping) console.error(`[StartupWorker] Worker exited unexpectedly (${code})`);
      settle();
    });
    stopWorker = () => {
      if (workerStopPromise) return workerStopPromise;
      if (!exited) {
        currentWorker.postMessage({ type: "stop" });
        // Busy historical work may not yield quickly; terminate after bounded grace.
        stopTimer = setTimeout(() => {
          console.error("[StartupWorker] Shutdown grace expired; terminating worker");
          void currentWorker.terminate().finally(() => stopResolve?.());
        }, 5_000);
      }
      workerStopPromise = stopped.then(async () => { await currentWorker.terminate(); });
      return workerStopPromise;
    };
    if (stopping) void stopWorker();
  }

  return {
    stop() {
      if (stopPromise) return stopPromise;
      stopping = true;
      unsubscribe?.();
      unsubscribe = null;
      stopPromise = stopWorker ? stopWorker() : Promise.resolve();
      return stopPromise;
    },
  };
}
