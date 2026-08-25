import { afterAll, describe, expect, test } from "bun:test";
import {
  RaceEventsAppendedMessageSchema,
  type RaceEvent,
} from "../../shared/racing/events/contracts";
import { initGameAdapters } from "../../shared/games/init";
import type {
  ArchiveVerification,
  RecordingQualitySummary,
} from "../../shared/racing/quality/contracts";
import type { TelemetryPacket } from "../../shared/telemetry/types";
import { initServerGameAdapters } from "../../server/games/init";
import { compareRaceEvents, MemoryRaceEventStore } from "../../server/race-events/store";
import {
  CapturingDbAdapter,
  CapturingWsAdapter,
  NullSessionRecorderAdapter,
} from "../../server/telemetry/pipeline-ports";
import {
  LiveTelemetryPipeline,
  stopMaintenanceTasks,
} from "../../server/telemetry/live-pipeline";
import type { AnalysisReceiptRow } from "../../server/db/analysis-receipt-queries";

initGameAdapters();
initServerGameAdapters();

afterAll(() => stopMaintenanceTasks());

const TEST_SOURCE_VERIFICATION: ArchiveVerification = {
  state: "verified",
  sourceGeneration: `sha256:${"a".repeat(64)}`,
};

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

class FailSeveralRaceEventStore extends MemoryRaceEventStore {
  readonly batches: string[][] = [];

  constructor(private failures: number) {
    super();
  }

  failNext(count: number): void {
    this.failures = count;
  }

