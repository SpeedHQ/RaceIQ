import { afterAll, describe, expect, test } from "bun:test";
import { RaceEventsAppendedMessageSchema } from "../../shared/racing/events/contracts";
import { initGameAdapters } from "../../shared/games/init";
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
});
