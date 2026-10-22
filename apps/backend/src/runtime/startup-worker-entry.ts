import { parentPort, workerData, type MessagePort } from "node:worker_threads";
import type { DashboardPublicationHooks } from "@raceiq/backend-core/db/dashboard-summary-queries";
import { initGameAdapters } from "@raceiq/game-catalogs/games/init";
import { serverReleaseFeatures } from "@raceiq/backend-core/runtime/config/release-features";
import { initServerGameAdapters } from "../games/init";
import { initDb, closeDb } from "@raceiq/backend-core/db/index";
import { backfillAllRaceResults } from "@raceiq/backend-core/race-results/reconcile";
import { backfillLMUSessionIdentity } from "../imports/lmu-session-identity-backfill";
import { startDashboardProcessor, type DashboardProcessorHandle } from "@raceiq/backend-core/session-capture/dashboard-processor";
import { setDashboardPublicationNotifier } from "@raceiq/backend-core/db/dashboard-summary-queries";
import { initMotecTargets } from "../games/motec-init";
import { reconcileHistoricalSessions } from "@raceiq/backend-core/session-capture/reconcile";
import { backfillSessionStrategies } from "@raceiq/race-strategy/server";
import { ALL_DETECTOR_IDS } from "./startup-jobs";
import { getAllServerGames } from "@raceiq/backend-core/games/registry";
import { countStaleSessions, deleteEmptySessions } from "@raceiq/backend-core/db/session-queries";
import { hydrateDiscoveredAcEvoCars, listDiscoveredCars } from "@raceiq/backend-core/db/discovered-cars";
import { hydrateDiscoveredAcEvoTracks, listDiscoveredTracks } from "@raceiq/backend-core/db/discovered-tracks";
import { injectDiscoveredIRacingIdentity } from "@raceiq/game-iracing-metadata/index";
import { injectDiscoveredLMUIdentity } from "@raceiq/game-lmu-metadata/index";

import { configureDatabaseWriteWorkerTransport, type WriteLeaseRequest, type WriteLeaseResponse } from "@raceiq/backend-core/db/write-coordination";
import { createStartupStageRunner, orderStartupStages, registerStartupStage } from "./startup-stage-runner";
type StartupStageId = keyof typeof startupStages;
const port = parentPort!;
let stopping = false;
let backgroundTasks: Promise<void>[] = [];
let processor: DashboardProcessorHandle | null = null;
let workerInitialized = false;
let shutdownPromise: Promise<void> | null = null;
const leaseListeners = new Set<(message: WriteLeaseResponse) => void>();
const testPort = (workerData as { workerTestPort?: MessagePort } | undefined)?.workerTestPort;
let testEventSequence = 0;
const testBarriers = new Map<number, () => void>();
testPort?.on("message", (message: { type: string; eventId?: number }) => {
  if (message.type === "release" && message.eventId !== undefined) {
    testBarriers.get(message.eventId)?.();
    testBarriers.delete(message.eventId);
  } else if (message.type === "release-all") {
    for (const release of testBarriers.values()) release();
    testBarriers.clear();
  }
});
const testBarrier = async (event: { type: "candidatePrepared" | "transactionOpen" | "beforeCommit" | "afterCommit"; sessionId: number } | { type: "stageEntered"; stage: StartupStageId | "dashboard" }) => {
  if (!testPort) return;
  const eventId = ++testEventSequence;
  await new Promise<void>((resolve) => {
    testBarriers.set(eventId, resolve);
    testPort.postMessage({ ...event, eventId });
  });
};
const publicationHooks: DashboardPublicationHooks | undefined = testPort ? {
  candidatePrepared: (sessionId) => testBarrier({ type: "candidatePrepared", sessionId }),
  transactionOpen: (sessionId) => testBarrier({ type: "transactionOpen", sessionId }),
  beforeCommit: (sessionId) => testBarrier({ type: "beforeCommit", sessionId }),
  afterCommit: (sessionId) => testBarrier({ type: "afterCommit", sessionId }),
} : undefined;
const disconnectLeaseTransport = configureDatabaseWriteWorkerTransport({
  request: (message: WriteLeaseRequest) => port.postMessage(message),
  subscribe(listener) {
    leaseListeners.add(listener);
    return () => leaseListeners.delete(listener);
  },
});
port.on("message", (message: { type: string }) => {
  if (message.type === "stop") {
    stopping = true;
    if (workerInitialized) void shutdown();
  } else if (message.type.startsWith("write-lease-")) {
    for (const listener of leaseListeners) listener(message as WriteLeaseResponse);
  }
});
let channelClosed = false;
port.on("close", () => {
  channelClosed = true;
  stopping = true;
  for (const listener of leaseListeners) listener({ type: "write-lease-channel-closed", reason: "Startup worker lease channel closed" });
  if (workerInitialized) void shutdown();
});

