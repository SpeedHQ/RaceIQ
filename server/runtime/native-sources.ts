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

const SOURCE_POLL_MS = 2000;

export interface NativeSourceSupervisor {
  stop(): Promise<void>;
}

export function startNativeSourceSupervisor(
  recordingGameId: string | null,
): NativeSourceSupervisor {
  if (process.platform !== "win32") {
    return { stop: async () => {} };
  }

  console.log("[Supervisor] Watching for native telemetry games (acc, ac-evo, iracing) — 2s poll");
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
  }, SOURCE_POLL_MS);

  return {
    async stop(): Promise<void> {
      clearInterval(pollTimer);
      const readers = [getAccReader(), getAcEvoReader(), getIracingSource()];
      setAccReader(null);
      setAcEvoReader(null);
      setIracingSource(null);
      const stopTasks: Promise<void>[] = [];
      for (const reader of readers) {
        if (reader) stopTasks.push(reader.stop());
      }
      await Promise.allSettled(stopTasks);
    },
  };
}
