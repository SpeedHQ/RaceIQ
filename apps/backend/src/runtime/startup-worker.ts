import { Worker } from "node:worker_threads";
import { IS_COMPILED } from "@raceiq/backend-core/runtime/config/paths";

type WorkerMessage = { type: "publication" } | { type: "ready" } | { type: "error"; task: string; error: string } | { type: "stopped" };
export interface StartupWorkerHandle { stop(): Promise<void>; }

export function startStartupWorker(notifyDashboardUpdated: () => void): StartupWorkerHandle {
  // Bun resolves embedded worker entrypoint paths in compiled builds; dev uses module-relative URL.
  const worker = new Worker(IS_COMPILED ? "./apps/backend/src/runtime/startup-worker-entry.ts" : new URL("./startup-worker-entry", import.meta.url));
  let stopping = false;
  let exited = false;
  let stopResolve: (() => void) | null = null;
  let stopTimer: ReturnType<typeof setTimeout> | null = null;
  let stopPromise: Promise<void> | null = null;
  const stopped = new Promise<void>((resolve) => { stopResolve = resolve; });
  const settle = () => {
    clearTimeout(stopTimer!);
    stopResolve?.();
  };

  worker.on("message", (message: WorkerMessage) => {
    if (message.type === "publication") notifyDashboardUpdated();
    else if (message.type === "error") console.error(`[StartupWorker] ${message.task} failed: ${message.error}`);
    else if (message.type === "stopped") settle();
  });
  worker.on("error", (error) => {
    console.error("[StartupWorker] Worker failed:", error);
    clearTimeout(stopTimer!);
    if (stopping) void worker.terminate().finally(() => stopResolve?.());
  });
  worker.on("exit", (code) => {
    exited = true;
    if (!stopping) console.error(`[StartupWorker] Worker exited unexpectedly (${code})`);
    settle();
  });

  return {
    stop() {
      if (stopPromise) return stopPromise;
      stopping = true;
      if (!exited) {
        worker.postMessage({ type: "stop" });
        // Busy historical work may not yield quickly; terminate after bounded grace.
        stopTimer = setTimeout(() => {
          console.error("[StartupWorker] Shutdown grace expired; terminating worker");
          void worker.terminate().finally(() => stopResolve?.());
        }, 5_000);
      }
      stopPromise = stopped.then(async () => {
        await worker.terminate();
      });
      return stopPromise;
    },
  };
}