function shutdown(): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  stopping = true;
  setDashboardPublicationNotifier(null);
  const processorStop = processor?.stop();
  const stageStop = startupStageRunner.stop();
  testPort?.postMessage({ type: "workerStopping" });
  shutdownPromise = (async () => {
    for (const release of testBarriers.values()) release();
    testBarriers.clear();
    const settled = await Promise.allSettled([stageStop, processorStop, ...backgroundTasks]);
    for (const result of settled) if (result.status === "rejected") console.error("[StartupWorker] Shutdown finalizer failed:", result.reason);
    closeDb();
    disconnectLeaseTransport();
    testPort?.postMessage({ type: "workerStopped" });
    testPort?.close();
    if (!channelClosed) port.postMessage({ type: "stopped" });
    port.close();
  })();
  return shutdownPromise;
}
function formatFailure(error: unknown): string {
  const chain: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current != null; depth++) {
    if (current instanceof Error) {
      chain.push(current.message);
      current = current.cause;
    } else {
      chain.push(String(current));
      break;
    }
  }
  return chain.join(" <- ");
}

const startupStages = {
  historical: registerStartupStage({
    name: "Historical session reconciliation",
    async run() {
      const counts = await reconcileHistoricalSessions((reprocessed) => {
        if (!stopping) port.postMessage({ type: "lap-reprocessed", reprocessed });
      });
      const stale = await countStaleSessions(ALL_DETECTOR_IDS, getAllServerGames().map((adapter) => adapter.id));
      return { ...counts, stale };
    },
    isComplete: (counts) => counts.failed === 0 && counts.missingCapture === 0 && counts.stale === 0,
    blockedReason(counts) {
      console.log("[SessionRepair] Historical session reconciliation incomplete:", counts);
      return `failed=${counts.failed}, missingCapture=${counts.missingCapture}, stale=${counts.stale}`;
    },
    async onComplete(counts, signal) {
      await deleteEmptySessions();
      if (signal.aborted) return;
      port.postMessage({ type: "clear-stale-sessions" });
      console.log("[SessionRepair] Historical session reconciliation complete:", counts);
    },
  }),
  "lmu-identity": registerStartupStage({
    name: "LMU session identity backfill",
    async run() {
      const counts = await backfillLMUSessionIdentity();
      console.log("[LMU] Session identity backfill result:", counts);
      return counts;
    },
    isComplete: (counts) => counts.unresolved === 0,
    blockedReason: (counts) => `unresolved=${counts.unresolved}`,
    onComplete: (counts) => { console.log("[LMU] Session identity backfill complete:", counts); },
  }),
  "race-results": registerStartupStage({
    name: "Race-result backfill",
    run: () => backfillAllRaceResults(),
    isComplete: (counts) => counts.errors === 0 && counts.failedGames.length === 0,
    blockedReason(counts) {
      console.log("[RaceResults] Backfill incomplete:", counts);
      return `errors=${counts.errors}, failedGames=${counts.failedGames.map(({ gameId, error }) => `${gameId}: ${error}`).join("; ") || "none"}`;
    },
    onComplete: (counts) => { console.log("[RaceResults] Backfill complete:", counts); },
  }),
} as const;

const startupOrder = [
  "historical",
  "lmu-identity",
  "race-results",
] as const satisfies readonly StartupStageId[];

const startupStageRunner = createStartupStageRunner(
  orderStartupStages(startupStages, startupOrder),
  (stage, reason, kind) => port.postMessage({
    type: "error",
    task: stage.name,
    error: kind === "blocked" ? `Startup reconciliation incomplete: ${reason}` : reason,
  }),
  (stage) => testBarrier({ type: "stageEntered", stage: stage.id }),
);

async function start(): Promise<void> {
  try {
    initGameAdapters(serverReleaseFeatures);
    initServerGameAdapters(serverReleaseFeatures);
    initMotecTargets();
    await initDb();
    await hydrateDiscoveredAcEvoCars();
    await hydrateDiscoveredAcEvoTracks();
    for (const gameId of ["iracing", "lmu"] as const) {
      const [cars, tracks] = await Promise.all([listDiscoveredCars(gameId), listDiscoveredTracks(gameId)]);
      if (gameId === "iracing") injectDiscoveredIRacingIdentity(cars, tracks);
      else injectDiscoveredLMUIdentity(cars, tracks);
    }
    workerInitialized = true;
    if (stopping) {
      await shutdown();
      return;
    }
    setDashboardPublicationNotifier(() => { if (!stopping) port.postMessage({ type: "publication" }); });
    port.postMessage({ type: "ready" });

    backgroundTasks = [(async () => {
      const complete = await startupStageRunner.run();
      if (!stopping && complete) {
        await testBarrier({ type: "stageEntered", stage: "dashboard" });
        if (stopping) return;
        console.log("[StartupWorker] Starting dashboard processor");
        processor = startDashboardProcessor({ publicationHooks });
      }
      if (!stopping) {
        const counts = await backfillSessionStrategies((reprocessed) => {
          if (!stopping) port.postMessage({ type: "lap-reprocessed", reprocessed });
        }, () => stopping);
        console.log("[StrategyBackfill] Complete:", counts);
      }
    })()];
    void backgroundTasks[0].then(
      () => {
        if (stopping) void shutdown();
      },
      (error) => {
        port.postMessage({ type: "error", task: "Dashboard processor startup", error: formatFailure(error) });
        if (stopping) void shutdown();
      },
    );
  } catch (error) {
    port.postMessage({ type: "error", task: "Worker initialization", error: formatFailure(error) });
    await shutdown();
  }
}

void start();
