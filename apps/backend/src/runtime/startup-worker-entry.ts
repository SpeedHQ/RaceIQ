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

port.on("message", (message: { type: "stop" }) => {
  if (message.type !== "stop") return;
  stopping = true;
  if (processor) void shutdown();
});

async function shutdown(): Promise<void> {
  await Promise.allSettled([processor?.stop(), ...backgroundTasks]);
  setDashboardPublicationNotifier(null);
  await client.close();
  port.postMessage({ type: "stopped" });
  port.close();
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

async function runTask(name: string, task: () => Promise<unknown>): Promise<void> {
  try {
    await task();
  } catch (error) {
    port.postMessage({ type: "error", task: name, error: formatFailure(error) });
  }
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
      await runTask("Historical session reconciliation", async () => {
        const counts = await reconcileHistoricalSessions((reprocessed) => {
          port.postMessage({ type: "lap-reprocessed", reprocessed });
        });
        console.log("[SessionRepair] Historical session reconciliation complete:", counts);
        if (counts.failed === 0 && await countStaleSessions(
          ALL_DETECTOR_IDS,
          getAllServerGames().map((adapter) => adapter.id),
        ) === 0) port.postMessage({ type: "clear-stale-sessions" });
        await deleteEmptySessions();
      });
      await runTask("LMU session identity backfill", async () => {
        const counts = await backfillLMUSessionIdentity();
        console.log("[LMU] Session identity backfill complete:", counts);
      });
      await runTask("Race-result backfill", backfillAllRaceResults);
    })()];
    void backgroundTasks[0].then(() => {
      if (stopping) void shutdown();
      else processor = startDashboardProcessor();
    });
  } catch (error) {
    port.postMessage({ type: "error", task: "Worker initialization", error: formatFailure(error) });
    await shutdown();
  }
}

void start();
