import { parentPort } from "node:worker_threads";
import { initGameAdapters } from "@raceiq/game-catalogs/games/init";
import { serverReleaseFeatures } from "@raceiq/backend-core/runtime/config/release-features";
import { initServerGameAdapters } from "../games/init";
import { initDb, client } from "@raceiq/backend-core/db/index";
import { backfillAllRaceResults } from "@raceiq/backend-core/race-results/reconcile";
import { backfillLMUSessionIdentity } from "../imports/lmu-session-identity-backfill";
import { startDashboardProcessor, type DashboardProcessorHandle } from "@raceiq/backend-core/session-capture/dashboard-processor";
import { setDashboardPublicationNotifier } from "@raceiq/backend-core/db/dashboard-summary-queries";
import { initMotecTargets } from "../games/motec-init";
import { reconcileHistoricalSessions } from "@raceiq/backend-core/session-capture/reconcile";
import { ALL_DETECTOR_IDS } from "./startup-jobs";
import { getAllServerGames } from "@raceiq/backend-core/games/registry";
import { countStaleSessions, deleteEmptySessions } from "@raceiq/backend-core/db/session-queries";
import { hydrateDiscoveredAcEvoCars, listDiscoveredCars } from "@raceiq/backend-core/db/discovered-cars";
import { hydrateDiscoveredAcEvoTracks, listDiscoveredTracks } from "@raceiq/backend-core/db/discovered-tracks";
import { injectDiscoveredIRacingIdentity } from "@raceiq/game-iracing-metadata/index";
import { injectDiscoveredLMUIdentity } from "@raceiq/game-lmu-metadata/index";

const port = parentPort!;
let stopping = false;
let backgroundTasks: Promise<void>[] = [];
let processor: DashboardProcessorHandle | null = null;
let startupTaskSettled = false;
let shutdownPromise: Promise<void> | null = null;

port.on("message", (message: { type: "stop" }) => {
  if (message.type !== "stop") return;
  stopping = true;
  if (processor || startupTaskSettled) void shutdown();
});

function shutdown(): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    await Promise.allSettled([processor?.stop(), ...backgroundTasks]);
    setDashboardPublicationNotifier(null);
    await client.close();
    port.postMessage({ type: "stopped" });
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

interface StartupStageResult {
  complete: boolean;
  reason?: string;
}

interface StartupStage {
  name: string;
  run(): Promise<StartupStageResult>;
}

const startupStages: StartupStage[] = [
  {
    name: "Historical session reconciliation",
    async run() {
      const counts = await reconcileHistoricalSessions((reprocessed) => {
        port.postMessage({ type: "lap-reprocessed", reprocessed });
      });
      if (counts.failed || counts.missingCapture) {
        console.log("[SessionRepair] Historical session reconciliation incomplete:", counts);
        return { complete: false, reason: `failed=${counts.failed}, missingCapture=${counts.missingCapture}` };
      }
      if (await countStaleSessions(
        ALL_DETECTOR_IDS,
        getAllServerGames().map((adapter) => adapter.id),
      ) !== 0) return { complete: false, reason: "stale sessions remain" };
      await deleteEmptySessions();
      port.postMessage({ type: "clear-stale-sessions" });
      console.log("[SessionRepair] Historical session reconciliation complete:", counts);
      return { complete: true };
    },
  },
  {
    name: "LMU session identity backfill",
    async run() {
      const counts = await backfillLMUSessionIdentity();
      console.log("[LMU] Session identity backfill result:", counts);
      if (counts.unresolved) {
        return { complete: false, reason: `unresolved=${counts.unresolved}` };
      }
      console.log("[LMU] Session identity backfill complete:", counts);
      return { complete: true };
    },
  },
  {
    name: "Race-result backfill",
    async run() {
      const counts = await backfillAllRaceResults();
      const result = counts.errors || counts.failedGames.length
        ? {
            complete: false,
            reason: `errors=${counts.errors}, failedGames=${counts.failedGames.map(({ gameId, error }) => `${gameId}: ${error}`).join("; ") || "none"}`,
          }
        : { complete: true };
      console.log(`[RaceResults] Backfill ${result.complete ? "complete" : "incomplete"}:`, counts);
      return result;
    },
  },
];

async function reconcileStartup(): Promise<boolean> {
  for (const stage of startupStages) {
    if (stopping) return false;
    let result: StartupStageResult;
    try {
      result = await stage.run();
    } catch (error) {
      port.postMessage({ type: "error", task: stage.name, error: formatFailure(error) });
      return false;
    }
    if (!result.complete) {
      port.postMessage({
        type: "error",
        task: stage.name,
        error: `Startup reconciliation incomplete: ${result.reason ?? "unspecified reason"}`,
      });
      return false;
    }
  }
  return true;
}

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
    if (stopping) {
      await shutdown();
      return;
    }
    setDashboardPublicationNotifier(() => port.postMessage({ type: "publication" }));
    port.postMessage({ type: "ready" });

    backgroundTasks = [(async () => {
      const complete = await reconcileStartup();
      if (!stopping && complete) {
        console.log("[StartupWorker] Starting dashboard processor");
        processor = startDashboardProcessor();
      }
    })()];
    void backgroundTasks[0].then(
      () => {
        startupTaskSettled = true;
        if (stopping) void shutdown();
      },
      (error) => {
        startupTaskSettled = true;
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