  override async append(events: readonly RaceEvent[]) {
    this.batches.push(events.map(({ eventId }) => eventId));
    if (this.failures > 0) {
      this.failures -= 1;
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

class FailingLapDbAdapter extends CapturingDbAdapter {
  override insertLap(): Promise<number> {
    return Promise.reject(new Error("lap insert failed"));
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
      sourceArchiveVerification: TEST_SOURCE_VERIFICATION,
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
      sourceArchiveVerification: TEST_SOURCE_VERIFICATION,
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
      sourceArchiveVerification: TEST_SOURCE_VERIFICATION,
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

  test("retries post-persist work before appending later timeline batches", async () => {
    const store = new FailSeveralRaceEventStore(0);
    const pipeline = new LiveTelemetryPipeline(new CapturingDbAdapter(), new CapturingWsAdapter(), {
      bypassPacketRateFilter: true,
      skipHistorySeeding: true,
      skipDevState: true,
      recorder: new NullSessionRecorderAdapter(),
      sourceArchiveVerification: TEST_SOURCE_VERIFICATION,
      raceEventStore: store,
    });
    await pipeline.processPacket(packet());
    await pipeline.noteSourceLifecycle(
      { kind: "timeout", timestampMs: 1_050, eventId: "source-timeout:post-persist" },
      { kind: "udp", gameId: "fm-2023", sessionId: 1 },
    );

    const [first, later] = store.list();
    if (!first || !later) throw new Error("Expected initial timeline events");
    const internals = pipeline as unknown as {
      _persistTimelineEventsCore(
        events: readonly RaceEvent[],
        lapLinks?: readonly [],
        afterPersist?: () => Promise<void>,
      ): Promise<RaceEvent[]>;
    };
    let attempts = 0;

    await expect(
      internals._persistTimelineEventsCore([first], [], async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("post-persist failure");
      }),
    ).rejects.toThrow("post-persist failure");
    await internals._persistTimelineEventsCore([later]);

    expect(attempts).toBe(2);
    expect(store.batches.slice(-2).flat()).toEqual([first, later].sort(compareRaceEvents).map(({ eventId }) => eventId));

    await pipeline.finalizeCurrentSession();
  });

  test("retains queued timeline batches when retry persistence fails", async () => {
    const store = new FailSeveralRaceEventStore(0);
    const pipeline = new LiveTelemetryPipeline(new CapturingDbAdapter(), new CapturingWsAdapter(), {
      bypassPacketRateFilter: true,
      skipHistorySeeding: true,
      skipDevState: true,
      recorder: new NullSessionRecorderAdapter(),
      sourceArchiveVerification: TEST_SOURCE_VERIFICATION,
      raceEventStore: store,
    });
    await pipeline.processPacket(packet());
    await pipeline.noteSourceLifecycle(
      { kind: "timeout", timestampMs: 1_050, eventId: "source-timeout:queued-batches" },
      { kind: "udp", gameId: "fm-2023", sessionId: 1 },
    );

    const [first, later] = store.list();
    if (!first || !later) throw new Error("Expected initial timeline events");
    const internals = pipeline as unknown as {
      _persistTimelineEventsCore(events: readonly RaceEvent[]): Promise<RaceEvent[]>;
    };
    store.failNext(1);

    await expect(internals._persistTimelineEventsCore([first])).rejects.toThrow(
      "Failed to persist race events",
    );
    await internals._persistTimelineEventsCore([later]);

    expect(store.batches.slice(-3).flat()).toEqual([
      first.eventId,
      ...[first, later].sort(compareRaceEvents).map(({ eventId }) => eventId),
    ]);

    await pipeline.finalizeCurrentSession();
  });

  test("retains every later timeline batch across repeated persistence outages", async () => {
    const store = new FailSeveralRaceEventStore(3);
    const pipeline = new LiveTelemetryPipeline(new CapturingDbAdapter(), new CapturingWsAdapter(), {
      bypassPacketRateFilter: true,
      skipHistorySeeding: true,
      skipDevState: true,
      recorder: new NullSessionRecorderAdapter(),
      sourceArchiveVerification: TEST_SOURCE_VERIFICATION,
      raceEventStore: store,
    });

    await expect(pipeline.processPacket(packet())).rejects.toThrow("Failed to persist race events");
    await expect(
      pipeline.noteSourceLifecycle(
        { kind: "timeout", timestampMs: 1_100, eventId: "source-timeout:A" },
        { kind: "udp", gameId: "fm-2023", sessionId: 1 },
      ),
    ).rejects.toThrow("Failed to persist race events");
    await expect(
      pipeline.noteSourceLifecycle(
        { kind: "reconnect", timestampMs: 1_200, eventId: "source-reconnect:B" },
        { kind: "udp", gameId: "fm-2023", sessionId: 1 },
      ),
    ).rejects.toThrow("Failed to persist race events");

    await pipeline.processPacket(packet({ TimestampMS: 1_300, CurrentLap: 30.3, DistanceTraveled: 2_030 }));

    expect(store.batches).toHaveLength(6);
    expect(store.batches.slice(3).flat()).toEqual(store.list().map(({ eventId }) => eventId));

    await pipeline.finalizeCurrentSession();
  });

  test("aborts coordinator and source preflight when detector feed fails, then accepts identical reset packet", async () => {
    const cleanStore = new MemoryRaceEventStore();
    const clean = new LiveTelemetryPipeline(new CapturingDbAdapter(), new CapturingWsAdapter(), {
      bypassPacketRateFilter: true,
      skipHistorySeeding: true,
      skipDevState: true,
      recorder: new NullSessionRecorderAdapter(),
      sourceArchiveVerification: TEST_SOURCE_VERIFICATION,
      raceEventStore: cleanStore,
    });
    const failingStore = new MemoryRaceEventStore();
    const failing = new LiveTelemetryPipeline(new CapturingDbAdapter(), new CapturingWsAdapter(), {
      bypassPacketRateFilter: true,
      skipHistorySeeding: true,
      skipDevState: true,
      recorder: new NullSessionRecorderAdapter(),
      sourceArchiveVerification: TEST_SOURCE_VERIFICATION,
      raceEventStore: failingStore,
    });
    const first = packet({ LapNumber: 2, TimestampMS: 1_000, CurrentLap: 60, DistanceTraveled: 5_000 });
    const reset = packet({ LapNumber: 1, TimestampMS: 1_100, CurrentLap: 0.1, DistanceTraveled: 20 });

    await clean.processPacket(first);
    await clean.processPacket(reset);
    await failing.processPacket(first);

    const detector = failing.lapDetector!;
    const feed = detector.feed.bind(detector);
    let shouldFail = true;
    detector.feed = async (telemetry, rawByteOffset) => {
      if (shouldFail) {
        shouldFail = false;
        throw new Error("detector reset failure");
      }
      await feed(telemetry, rawByteOffset);
    };

    await expect(failing.processPacket(reset)).rejects.toThrow("detector reset failure");
    await failing.processPacket(reset);

    expect(failingStore.list().map(({ eventType, sequence, timelineEpoch }) => ({ eventType, sequence, timelineEpoch }))).toEqual(
      cleanStore.list().map(({ eventType, sequence, timelineEpoch }) => ({ eventType, sequence, timelineEpoch })),
    );

    await clean.finalizeCurrentSession();
    await failing.finalizeCurrentSession();
  });

  test("keeps EOF nonterminal and emits replacement hint after finalized event metadata commits", async () => {
    const ws = new CapturingWsAdapter();
    const store = new MemoryRaceEventStore();
    const pipeline = new LiveTelemetryPipeline(new CapturingDbAdapter(), ws, {
      bypassPacketRateFilter: true,
      skipHistorySeeding: true,
      skipDevState: true,
      recorder: new NullSessionRecorderAdapter(),
      sourceArchiveVerification: TEST_SOURCE_VERIFICATION,
      raceEventStore: store,
    });

    await pipeline.processPacket(packet());
    await pipeline.finalizeCurrentSession("stream-ended");

    expect(store.list().some(({ eventType }) => eventType === "session_ended")).toBe(false);
    expect(ws.broadcastedNotifications).toContainEqual({
      type: "race-events-replaced",
      sessionId: 1,
    });
  });

  test("marks a stale rotation end as nonterminal without advancing the race phase", async () => {
    const store = new MemoryRaceEventStore();
    const pipeline = new LiveTelemetryPipeline(new CapturingDbAdapter(), new CapturingWsAdapter(), {
      bypassPacketRateFilter: true,
      skipHistorySeeding: true,
      skipDevState: true,
      recorder: new NullSessionRecorderAdapter(),
      sourceArchiveVerification: TEST_SOURCE_VERIFICATION,
      raceEventStore: store,
    });

    await pipeline.processPacket(packet());
    await pipeline.finalizeCurrentSession("silence-timeout");

    const ended = store.list().find(({ eventType }) => eventType === "session_ended");
    if (!ended || ended.eventType !== "session_ended") {
      throw new Error("Expected stale rotation to close the current timeline");
    }
    expect(ended.payload.terminalObserved).toBe(false);
    if (ended.payload.previousPhase == null) throw new Error("Expected stale rotation to preserve prior phase");
    expect(ended.payload.phase).toBe(ended.payload.previousPhase);
    expect(ended.payload.phase).not.toBe("finished");
  });

  test("publishes durable lap updates before queued result reconciliation fails", async () => {
    const ws = new CapturingWsAdapter();
    const pipeline = new LiveTelemetryPipeline(new CapturingDbAdapter(), ws, {
      bypassPacketRateFilter: true,
      skipHistorySeeding: true,
      skipDevState: true,
      recorder: new NullSessionRecorderAdapter(),
      sourceArchiveVerification: TEST_SOURCE_VERIFICATION,
      raceEventStore: new MemoryRaceEventStore(),
      onSessionFinalized: async () => {
        throw new Error("result reconciliation failed");
      },
    });

    await pipeline.processPacket(packet());
    await pipeline.processPacket(
      packet({
        TimestampMS: 2_000,
        LapNumber: 2,
        CurrentLap: 0.1,
        LastLap: 90,
        DistanceTraveled: 5_000,
      }),
    );
    await expect(pipeline.finalizeCurrentSession()).rejects.toThrow("result reconciliation failed");

    expect(pipeline.sessionLaps).toHaveLength(1);
    expect(ws.broadcastedNotifications.some(({ type }) => type === "lap-saved")).toBe(true);
    expect(ws.broadcastedNotifications.some(({ type }) => type === "lap-issues")).toBe(true);
  });

  test("releases reserved timeline batches when lap persistence fails", async () => {
    const pipeline = new LiveTelemetryPipeline(
      new FailingLapDbAdapter(),
      new CapturingWsAdapter(),
      {
        bypassPacketRateFilter: true,
        skipHistorySeeding: true,
        skipDevState: true,
        recorder: new NullSessionRecorderAdapter(),
        sourceArchiveVerification: TEST_SOURCE_VERIFICATION,
        raceEventStore: new MemoryRaceEventStore(),
      },
    );

    await pipeline.processPacket(packet());
    await pipeline.processPacket(
      packet({
        TimestampMS: 2_000,
        LapNumber: 2,
        CurrentLap: 0.1,
        LastLap: 90,
        DistanceTraveled: 5_000,
      }),
    );

    await expect(pipeline.finalizeCurrentSession()).rejects.toThrow(
      "lap insert failed",
    );
  });

  test("retains closed session finalization after durable failure and retries it", async () => {
    const db = new FailOnceQualityDbAdapter();
    const ws = new CapturingWsAdapter();
    const pipeline = new LiveTelemetryPipeline(db, ws, {
      bypassPacketRateFilter: true,
      skipHistorySeeding: true,
      skipDevState: true,
      recorder: new NullSessionRecorderAdapter(),
      sourceArchiveVerification: TEST_SOURCE_VERIFICATION,
      raceEventStore: new MemoryRaceEventStore(),
    });

    await pipeline.processPacket(packet());
    await expect(pipeline.finalizeCurrentSession()).rejects.toThrow("transient quality failure");
    expect(ws.broadcastedNotifications.some(({ type }) => type === "quality-updated")).toBe(false);

    await pipeline.finalizeCurrentSession();

    expect(db.sessionQuality.size).toBe(1);
    expect(ws.broadcastedNotifications.some(({ type }) => type === "quality-updated")).toBe(true);
  });

  test("starts generation before output writes and activates before reconciled notification", async () => {
    const db = new CapturingDbAdapter();
    const ws = new CapturingWsAdapter();
    const store = new MemoryRaceEventStore();
    const attempt = {
      generationId: "analysis-generation:live-order",
    } as AnalysisReceiptRow;
    const steps: string[] = [];
    let notificationPrecededActivation = false;
    const pipeline = new LiveTelemetryPipeline(db, ws, {
      bypassPacketRateFilter: true,
      skipHistorySeeding: true,
      skipDevState: true,
      recorder: new NullSessionRecorderAdapter(),
      raceEventStore: store,
      onSessionAnalysisStarted: async () => {
        steps.push("begin");
        return attempt;
      },
      onSessionFinalized: async () => {
        steps.push("reconcile");
      },
      onSessionAnalysisFinalized: async () => {
        notificationPrecededActivation =
          ws.broadcastedNotifications.some(
            ({ type }) => type === "race-result-reconciled",
          );
        steps.push("activate");
      },
    });

    await pipeline.processPacket(packet());
    await pipeline.processPacket(
      packet({
        TimestampMS: 2_000,
        LapNumber: 2,
        CurrentLap: 0.1,
        LastLap: 90,
        DistanceTraveled: 5_000,
      }),
    );
    await pipeline.finalizeCurrentSession();

    expect(db.sessions[0]?.analysisGenerationId).toBe(attempt.generationId);
    expect(db.laps[0]?.analysisGenerationId).toBe(attempt.generationId);
    expect(store.list().every((event) => event.analysisGenerationId === attempt.generationId)).toBe(true);
    expect(steps[0]).toBe("begin");
    expect(steps.at(-1)).toBe("activate");
    expect(steps.slice(1, -1).length).toBeGreaterThan(0);
    expect(steps.slice(1, -1).every((step) => step === "reconcile")).toBe(true);
    expect(notificationPrecededActivation).toBe(false);
    expect(
      ws.broadcastedNotifications.some(
        ({ type }) => type === "race-result-reconciled",
      ),
    ).toBe(true);
  });

  test("keeps failed activation unfinalized until retry activates same attempt", async () => {
    const ws = new CapturingWsAdapter();
    const attempt = {
      generationId: "analysis-generation:live-retry",
    } as AnalysisReceiptRow;
    let activationAttempts = 0;
    const pipeline = new LiveTelemetryPipeline(new CapturingDbAdapter(), ws, {
      bypassPacketRateFilter: true,
      skipHistorySeeding: true,
      skipDevState: true,
      recorder: new NullSessionRecorderAdapter(),
      raceEventStore: new MemoryRaceEventStore(),
      onSessionAnalysisStarted: async () => attempt,
      onSessionFinalized: async () => {},
      onSessionAnalysisFinalized: async () => {
        activationAttempts += 1;
        if (activationAttempts === 1) {
          throw new Error("receipt activation failed");
        }
      },
    });

    await pipeline.processPacket(packet());
    await expect(pipeline.finalizeCurrentSession()).rejects.toThrow(
      "receipt activation failed",
    );
    expect(
      ws.broadcastedNotifications.some(
        ({ type }) => type === "race-result-reconciled",
      ),
    ).toBe(false);

    await pipeline.finalizeCurrentSession();

    expect(activationAttempts).toBe(2);
    expect(
      ws.broadcastedNotifications.some(
        ({ type }) => type === "race-result-reconciled",
      ),
    ).toBe(true);
  });
});
