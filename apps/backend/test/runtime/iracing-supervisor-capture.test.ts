import { expect, mock, spyOn, vi } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeDatabaseTest } from "../support/native-database-test";
import { IRacingCaptureManager } from "../../src/runtime/iracing-capture";
import { IRacingTelemetrySource } from "@raceiq/game-iracing/source";
import * as shell from "@raceiq/backend-core/runtime/platform/shell";
import * as registry from "@raceiq/backend-core/games/registry";
import type { NativeSourceSupervisor } from "../../src/runtime/native-sources";
import { getIracingSource } from "../../src/runtime/live-readers";

const test = nativeDatabaseTest(import.meta.path);

for (const scenario of ["opted-in", "disabled", "user-owned", "dump-only"] as const) {
  test(`supervised iRacing snapshots: ${scenario}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "raceiq-supervisor-"));
    const sourceDir = join(root, "source");
    await mkdir(sourceDir);
    // Load the supervisor after replacing the platform and source boundaries.
    const RealSource = IRacingTelemetrySource;
    const platform = { ...shell };
    const CaptureManager = IRacingCaptureManager;
    const commands: boolean[] = [];
    const dispatched: number[] = [];
    const manager = new IRacingCaptureManager({
      availability: () => null,
      resolveDirectory: () => sourceDir,
      archiveDirectory: join(root, "archive"),
      setLogging: (enabled) => commands.push(enabled),
      pollIntervalMs: 0,
      shutdownFlushMs: 0,
    });
    const observe = spyOn(manager, "observe");
    let frameAvailable = false;
    const snapshot = {
      tick: 1,
      sessionInfoUpdate: 1,
      sessionInfo: "WeekendInfo:\n  TrackID: 99\nDriverInfo:\n  DriverCarIdx: 0\n",
      values: { SessionNum: 0, IsDiskLoggingEnabled: scenario === "user-owned", IsDiskLoggingActive: scenario === "user-owned" },
    };
    mock.module("@raceiq/backend-core/runtime/platform/shell", () => ({ ...platform, IS_WINDOWS: true }));
    mock.module("../../src/runtime/iracing-capture", () => ({ IRacingCaptureManager: CaptureManager, iracingCaptureManager: manager }));
    mock.module("@raceiq/game-iracing/source", () => ({
      IRacingTelemetrySource: class extends RealSource {
        constructor(options: ConstructorParameters<typeof IRacingTelemetrySource>[0]) {
          super({ ...options, reader: {
            start() {}, async stop() {},
            readLatest() { return frameAvailable ? snapshot : null; },
          }, dispatchRawFrame: async (_raw, timestamp) => { dispatched.push(timestamp!); } });
        }
      },
    }));
    const running = spyOn(registry, "isGameRunning").mockImplementation((game) => game === "iracing");
    const previousE2e = process.env.RACEIQ_E2E;
    delete process.env.RACEIQ_E2E;
    vi.useFakeTimers();
    const { startNativeSourceSupervisor } = await import("../../src/runtime/native-sources");
    let supervisor: NativeSourceSupervisor | undefined;
    try {
      if (scenario !== "disabled") await manager.connect(true);
      supervisor = startNativeSourceSupervisor(null, scenario === "dump-only");
      vi.advanceTimersByTime(2000);
      const source = getIracingSource();
      expect(source).not.toBeNull();
      expect(await source!.pollOnce()).toBe(false);
      await manager.tick();
      expect(commands).toEqual([]);
      if (scenario !== "disabled") expect(manager.status().state).toBe("waiting-for-iracing");
      frameAvailable = true;
      expect(await source!.pollOnce()).toBe(true);
      expect(dispatched).toHaveLength(1);
      await manager.tick();
      if (scenario === "dump-only") {
        expect(observe).not.toHaveBeenCalled();
        expect(manager.status().state).toBe("waiting-for-iracing");
      } else {
        expect(observe).toHaveBeenCalledWith(snapshot, dispatched[0]);
        expect(manager.status().state).toBe(scenario === "disabled" ? "disconnected" : scenario === "user-owned" ? "recording" : "waiting-for-recording");
      }
      expect(commands).toEqual(scenario === "opted-in" ? [true] : []);
      await supervisor.stop();
      supervisor = undefined;
      expect(commands).toEqual(scenario === "opted-in" ? [true, false] : []);
    } finally {
      if (supervisor) await supervisor.stop();
      vi.useRealTimers();
      running.mockRestore();
      observe.mockRestore();
      mock.restore();
      if (previousE2e === undefined) delete process.env.RACEIQ_E2E;
      else process.env.RACEIQ_E2E = previousE2e;
      await rm(root, { recursive: true, force: true });
    }
  });
}
