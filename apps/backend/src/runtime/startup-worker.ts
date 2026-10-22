import { MessageChannel, Worker, type MessagePort } from "node:worker_threads";
import { Effect, Fiber, Layer, ManagedRuntime } from "effect";
import { IS_COMPILED } from "@raceiq/backend-core/runtime/config/paths";
import type { ReprocessResult } from "@raceiq/backend-core/session-capture/reprocess";
import { createDatabaseWriteLeaseAuthority, installDatabaseWriteTestHooks, type WriteLeaseRequest, type WriteLeaseResponse } from "@raceiq/backend-core/db/write-coordination";
import { client } from "@raceiq/backend-core/db/index";
import { isLayoutMigrationReadyForStartup, subscribeLayoutMigrationComplete } from "@raceiq/backend-core/session-capture/layout-migration";
import { createStartupReadiness } from "./startup-readiness";

type WorkerMessage = { type: "publication" } | { type: "ready" } | { type: "lap-reprocessed"; reprocessed: ReprocessResult } | { type: "clear-stale-sessions" } | { type: "error"; task: string; error: string } | { type: "stopped" } | WriteLeaseRequest;
export interface StartupWorkerHandle { stop(): Promise<void>; }
export type StartupWorkerTestEvent = { type: "candidatePrepared" | "transactionOpen" | "beforeCommit" | "afterCommit"; eventId: number; sessionId: number } | { type: "stageEntered"; stage: "historical" | "lmu-identity" | "race-results" | "dashboard"; eventId: number } | { type: "workerStopped" | "workerExited"; code?: number };

export function startStartupWorker(notifyDashboardUpdated: () => void, notifyLapReprocessed: (reprocessed: ReprocessResult) => void, clearStaleSessions: () => void, workerTestPort?: MessagePort): StartupWorkerHandle {
  const runtime = ManagedRuntime.make(Layer.empty);
  let stopping = false;
  let stopPromise: Promise<void> | null = null;
  let workerFiber: Fiber.Fiber<never, never> | null = null;
  let resource: StartupWorkerHandle | null = null;

  function createWorkerResource(): StartupWorkerHandle {
    const testChannel = workerTestPort ? new MessageChannel() : null;
    const worker = new Worker(IS_COMPILED ? "./apps/backend/src/runtime/startup-worker-entry.ts" : new URL("./startup-worker-entry", import.meta.url), testChannel ? { workerData: { workerTestPort: testChannel.port1 }, transferList: [testChannel.port1] } : undefined);
    let exited = false;
    let acknowledged = false;
    const { promise: exit, resolve: resolveExit, reject: rejectExit } = Promise.withResolvers<void>();
    void exit.catch(() => {});
    let drain: Promise<void> | null = null;
    const authority = createDatabaseWriteLeaseAuthority((message: WriteLeaseResponse) => worker.postMessage(message), client);
    const removeWriteTestHooks = workerTestPort ? installDatabaseWriteTestHooks({
      waiting: (operation) => workerTestPort.postMessage({ type: "writeWaiting", operation }),
    }) : null;
    let disconnectTestChannel: (() => void) | null = null;
    if (testChannel && workerTestPort) {
      testChannel.port2.on("message", (event: unknown) => workerTestPort.postMessage(event));
      const forward = (message: { type: string; eventId?: number }) => {
        if (message.type === "stopWorker") void stop();
        else if (message.type === "terminateWorker") void worker.terminate();
        else testChannel.port2.postMessage(message);
      };
      workerTestPort.on("message", forward);
      disconnectTestChannel = () => {
        workerTestPort.off("message", forward);
        testChannel.port2.close();
      };
    }
    worker.on("message", (message: WorkerMessage) => {
      if (message.type.startsWith("write-lease-")) authority.receive(message as WriteLeaseRequest);
      else if (message.type === "publication") { if (!stopping) notifyDashboardUpdated(); }
      else if (message.type === "lap-reprocessed") { if (!stopping) notifyLapReprocessed(message.reprocessed); }
      else if (message.type === "clear-stale-sessions") { if (!stopping) clearStaleSessions(); }
      else if (message.type === "error") console.error(`[StartupWorker] ${message.task} failed: ${message.error}`);
      else if (message.type === "stopped") acknowledged = true;
    });
    worker.on("error", (error) => console.error("[StartupWorker] Worker failed:", error));
    worker.on("exit", (code) => {
      exited = true;
      if (!stopping && !acknowledged) console.error(`[StartupWorker] Worker exited unexpectedly (${code})`);
      // The parent owns native SQL handles. Reclaim admission only after
      // submitted work settles and uncommitted transactions roll back/close.
      void authority.workerExited().then(() => {
        removeWriteTestHooks?.();
        disconnectTestChannel?.();
        workerTestPort?.postMessage({ type: "workerExited", code });
        resolveExit();
      }, (error) => {
        console.error("[StartupWorker] Parent SQL cleanup failed:", error);
        removeWriteTestHooks?.();
        disconnectTestChannel?.();
        rejectExit(error);
      });
    });
    return {
      stop() {
        if (drain) return drain;
        if (!exited) worker.postMessage({ type: "stop" });
        drain = (async () => {
          await exit;
          await authority.stop();
          worker.removeAllListeners();
        })();
        return drain;
      },
    };
  }

  const readiness = createStartupReadiness({
    inspect: isLayoutMigrationReadyForStartup,
    subscribe: subscribeLayoutMigrationComplete,
    onBlocked(_reason, cause) {
      if (cause !== undefined) console.error("[StartupWorker] Failed to inspect recording layout migration readiness:", cause);
      console.log("[StartupWorker] Deferred until recording layout migration completes");
    },
    launch() {
      if (stopping) return;
      workerFiber = runtime.runFork(Effect.scoped(Effect.gen(function* () {
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            if (stopping) return null;
            resource = createWorkerResource();
            return resource;
          }),
          (worker) => Effect.promise(async () => { await worker?.stop(); }),
        );
        return yield* Effect.never;
      })));
    },
  });

  function stop(): Promise<void> {
    if (stopPromise) return stopPromise;
    stopping = true;
    // Tell the worker synchronously, before awaiting any parent finalizers.
    const workerStop = resource?.stop();
    const readinessStop = readiness.stop();
    stopPromise = (async () => {
      try {
        await readinessStop;
        if (workerFiber) await runtime.runPromise(Fiber.interrupt(workerFiber));
        await workerStop;
      } finally {
        await runtime.dispose();
      }
    })();
    return stopPromise;
  }
  return { stop };
}
