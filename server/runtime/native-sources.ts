import { AccSharedMemoryReader } from "../games/acc/shared-memory";
import { AcEvoSharedMemoryReader } from "../games/ac-evo/shared-memory";
import { IRacingTelemetrySource } from "../games/iracing/source";
import { registerLiveIRacingIdentity } from "../games/iracing/identity";
import { LMUTelemetrySource } from "../games/lmu/source";
import { registerLiveLMUIdentity } from "../games/lmu/identity";
import { isGameRunning } from "../games/registry";
import {
  getAccReader,
  getAcEvoReader,
  getIracingSource,
  getLmuSource,
  setAccReader,
  setAcEvoReader,
  setIracingSource,
  setLmuSource,
} from "./live-readers";
import { superviseSource } from "./source-supervisor";
import { IS_WINDOWS } from "./platform/shell";

const SOURCE_POLL_MS = 2000;

export interface NativeSourceSupervisor {
  stop(): Promise<void>;
}

export function startNativeSourceSupervisor(
  recordingGameId: string | null,
): NativeSourceSupervisor {
  if (!IS_WINDOWS) {
    return { stop: async () => {} };
  }

  console.log("[Supervisor] Watching for native telemetry games (acc, ac-evo, iracing, lmu) — 2s poll");
  const pollTimer = setInterval(() => {
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
    superviseSource(
      isGameRunning("lmu"),
      "LMU",
      () => new LMUTelemetrySource({
        recordingEnabled: recordingGameId === "lmu",
        registerIdentity: registerLiveLMUIdentity,
      }),
      getLmuSource,
      setLmuSource,
    );
  }, SOURCE_POLL_MS);

  return {
    async stop(): Promise<void> {
      clearInterval(pollTimer);
      const readers = [
        getAccReader(),
        getAcEvoReader(),
        getIracingSource(),
        getLmuSource(),
      ];
      setAccReader(null);
      setAcEvoReader(null);
      setIracingSource(null);
      setLmuSource(null);
      const stopTasks: Promise<void>[] = [];
      for (const reader of readers) {
        if (reader) stopTasks.push(reader.stop());
      }
      await Promise.allSettled(stopTasks);
    },
  };
}
