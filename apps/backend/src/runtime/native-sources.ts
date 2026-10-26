import { serverReleaseFeatures } from "@raceiq/backend-core/runtime/config/release-features";
import { AccSharedMemoryReader } from "@raceiq/game-acc/shared-memory";
import { AcEvoSharedMemoryReader } from "@raceiq/game-ac-evo/shared-memory";
import { IRacingTelemetrySource } from "@raceiq/game-iracing/source";
import { registerLiveIRacingIdentity } from "@raceiq/game-iracing/identity";
import { AMS2TelemetrySource } from "@raceiq/game-ams2/source";
import { LMUTelemetrySource } from "@raceiq/game-lmu/source";
import { isGameRunning } from "@raceiq/backend-core/games/registry";
import {
  getAccReader,
  getAcEvoReader,
  getIracingSource,
  getLmuSource,
  getAms2Source,
  setAms2Source,
  setAccReader,
  setAcEvoReader,
  setIracingSource,
  setLmuSource,
} from "./live-readers";
import { superviseSource } from "@raceiq/backend-core/runtime/source-supervisor";
import { IS_WINDOWS } from "@raceiq/backend-core/runtime/platform/shell";

const SOURCE_POLL_MS = 2000;

export interface NativeSourceSupervisor {
  stop(): Promise<void>;
}

export function startNativeSourceSupervisor(
  recordingGameId: string | null,
  dumpMode = false,
): NativeSourceSupervisor {
  if (!IS_WINDOWS) {
    return { stop: async () => {} };
  }

  const pendingStops = new Set<Promise<void>>();
  const trackStop = (stop: Promise<void> | null): void => {
    if (!stop) return;
    pendingStops.add(stop);
    void stop.then(
      () => pendingStops.delete(stop),
      () => pendingStops.delete(stop),
    );
  };

  console.log(`[Supervisor] Watching for native telemetry games (acc, ac-evo, iracing, lmu${serverReleaseFeatures.ams2Adapter ? ", ams2" : ""}) — 2s poll`);
  const pollTimer = setInterval(() => {
    trackStop(superviseSource(
      isGameRunning("acc") || (dumpMode && recordingGameId === "acc"),
      "ACC",
      () => new AccSharedMemoryReader(recordingGameId === "acc"),
      getAccReader,
      setAccReader,
    ));
    trackStop(superviseSource(
      isGameRunning("ac-evo") || (dumpMode && recordingGameId === "ac-evo"),
      "AC Evo",
      () => new AcEvoSharedMemoryReader(recordingGameId === "ac-evo"),
      getAcEvoReader,
      setAcEvoReader,
    ));
    trackStop(superviseSource(
      isGameRunning("iracing") || (dumpMode && recordingGameId === "iracing"),
      "iRacing",
      () => new IRacingTelemetrySource({
        recordingEnabled: recordingGameId === "iracing",
        registerIdentity: dumpMode ? undefined : registerLiveIRacingIdentity,
      }),
      getIracingSource,
      setIracingSource,
    ));
    trackStop(superviseSource(
      serverReleaseFeatures.ams2Adapter && (isGameRunning("ams2") || recordingGameId === "ams2"), "AMS2",
      () => new AMS2TelemetrySource({ recordingEnabled: recordingGameId === "ams2" }),
      getAms2Source, setAms2Source,
    ));
    trackStop(superviseSource(
      isGameRunning("lmu") || recordingGameId === "lmu",
      recordingGameId === "lmu" && !isGameRunning("lmu") ? "LMU recording" : "LMU",
      () => new LMUTelemetrySource({
        recordingEnabled: recordingGameId === "lmu",
      }),
      getLmuSource,
      setLmuSource,
    ));
  }, SOURCE_POLL_MS);

  return {
    async stop(): Promise<void> {
      clearInterval(pollTimer);
      const readers = [
        getAccReader(),
        getAcEvoReader(),
        getIracingSource(),
        getLmuSource(),
        getAms2Source(),
      ];
      setAccReader(null);
      setAcEvoReader(null);
      setIracingSource(null);
      setLmuSource(null);
      setAms2Source(null);
      const stopped = await Promise.allSettled([
        ...pendingStops,
        ...readers.filter(reader => reader !== null).map(async reader => { await reader.stop(); }),
      ]);
      const failures = stopped.filter(result => result.status === "rejected").map(result => result.reason);
      if (failures.length) throw new AggregateError(failures, "Native source finalization failed");
    },
  };
}
