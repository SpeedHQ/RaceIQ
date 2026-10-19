import { recoverSessionCaptureSplitJobs } from "@raceiq/backend-core/db/session-queries";
import { startCommunityTunesSync } from "@raceiq/backend-core/tunes/community-sync";
import { countStaleSessions } from "@raceiq/backend-core/db/session-queries";
import { countStaleRaceResults } from "@raceiq/backend-core/db/session-result-queries";
import { RACE_RESULT_PROCESSOR_ID } from "@raceiq/backend-core/race-results/reconcile";
import { LAP_DETECTOR_ID } from "@raceiq/backend-core/lap-detection/detector";
import { LAP_DETECTOR_ACC_ID } from "@raceiq/game-acc/lap-detector";
import { LAP_DETECTOR_AC_EVO_ID } from "@raceiq/game-ac-evo/lap-detector";
import { LAP_DETECTOR_IRACING_ID } from "@raceiq/game-iracing/lap-detector";
import { getAllServerGames } from "@raceiq/backend-core/games/registry";
import { wsManager } from "@raceiq/backend-core/runtime/websocket-manager";
import { startSessionCompressor } from "@raceiq/backend-core/session-capture/compressor";
import { startUpdateCheckSchedule } from "@raceiq/backend-core/runtime/update/check";
import { initializeStartupSplitMigration } from "../session-capture/split-migration";
import { startSessionCaptureSplitManager } from "../session-capture/split-manager";

export const ALL_DETECTOR_IDS = [
  LAP_DETECTOR_ID,
  LAP_DETECTOR_ACC_ID,
  LAP_DETECTOR_AC_EVO_ID,
  LAP_DETECTOR_IRACING_ID,
];

export interface StartupJobDependencies {
  startCommunityTunesSync?: () => void;
  startSessionCompressor?: () => void;
  startUpdateCheckSchedule?: () => void;
  countStaleSessions?: typeof countStaleSessions;
  countStaleRaceResults?: typeof countStaleRaceResults;
  recoverSessionCaptureSplitJobs?: typeof recoverSessionCaptureSplitJobs;
  initializeStartupSplitMigration?: typeof initializeStartupSplitMigration;
  startSessionCaptureSplitManager?: () => void;
}

export async function startSyncAndStaleSessionJobs(dependencies: StartupJobDependencies = {}): Promise<void> {
  (dependencies.startCommunityTunesSync ?? startCommunityTunesSync)();
  try {
    await (dependencies.recoverSessionCaptureSplitJobs ?? recoverSessionCaptureSplitJobs)();
    await (dependencies.initializeStartupSplitMigration ?? initializeStartupSplitMigration)();
    (dependencies.startSessionCaptureSplitManager ?? startSessionCaptureSplitManager)();
  } catch (error) {
    console.error("[CaptureSplit] Startup recovery failed:", error);
  }

  (dependencies.countStaleSessions ?? countStaleSessions)(
    ALL_DETECTOR_IDS,
    getAllServerGames().map((adapter) => adapter.id),
  ).then((count) => {
    if (count > 0) {
      console.log(`[Server] ${count} session(s) recorded with stale lap detector — will prompt user to reprocess`);
      wsManager.setStaleSessionsNotification({
        type: "stale-lap-detection",
        sessionCount: count,
        currentVersion: ALL_DETECTOR_IDS.join(","),
      });
    }
  }).catch((err) => {
    console.error("[Server] Failed to check stale sessions:", err);
  });

  (dependencies.countStaleRaceResults ?? countStaleRaceResults)(RACE_RESULT_PROCESSOR_ID).then((count) => {
    if (count > 0) {
      console.log(`[Server] ${count} session result(s) use an older processor — will prompt user to recalculate`);
      if (process.env.RACEIQ_E2E !== "1") {
        wsManager.setStaleRaceResultsNotification({
          type: "stale-race-results",
          sessionCount: count,
          currentVersion: RACE_RESULT_PROCESSOR_ID,
        });
      }
    }
  }).catch((err) => {
    console.error("[Server] Failed to check stale race results:", err);
  });
}

export function startMaintenanceJobs(): void {
  startSessionCompressor();
  startUpdateCheckSchedule();
}
