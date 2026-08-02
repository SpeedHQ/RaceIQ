import { startCommunityTunesSync } from "../tunes/community-sync";
import { startLaptimesSync } from "../sync/laptimes";
import { countStaleSessions } from "../db/session-queries";
import { LAP_DETECTOR_ID } from "../lap-detection/detector";
import { LAP_DETECTOR_ACC_ID } from "../games/acc/lap-detector";
import { LAP_DETECTOR_AC_EVO_ID } from "../games/ac-evo/lap-detector";
import { LAP_DETECTOR_IRACING_ID } from "../games/iracing/lap-detector";
import { wsManager } from "./websocket-manager";
import { startSessionCompressor } from "../session-capture/compressor";
import { startUpdateCheckSchedule } from "./update/check";

const ALL_DETECTOR_IDS = [
  LAP_DETECTOR_ID,
  LAP_DETECTOR_ACC_ID,
  LAP_DETECTOR_AC_EVO_ID,
  LAP_DETECTOR_IRACING_ID,
];

export function startSyncAndStaleSessionJobs(): void {
  startCommunityTunesSync();
  startLaptimesSync();

  countStaleSessions(ALL_DETECTOR_IDS).then((count) => {
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
}

export function startMaintenanceJobs(): void {
  startSessionCompressor();
  startUpdateCheckSchedule();
}
