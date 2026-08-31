import { accBroadcastClient } from "../games/acc/broadcast-client";
import { AccSharedMemoryReader } from "../games/acc/shared-memory";
import { AcEvoSharedMemoryReader } from "../games/ac-evo/shared-memory";
import { IRacingTelemetrySource } from "../games/iracing/source";
import { registerLiveIRacingIdentity } from "../games/iracing/identity";
import { isGameRunning } from "../games/registry";
import {
  getAccReader,
  getAcEvoReader,
  getIracingSource,
  setAccReader,
  setAcEvoReader,
  setIracingSource,
} from "./live-readers";
import { superviseSource } from "./source-supervisor";
import { IS_WINDOWS } from "./platform/shell";

import { isLiveSpotterEngineerEnabled, releaseFeatureFlags } from "../../shared/platform/runtime/release-feature-flags";

const SOURCE_POLL_MS = 2000;

export interface NativeSourceSupervisor {
  stop(): Promise<void>;
}

export function startNativeSourceSupervisor(
  recordingGameId: string | null,
): NativeSourceSupervisor {
  const liveSpotterEngineerEnabled = isLiveSpotterEngineerEnabled(releaseFeatureFlags({
    RACEIQ_FEATURE_F1_EXPERIMENTS: process.env.RACEIQ_FEATURE_F1_EXPERIMENTS,
    RACEIQ_FEATURE_IRACING_ADAPTER: process.env.RACEIQ_FEATURE_IRACING_ADAPTER,
    RACEIQ_FEATURE_LIVE_SPOTTER_ENGINEER: process.env.RACEIQ_FEATURE_LIVE_SPOTTER_ENGINEER,
    RACEIQ_FEATURE_LIVE_SPOTTER_ENGINEER_GAME_IDS: process.env.RACEIQ_FEATURE_LIVE_SPOTTER_ENGINEER_GAME_IDS,
  }), "acc");
  if (!IS_WINDOWS) return { stop: async () => {} };
  console.log("[Supervisor] Watching for native telemetry games (acc, ac-evo, iracing) — 2s poll");
  let wasAccRunning = false;
  const pollTimer = setInterval(() => {
    const accRunning = isGameRunning("acc");
    if (liveSpotterEngineerEnabled && accRunning) void accBroadcastClient.start().catch((error) => console.error("[ACC Broadcast] Start failed:", error));
    else if (liveSpotterEngineerEnabled && wasAccRunning) void accBroadcastClient.stop().catch((error) => console.error("[ACC Broadcast] Stop failed:", error));
    wasAccRunning = accRunning;
    superviseSource(
      isGameRunning("acc"),
      "ACC",
      () => new AccSharedMemoryReader(recordingGameId === "acc"),
      getAccReader,
      setAccReader,
    );
    superviseSource(
      isGameRunning("ac-evo"),
      "AC Evo",
      () => new AcEvoSharedMemoryReader(recordingGameId === "ac-evo"),
      getAcEvoReader,
      setAcEvoReader,
    );
    superviseSource(
      isGameRunning("iracing"),
      "iRacing",
      () => new IRacingTelemetrySource({
        recordingEnabled: recordingGameId === "iracing",
        registerIdentity: registerLiveIRacingIdentity,
      }),
      getIracingSource,
      setIracingSource,
    );
  }, SOURCE_POLL_MS);

  return {
    async stop(): Promise<void> {
      clearInterval(pollTimer);
      const readers = [getAccReader(), getAcEvoReader(), getIracingSource()];
      setAccReader(null);
      setAcEvoReader(null);
      setIracingSource(null);
      const stopTasks: Promise<void>[] = liveSpotterEngineerEnabled ? [accBroadcastClient.stop()] : [];
      for (const reader of readers) {
        if (reader) stopTasks.push(reader.stop());
      }
      await Promise.allSettled(stopTasks);
    },
  };
}
