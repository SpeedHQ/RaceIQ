import { describe, expect, test } from "bun:test";
import { LapDetector } from "../../../server/lap-detection/detector";
import { CapturingDbAdapter } from "../../../server/telemetry/pipeline-ports";
import type { TelemetryPacket } from "../../../shared/telemetry/types";

function packet(timestamp: number): TelemetryPacket {
  return {
    gameId: "lmu",
    CarOrdinal: -1,
    TrackOrdinal: -1,
    CarPerformanceIndex: 0,
    CarClass: 0,
    IsRaceOn: 1,
    TimestampMS: timestamp,
    LapNumber: 1,
    CurrentLap: timestamp / 1000,
    LastLap: 0,
    DistanceTraveled: timestamp / 10,
    lmu: {
      carId: "ferrari_499p_2023",
      trackId: "lemans_2023/lemanswec",
    },
  } as TelemetryPacket;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("LapDetector session start", () => {
  test("awaits session initialization before accepting feed and notifies once per session", async () => {
    const started = deferred();
    const ready = deferred();
    const initializedSessions: number[] = [];
    const detector = new LapDetector({
      db: new CapturingDbAdapter(),
      bypassPacketRateFilter: true,
      callbacks: {
        async onSessionStart(session) {
          started.resolve();
          await ready.promise;
          initializedSessions.push(session.sessionId);
        },
      },
    });

    let feedCompleted = false;
    const feed = detector.feed(packet(1000)).then(() => { feedCompleted = true; });
    try {
      expect(await Promise.race([
        started.promise.then(() => "session-started"),
        feed.then(() => "feed-completed"),
      ])).toBe("session-started");
      expect(feedCompleted).toBe(false);
      expect(initializedSessions).toEqual([]);
    } finally {
      ready.resolve();
      await feed;
    }

    const firstSessionId = detector.session!.sessionId;
    expect(initializedSessions).toEqual([firstSessionId]);
    await detector.feed(packet(2000));
    expect(initializedSessions).toEqual([firstSessionId]);

    await detector.finalizeCurrentSession();
    await detector.feed(packet(3000));
    expect(detector.session!.sessionId).not.toBe(firstSessionId);
    expect(initializedSessions).toEqual([firstSessionId, detector.session!.sessionId]);
  });
});
