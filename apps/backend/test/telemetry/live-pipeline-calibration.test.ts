import type { LapCompleteEvent } from "@raceiq/backend-core/lap-detection/detector";
import { SectorTracker } from "@raceiq/backend-core/live-strategy/sector-tracker";
import { afterAll, describe, expect, spyOn, test } from "bun:test";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import { initGameAdapters } from "@raceiq/game-catalogs/games/init";
import { initServerGameAdapters } from "../../src/games/init";
import { CapturingDbAdapter, CapturingWsAdapter, NullSessionRecorderAdapter } from "@raceiq/backend-core/telemetry/pipeline-ports";
import { LiveTelemetryPipeline, stopMaintenanceTasks } from "@raceiq/backend-core/telemetry/live-pipeline";
import * as calibration from "@raceiq/backend-core/tracks/calibration";

initGameAdapters();
initServerGameAdapters();
afterAll(() => stopMaintenanceTasks());

function packet(gameId: TelemetryPacket["gameId"], distance: number): TelemetryPacket {
  return {
    gameId, IsRaceOn: 1, TimestampMS: 1000, LapNumber: 1, CurrentLap: 30, LastLap: 0,
    BestLap: 0, DistanceTraveled: distance, carId: "100", trackId: "5",
    Speed: 50, PositionX: 10, PositionZ: 20, Brake: 0, Throttle: 1,
  } as unknown as TelemetryPacket;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function pipelineWithSession() {
  const pipeline = new LiveTelemetryPipeline(new CapturingDbAdapter(), new CapturingWsAdapter(), {
    bypassPacketRateFilter: true, skipHistorySeeding: true, skipDevState: true,
    recorder: new NullSessionRecorderAdapter(),
  });
  const detector = {
    session: { sessionId: 77, trackId: "5", gameId: "fm-2023" },
    feed: async () => {},
  };
  const sectorTracker = {
    feed: () => null,
    getTrackLength: () => 1000,
    getLapDistStart: () => 0,
  };
  const seams = pipeline as unknown as {
    _getOrCreateDetector: () => typeof detector;
    sectorTracker: typeof sectorTracker;
  };
  seams._getOrCreateDetector = () => detector;
  seams.sectorTracker = sectorTracker;
  return pipeline;
}

describe("LiveTelemetryPipeline track calibration integration", () => {
  test("derives normalized progress from distance modulo track length on every sixth packet", async () => {
    const feed = spyOn(calibration, "feedCalibrationPosition").mockImplementation(() => {});
    try {
      const pipeline = pipelineWithSession();
      for (let i = 0; i < 6; i++) await pipeline.processPacket(packet("fm-2023", i === 5 ? 1250 : 100));
      expect(feed).toHaveBeenCalledTimes(1);
      expect(feed.mock.calls[0]?.[4]).toBe(0.25);
    } finally {
      feed.mockRestore();
    }
  });

  test("does not sample calibration for adapters without requiresTrackCalibration", async () => {
    const feed = spyOn(calibration, "feedCalibrationPosition").mockImplementation(() => {});
    try {
      const pipeline = pipelineWithSession();
      for (let i = 0; i < 6; i++) await pipeline.processPacket(packet("acc", 1250));
      expect(feed).not.toHaveBeenCalled();
    } finally {
      feed.mockRestore();
    }
  });
});
describe("LiveTelemetryPipeline pace reference integration", () => {
  test("non-pace laps do not seed references or sector bests, while valid-lap wear remains independent", () => {
    const pipeline = new LiveTelemetryPipeline(new CapturingDbAdapter(), new CapturingWsAdapter(), {
      skipHistorySeeding: true,
      skipDevState: true,
      recorder: new NullSessionRecorderAdapter(),
    });
    const tracker = new SectorTracker();
    tracker._initForTest({ s1End: 300, s2End: 700, trackLength: 1000 });
    const wearUpdates: unknown[][] = [];
    const seams = pipeline as unknown as {
      sectorTracker: SectorTracker;
      pitTracker: { updateWearCurves: (...args: unknown[]) => void };
      _lapDetector: { session: { gameId: "acc" } };
      _buildCallbacks: () => { onLapComplete: (event: LapCompleteEvent) => void };
    };
    seams.sectorTracker = tracker;
    seams.pitTracker = { updateWearCurves: (...args) => wearUpdates.push(args) };
    seams._lapDetector = { session: { gameId: "acc" } };
    const completeLap = seams._buildCallbacks().onLapComplete;
    const packets = [0, 1, 2].map((index) => ({
      gameId: "acc",
      DistanceTraveled: index * 500,
      CurrentLap: index * 30,
    }) as TelemetryPacket);

    completeLap({
      packets,
      lapDistStart: 0,
      lapTime: 70,
      isValid: true,
      classification: "in_lap",
      sectors: [20, 20, 30],
    });
    expect(tracker.getDebugState()).toMatchObject({
      bestLapTime: Infinity,
      bestTimes: [Infinity, Infinity, Infinity],
      refLapTime: null,
    });
    expect(wearUpdates).toHaveLength(1);

    completeLap({
      packets,
      lapDistStart: 0,
      lapTime: 90,
      isValid: true,
      classification: "pace",
      sectors: [30, 30, 30],
    });
    expect(tracker.getDebugState()).toMatchObject({
      bestLapTime: 90,
      bestTimes: [30, 30, 30],
      refLapTime: 90,
    });
    expect(wearUpdates).toHaveLength(2);
  });
});
describe("LiveTelemetryPipeline deleted-session recovery", () => {
  test("creates a fresh session from next packet when active session is deleted", async () => {
    const db = new CapturingDbAdapter();
    const pipeline = new LiveTelemetryPipeline(db, new CapturingWsAdapter(), {
      bypassPacketRateFilter: true,
      skipHistorySeeding: true,
      skipDevState: true,
      recorder: new NullSessionRecorderAdapter(),
    });

    await pipeline.processPacket(packet("acc", 100));
    expect(db.sessions).toHaveLength(1);
    expect(await pipeline.recoverDeletedSessions([1])).toBe(true);

    await pipeline.processPacket(packet("acc", 101));
    expect(db.sessions).toHaveLength(2);
    expect(pipeline.lapDetector?.session?.sessionId).toBe(2);
  });

  test("waits for in-flight telemetry before dropping deleted session ownership", async () => {
    const db = new CapturingDbAdapter();
    const pipeline = new LiveTelemetryPipeline(db, new CapturingWsAdapter(), {
      bypassPacketRateFilter: true,
      skipHistorySeeding: true,
      skipDevState: true,
      recorder: new NullSessionRecorderAdapter(),
    });
    await pipeline.processPacket(packet("acc", 100));

    const detector = pipeline.lapDetector!;
    const originalFeed = detector.feed.bind(detector);
    const feedStarted = deferred();
    const releaseFeed = deferred();
    detector.feed = async (nextPacket, rawByteOffset) => {
      feedStarted.resolve();
      await releaseFeed.promise;
      await originalFeed(nextPacket, rawByteOffset);
    };

    const inFlight = pipeline.processPacket(packet("acc", 101));
    await feedStarted.promise;
    let recovered = false;
    const recovery = pipeline.recoverDeletedSessions([1]).then((result) => {
      recovered = result;
    });
    await Promise.resolve();
    expect(recovered).toBe(false);

    releaseFeed.resolve();
    await Promise.all([inFlight, recovery]);
    expect(recovered).toBe(true);

    await pipeline.processPacket(packet("acc", 102));
    expect(pipeline.lapDetector?.session?.sessionId).toBe(2);
  });

  test("waits for active finalization before recovering a deleted session", async () => {
    const pipeline = new LiveTelemetryPipeline(
      new CapturingDbAdapter(),
      new CapturingWsAdapter(),
      {
        bypassPacketRateFilter: true,
        skipHistorySeeding: true,
        skipDevState: true,
        recorder: new NullSessionRecorderAdapter(),
      },
    );
    await pipeline.processPacket(packet("acc", 100));

    const finalizationStarted = deferred();
    const releaseFinalization = deferred();
    pipeline.lapDetector!.finalizeCurrentSession = async () => {
      finalizationStarted.resolve();
      await releaseFinalization.promise;
    };

    const finalization = pipeline.finalizeCurrentSession();
    await finalizationStarted.promise;
    let recovered = false;
    const recovery = pipeline.recoverDeletedSessions([1]).then((result) => {
      recovered = result;
    });
    await Promise.resolve();
    expect(recovered).toBe(false);

    releaseFinalization.resolve();
    await Promise.all([finalization, recovery]);
    expect(recovered).toBe(true);
  });
});
