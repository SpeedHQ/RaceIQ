import { startCommunityTunesSync } from "../community-tunes-sync";
import { startLaptimesSync } from "../laptimes-sync";
import { countStaleSessions } from "../db/session-queries";
import { LAP_DETECTOR_ID } from "../lap-detector";
import { LAP_DETECTOR_V2_ID } from "../lap-detector-acc";
import { LAP_DETECTOR_AC_EVO_ID } from "../lap-detector-ac-evo";
import { LAP_DETECTOR_IRACING_ID } from "../lap-detector-iracing";
import { wsManager } from "../ws";
import { startSessionCompressor } from "../session-capture/compressor";
import { startUpdateCheckSchedule } from "../update-check";

const ALL_DETECTOR_IDS = [
  LAP_DETECTOR_ID,
  LAP_DETECTOR_V2_ID,
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
