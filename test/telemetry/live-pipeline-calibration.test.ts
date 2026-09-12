import { afterAll, describe, expect, spyOn, test } from "bun:test";
import type { TelemetryPacket } from "../../shared/telemetry/types";
import { initGameAdapters } from "../../shared/games/init";
import { initServerGameAdapters } from "../../server/games/init";
import { CapturingDbAdapter, CapturingWsAdapter, NullSessionRecorderAdapter } from "../../server/telemetry/pipeline-ports";
import { LiveTelemetryPipeline, stopMaintenanceTasks } from "../../server/telemetry/live-pipeline";
import * as calibration from "../../server/tracks/calibration";

initGameAdapters();
initServerGameAdapters();
afterAll(() => stopMaintenanceTasks());

function packet(gameId: TelemetryPacket["gameId"], distance: number): TelemetryPacket {
  return {
    gameId, IsRaceOn: 1, TimestampMS: 1000, LapNumber: 1, CurrentLap: 30, LastLap: 0,
    BestLap: 0, DistanceTraveled: distance, CarOrdinal: 100, TrackOrdinal: 5,
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
    session: { sessionId: 77, trackOrdinal: 5, gameId: "fm-2023" },
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
});
