import { afterAll, describe, expect, test } from "bun:test";
import {
  RaceEventsAppendedMessageSchema,
  type RaceEvent,
} from "../../shared/racing/events/contracts";
import { initGameAdapters } from "../../shared/games/init";
import type { RecordingQualitySummary } from "../../shared/racing/quality/contracts";
import type { TelemetryPacket } from "../../shared/telemetry/types";
import { initServerGameAdapters } from "../../server/games/init";
import { MemoryRaceEventStore } from "../../server/race-events/store";
import {
  CapturingDbAdapter,
  CapturingWsAdapter,
  NullSessionRecorderAdapter,
} from "../../server/telemetry/pipeline-ports";
import {
  LiveTelemetryPipeline,
  stopMaintenanceTasks,
} from "../../server/telemetry/live-pipeline";

initGameAdapters();
initServerGameAdapters();

afterAll(() => stopMaintenanceTasks());

function packet(overrides: Partial<TelemetryPacket> = {}): TelemetryPacket {
  return {
    gameId: "fm-2023",
    IsRaceOn: 1,
    TimestampMS: 1_000,
    LapNumber: 1,
    CurrentLap: 30,
    LastLap: 0,
    BestLap: 0,
    DistanceTraveled: 2_000,
    CarOrdinal: 100,
    TrackOrdinal: 5,
    Speed: 50,
    PositionX: 0,
    PositionZ: 0,
    ...overrides,
  } as TelemetryPacket;
}

class FailOnceRaceEventStore extends MemoryRaceEventStore {
  readonly batches: string[][] = [];
  private failed = false;

  override async append(events: readonly RaceEvent[]) {
    this.batches.push(events.map(({ eventId }) => eventId));
    if (!this.failed) {
      this.failed = true;
      throw new Error("transient append failure");
    }
    return super.append(events);
  }
}

class FailOnceQualityDbAdapter extends CapturingDbAdapter {
  private failed = false;

  override updateSessionQuality(sessionId: number, quality: RecordingQualitySummary) {
    if (!this.failed) {
      this.failed = true;
      return Promise.reject(new Error("transient quality failure"));
    }
    return super.updateSessionQuality(sessionId, quality);
  }
}

describe("live race-event timeline integration", () => {
  test("commits ordered events before publishing their typed append message", async () => {
    const ws = new CapturingWsAdapter();
    const store = new MemoryRaceEventStore();
    const pipeline = new LiveTelemetryPipeline(new CapturingDbAdapter(), ws, {
      bypassPacketRateFilter: true,
      skipHistorySeeding: true,
      skipDevState: true,
      recorder: new NullSessionRecorderAdapter(),
      raceEventStore: store,
    });

    await pipeline.processPacket(packet());

    const messages = ws.broadcastedNotifications
      .filter(({ type }) => type === "race-events-appended")
      .map((message) => RaceEventsAppendedMessageSchema.parse(message));
    expect(messages).toHaveLength(1);
    expect(messages[0]!.events.map(({ eventId }) => eventId)).toEqual(
      store.list().map(({ eventId }) => eventId),
    );
    expect(messages[0]!.events.some(({ eventType }) => eventType === "session_started")).toBe(true);

    await pipeline.finalizeCurrentSession();
  });

  test("suppresses duplicate telemetry from lap and UI processing but records quality evidence", async () => {
    const ws = new CapturingWsAdapter();
    const store = new MemoryRaceEventStore();
    const pipeline = new LiveTelemetryPipeline(new CapturingDbAdapter(), ws, {
      bypassPacketRateFilter: true,
      skipHistorySeeding: true,
      skipDevState: true,
      recorder: new NullSessionRecorderAdapter(),
      raceEventStore: store,
    });
    const samePacket = packet();

    await pipeline.processPacket(samePacket);
    await pipeline.processPacket({ ...samePacket });

    expect(ws.broadcastedPackets).toHaveLength(1);
    expect(store.list().filter(({ eventType }) => eventType === "duplicate_input_suppressed")).toHaveLength(1);

    await pipeline.finalizeCurrentSession();
  });

  test("retries failed event batch before persisting or publishing later events", async () => {
    const ws = new CapturingWsAdapter();
    const store = new FailOnceRaceEventStore();
    const pipeline = new LiveTelemetryPipeline(new CapturingDbAdapter(), ws, {
      bypassPacketRateFilter: true,
      skipHistorySeeding: true,
      skipDevState: true,
      recorder: new NullSessionRecorderAdapter(),
      raceEventStore: store,
    });

    await expect(pipeline.processPacket(packet())).rejects.toThrow("Failed to persist race events");
    expect(ws.broadcastedNotifications.filter(({ type }) => type === "race-events-appended")).toEqual([]);

    await pipeline.processPacket(packet({ TimestampMS: 1_100, CurrentLap: 30.1, DistanceTraveled: 2_010 }));
    await pipeline.noteSourceLifecycle(
      { kind: "timeout", timestampMs: 1_100 },
      { kind: "udp", gameId: "fm-2023", sessionId: 1 },
    );

    expect(store.batches).toHaveLength(3);
    expect(store.batches[1]).toEqual(store.batches[0]);
    expect(ws.broadcastedNotifications.some(({ type }) => type === "race-events-appended")).toBe(true);

    await pipeline.finalizeCurrentSession();
  });

  test("retains closed session finalization after durable failure and retries it", async () => {
    const db = new FailOnceQualityDbAdapter();
    const ws = new CapturingWsAdapter();
    const pipeline = new LiveTelemetryPipeline(db, ws, {
      bypassPacketRateFilter: true,
      skipHistorySeeding: true,
      skipDevState: true,
      recorder: new NullSessionRecorderAdapter(),
      raceEventStore: new MemoryRaceEventStore(),
    });

    await pipeline.processPacket(packet());
    await expect(pipeline.finalizeCurrentSession()).rejects.toThrow("transient quality failure");
    expect(ws.broadcastedNotifications.some(({ type }) => type === "quality-updated")).toBe(false);

    await pipeline.finalizeCurrentSession();

    expect(db.sessionQuality.size).toBe(1);
    expect(ws.broadcastedNotifications.some(({ type }) => type === "quality-updated")).toBe(true);
  });
});
