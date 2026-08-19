import { afterAll, describe, expect, test } from "bun:test";

import { SessionRunsCompletedMessageSchema } from "../../shared/racing/runs/contracts";
import { initGameAdapters } from "../../shared/games/init";
import type { TelemetryPacket } from "../../shared/telemetry/types";
import { initServerGameAdapters } from "../../server/games/init";
import { MemoryRaceEventStore } from "../../server/race-events/store";
import {
  CapturingDbAdapter,
  CapturingWsAdapter,
  NullSessionRecorderAdapter,
  type SessionRunPublisher,
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

function pipeline(store: MemoryRaceEventStore, ws = new CapturingWsAdapter()) {
  return {
    ws,
    value: new LiveTelemetryPipeline(new CapturingDbAdapter(), ws, {
      bypassPacketRateFilter: true,
      skipHistorySeeding: true,
      skipDevState: true,
      recorder: new NullSessionRecorderAdapter(),
      raceEventStore: store,
    }),
  };
}

describe("live session run integration", () => {
  test("commits lap metadata and final incomplete runs before publication", async () => {
    const store = new MemoryRaceEventStore();
    const live = pipeline(store);
    await live.value.processPacket(packet());
    await live.value.processPacket(
      packet({
        TimestampMS: 2_000,
        LapNumber: 2,
        CurrentLap: 0.1,
        LastLap: 90,
        DistanceTraveled: 5_000,
      }),
    );
    expect(live.value.openSessionRuns).toHaveLength(4);

    await live.value.finalizeCurrentSession();

    const runs = store.listSessionRuns();
    expect(runs).toHaveLength(4);
    expect(runs.every(({ status }) => status === "incomplete")).toBe(true);
    expect(runs.every(({ summary }) => summary.completedLapCount === 1)).toBe(
      true,
    );
    expect(store.listSessionRunMemberships()).toHaveLength(4);
    const messages = live.ws.broadcastedNotifications
      .filter(({ type }) => type === "session-runs-completed")
      .map((message) => SessionRunsCompletedMessageSchema.parse(message));
    expect(
      messages
        .at(-1)
        ?.runs.map(({ runId }) => runId)
        .sort(),
    ).toEqual(runs.map(({ runId }) => runId).sort());
  });

  test("store failure advances neither run builder nor run publication", async () => {
    class FailingStore extends MemoryRaceEventStore {
      override appendWithSessionRunUpdate(): Promise<never> {
        return Promise.reject(new Error("run-store-failed"));
      }
    }
    const store = new FailingStore();
    const live = pipeline(store);

    await expect(live.value.processPacket(packet())).rejects.toThrow(
      "Failed to persist race events",
    );
    expect(live.value.openSessionRuns).toHaveLength(0);
    expect(store.listSessionRuns()).toHaveLength(0);
    expect(
      live.ws.broadcastedNotifications.filter(
        ({ type }) => type === "session-runs-completed",
      ),
    ).toHaveLength(0);
  });

  test("publisher failure happens after durable store and builder commit", async () => {
    const store = new MemoryRaceEventStore();
    const ws = new CapturingWsAdapter();
    const publisher: SessionRunPublisher = {
      publishCompleted() {
        throw new Error("run-publisher-failed");
      },
      publishReplaced() {},
    };
    const live = new LiveTelemetryPipeline(new CapturingDbAdapter(), ws, {
      bypassPacketRateFilter: true,
      skipHistorySeeding: true,
      skipDevState: true,
      recorder: new NullSessionRecorderAdapter(),
      raceEventStore: store,
      sessionRunPublisher: publisher,
    });
    await live.processPacket(packet());
    await live.processPacket(
      packet({
        TimestampMS: 2_000,
        LapNumber: 2,
        CurrentLap: 0.1,
        LastLap: 90,
        DistanceTraveled: 5_000,
      }),
    );

    await expect(live.finalizeCurrentSession()).rejects.toThrow(
      "run-publisher-failed",
    );
    expect(store.listSessionRuns()).toHaveLength(4);
    expect(live.openSessionRuns).toHaveLength(0);
  });
});
