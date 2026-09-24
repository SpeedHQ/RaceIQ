import { describe, expect, spyOn, test, vi } from "bun:test";
import type { AccSharedMemoryReader } from "../../server/games/acc/shared-memory";
import type { LMUTelemetrySource } from "../../server/games/lmu/source";
import * as registry from "../../server/games/registry";
import {
  getAccReader,
  getAcEvoReader,
  getIracingSource,
  getLmuSource,
  setAccReader,
  setAcEvoReader,
  setIracingSource,
  setLmuSource,
} from "../../server/runtime/live-readers";
import { startNativeSourceSupervisor, type NativeSourceSupervisor } from "../../server/runtime/native-sources";
import { IS_WINDOWS } from "../../server/runtime/platform/shell";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("native source shutdown", () => {
  test.skipIf(!IS_WINDOWS)("waits for detached and currently attached sources before recorder finalization", async () => {
    const previous = [getAccReader(), getAcEvoReader(), getIracingSource(), getLmuSource()] as const;
    const detachedDrain = deferred();
    const attachedDrain = deferred();
    let detachedStops = 0;
    let attachedStops = 0;
    vi.useFakeTimers();
    const running = spyOn(registry, "isGameRunning").mockReturnValue(false);
    let supervisor: NativeSourceSupervisor | undefined;
    let shutdown: Promise<void> | undefined;

    try {
      setAccReader(null);
      setAcEvoReader(null);
      setIracingSource(null);
      setLmuSource({
        stop() {
          detachedStops++;
          return detachedDrain.promise;
        },
      } as unknown as LMUTelemetrySource);
      supervisor = startNativeSourceSupervisor(null);
      vi.advanceTimersByTime(2_000);
      expect(getLmuSource()).toBeNull();
      expect(detachedStops).toBe(1);

      setAccReader({
        stop() {
          attachedStops++;
          return attachedDrain.promise;
        },
      } as unknown as AccSharedMemoryReader);
      let recorderFinalized = false;
      shutdown = supervisor.stop().then(() => { recorderFinalized = true; });
      expect(getAccReader()).toBeNull();
      expect(attachedStops).toBe(1);
      vi.useRealTimers();

      attachedDrain.resolve();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(recorderFinalized).toBe(false);

      detachedDrain.resolve();
      await shutdown;
      expect(recorderFinalized).toBe(true);
      expect(detachedStops).toBe(1);
    } finally {
      running.mockRestore();
      vi.useRealTimers();
      detachedDrain.resolve();
      attachedDrain.resolve();
      await shutdown;
      await supervisor?.stop();
      setAccReader(previous[0]);
      setAcEvoReader(previous[1]);
      setIracingSource(previous[2]);
      setLmuSource(previous[3]);
    }
  });
});
