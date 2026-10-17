import { describe, test, expect } from "bun:test";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import { detectLapBoundary, detectLapReset } from "@raceiq/telemetry-core/processor/boundaries";
import { OrdinalDetectorEngine } from "@raceiq/telemetry-core/processor/ordinal-engine";
import { KunosDetectorEngine } from "@raceiq/telemetry-core/processor/kunos-engine";
import { IRacingDetectorEngine } from "@raceiq/telemetry-core/processor/iracing-engine";

function pkt(overrides: Partial<TelemetryPacket> = {}): TelemetryPacket {
  return {
    gameId: "fm-2023",
    IsRaceOn: 1,
    TimestampMS: 1000,
    LapNumber: 1,
    CurrentLap: 30,
    LastLap: 0,
    BestLap: 0,
    DistanceTraveled: 2000,
    carId: "100",
    trackId: "5",
    Speed: 50,
    PositionX: 0,
    PositionZ: 0,
    ...overrides,
  } as TelemetryPacket;
}

// ── detectLapBoundary ─────────────────────────────────────────────────────────

describe("detectLapBoundary", () => {
  test("normal +1 lap increment → complete", () => {
    expect(detectLapBoundary(3, pkt({ LapNumber: 4 }))).toEqual({ action: "complete" });
  });

  test("lap number went backward → reset-rewind", () => {
    expect(detectLapBoundary(5, pkt({ LapNumber: 3 }))).toEqual({ action: "reset-rewind" });
  });

  test("lap skip (+2) → complete-skip with reason", () => {
    const result = detectLapBoundary(3, pkt({ LapNumber: 5 }));
    expect(result.action).toBe("complete-skip");
    if (result.action === "complete-skip") {
      expect(result.invalidReason).toContain("3");
      expect(result.invalidReason).toContain("5");
    }
  });

  test("large lap skip (+5) → complete-skip", () => {
    expect(detectLapBoundary(1, pkt({ LapNumber: 6 }))).toMatchObject({ action: "complete-skip" });
  });
});

// ── detectLapReset ────────────────────────────────────────────────────────────

describe("detectLapReset", () => {
  function last(overrides: Partial<TelemetryPacket> = {}): TelemetryPacket {
    return pkt({ CurrentLap: 60, DistanceTraveled: 3000, ...overrides });
  }

  test("no reset condition → none", () => {
    // Distance must not drop >500m and CurrentLap must not reset to 0
    expect(detectLapReset(last(), 60, pkt({ CurrentLap: 61, DistanceTraveled: 3050 }))).toEqual({ action: "none" });
  });

  test("CurrentLap reset to 0 with LastLap unchanged → reset-restart", () => {
    expect(
      detectLapReset(last({ CurrentLap: 60 }), 0, pkt({ CurrentLap: 0, LastLap: 0 }))
    ).toEqual({ action: "reset-restart" });
  });

  test("CurrentLap reset to 0 with LastLap changed → complete-final-lap", () => {
    expect(
      detectLapReset(last({ CurrentLap: 60 }), 58.5, pkt({ CurrentLap: 0, LastLap: 60.1 }))
    ).toEqual({ action: "complete-final-lap" });
  });

  test("large distance drop with LastLap unchanged → reset-restart", () => {
    expect(
      detectLapReset(last({ DistanceTraveled: 3000 }), 0, pkt({ DistanceTraveled: 100, CurrentLap: 61 }))
    ).toEqual({ action: "reset-restart" });
  });

  test("large distance drop with LastLap changed → complete-final-lap", () => {
    expect(
      detectLapReset(last({ DistanceTraveled: 3000 }), 58.5, pkt({ DistanceTraveled: 100, LastLap: 60.1 }))
    ).toEqual({ action: "complete-final-lap" });
  });

  test("small distance drop (<500m) → none", () => {
    expect(
      detectLapReset(last({ DistanceTraveled: 3000 }), 0, pkt({ DistanceTraveled: 2600 }))
    ).toEqual({ action: "none" });
  });

  test("CurrentLap reset but was < 5s (warmup) → none", () => {
    // lastPkt.CurrentLap must be > 5 to trigger; keep distance stable so only CurrentLap check applies
    expect(
      detectLapReset(last({ CurrentLap: 3 }), 0, pkt({ CurrentLap: 0, DistanceTraveled: 3050 }))
    ).toEqual({ action: "none" });
  });
});

describe("pre-write lap checkpoint hints", () => {
  test("ordinal detector checkpoints lap changes and same-lap resets", () => {
    const engine = new OrdinalDetectorEngine({
      now: () => 1_000,
      createSession: async () => null,
      finalizeLap: async () => false,
      finalizeIncompleteLap: async () => {},
      finalizeStaleLap: async () => {},
      finalizeSession: async () => {},
    });
    Object.assign(engine.state, {
      session: { sessionKey: 1, carId: "100", trackId: "5", gameId: "fm-2023" },
      lapNumber: 1,
      lapBuffer: Array.from({ length: 31 }, () => pkt({ TimestampMS: 10, CurrentLap: 60 })),
      lastLastLap: 0,
      lastTimestampMS: 10,
      lastPacketTime: 900,
    });
    expect(engine.shouldCheckpoint(pkt({ LapNumber: 2, CurrentLap: 0 }))).toBe(true);
    expect(engine.shouldCheckpoint(pkt({ LapNumber: 1, CurrentLap: 0 }))).toBe(true);
    expect(engine.shouldCheckpoint(pkt({ LapNumber: 1, TimestampMS: 9 }))).toBe(true);
  });

  test("short Kunos initial partial publishes replacement start after abandonment", async () => {
    const engine = new KunosDetectorEngine({
      createSession: async () => {},
      backfillSessionIdentifiers: () => {},
      isPitOnly: () => false,
      emitLap: async () => {},
    });
    engine.subscribeOwnership(() => {});
    engine.observeSourceRecord(8_000, 8_100, 80);
    await engine.feed(pkt({ gameId: "acc", LapNumber: 1, CurrentLap: 6, DistanceTraveled: 1_000 }), 8_000, 80);
    engine.observeSourceRecord(8_100, 8_200, 81);
    await engine.feed(pkt({ gameId: "acc", LapNumber: 1, CurrentLap: 6.2, DistanceTraveled: 1_050 }), 8_100, 81);
    engine.drainOwnershipTransitions();
    engine.observeSourceRecord(8_200, 8_300, 82);
    await engine.feed(pkt({ gameId: "acc", LapNumber: 2, CurrentLap: 1, LastLap: 60, DistanceTraveled: 1_060 }), 8_200, 82);
    const transitions = engine.drainOwnershipTransitions();
    expect(transitions.some(item => item.kind === "window-abandoned")).toBe(true);
    expect(transitions.find(item => item.kind === "window-start")?.window).toMatchObject({
      startOffset: 8_200, startOrdinal: 82, frameCount: 1, status: "provisional",
    });
  });
  test("Kunos and iRacing checkpoint source candidate before boundary confirmation", async () => {
    const kunos = new KunosDetectorEngine({
      createSession: async () => {},
      backfillSessionIdentifiers: () => {},
      isPitOnly: () => false,
      emitLap: async () => {},
    });
    const kunosPacket = pkt({ gameId: "acc", LapNumber: 1 });
    expect(kunos.shouldCheckpoint(kunosPacket)).toBe(true);
    await kunos.feed(kunosPacket);
    expect(kunos.shouldCheckpoint(pkt({ gameId: "acc", LapNumber: 1, DistanceTraveled: 1_000 }))).toBe(true);

    const iracing = new IRacingDetectorEngine({
      now: () => 1_000,
      feed: async () => {},
      flushStaleLap: async () => {},
      finalizeCurrentSession: async () => {},
    });
    const iracingPacket = pkt({ gameId: "iracing", sessionUID: "session-1", LapNumber: 1 });
    expect(iracing.shouldCheckpoint(iracingPacket)).toBe(true);
    await iracing.feed(iracingPacket);
    expect(iracing.shouldCheckpoint(pkt({ gameId: "iracing", sessionUID: "session-1", LapNumber: 2 }))).toBe(true);
  });
  test("open-route activation publishes authoritative start for first timed packet", async () => {
    const engine = new KunosDetectorEngine({
      createSession: async () => {},
      backfillSessionIdentifiers: () => {},
      isPitOnly: () => false,
      isOpenRoute: () => true,
      emitLap: async () => {},
    });
    engine.subscribeOwnership(() => {});
    engine.observeSourceRecord(8_000, 8_100, 80);
    await engine.feed(pkt({
      gameId: "ac-evo", IsRaceOn: 1, LapNumber: 1, CurrentLap: 1,
      DistanceTraveled: 500, acc: { isValidLap: true } as never,
    }), 8_000, 80);
    const start = engine.drainOwnershipTransitions().find(item => item.kind === "window-start");
    expect(start?.window).toMatchObject({
      startOffset: 8_000, startOrdinal: 80, frameCount: 1, status: "provisional",
    });

    engine.observeSourceRecord(8_100, 8_200, 81);
    await engine.feed(pkt({
      gameId: "ac-evo", IsRaceOn: 1, LapNumber: 1, CurrentLap: 2,
      DistanceTraveled: 600, acc: { isValidLap: true } as never,
    }), 8_100, 81);
    expect(engine.getOwnershipState().windows.at(-1)).toMatchObject({
      startOffset: 8_000, startOrdinal: 80, frameCount: 2, status: "provisional",
    });
  });
  test("open-route candidate promotion publishes authoritative start on first timed packet", async () => {
    const engine = new KunosDetectorEngine({
      createSession: async () => {},
      backfillSessionIdentifiers: () => {},
      isPitOnly: () => false,
      isOpenRoute: (packet) => packet.gameId === "ac-evo",
      emitLap: async () => {},
    });
    engine.subscribeOwnership(() => {});
    await engine.feed(pkt({ gameId: "acc", LapNumber: 1, CurrentLap: 4 }), 8_000, 80);
    const timed = pkt({
      gameId: "ac-evo", IsRaceOn: 1, LapNumber: 1, CurrentLap: 1,
      DistanceTraveled: 500, acc: { isValidLap: true } as never,
    });
    engine.observeSourceRecord(9_000, 9_100, 90);
    expect(engine.shouldCheckpoint(timed)).toBe(true);
    expect(engine.drainOwnershipTransitions().some(item => item.kind === "candidate-start")).toBe(true);
    await engine.feed(timed, 9_000, 90);
    const start = engine.drainOwnershipTransitions().find(item => item.kind === "window-start");
    expect(start?.window).toMatchObject({
      startOffset: 9_000, startOrdinal: 90, frameCount: 1, status: "provisional",
    });
  });
  test("abandons old Kunos window on unchanged-lap prelap timer reset", async () => {
    const engine = new KunosDetectorEngine({
      createSession: async () => {},
      backfillSessionIdentifiers: () => {},
      isPitOnly: () => false,
      emitLap: async () => {},
    });
    engine.subscribeOwnership(() => {});
    engine.observeSourceRecord(10_000, 10_100, 100);
    await engine.feed(pkt({
      gameId: "acc", LapNumber: 10, CurrentLap: 10, LastLap: 0, DistanceTraveled: 2_000,
    }), 10_000, 100);
    engine.drainOwnershipTransitions();

    engine.observeSourceRecord(10_100, 10_200, 101);
    await engine.feed(pkt({
      gameId: "acc", LapNumber: 10, CurrentLap: 0, LastLap: 0, DistanceTraveled: 2_010,
    }), 10_100, 101);
    const transitions = engine.drainOwnershipTransitions();
    expect(transitions.filter(item => item.kind === "window-abandoned").map(item => item.window)).toMatchObject([
      { startOffset: 10_000, startOrdinal: 100, frameCount: 1, status: "incomplete" },
    ]);
    expect(transitions.find(item => item.kind === "window-start")?.window).toMatchObject({
      startOffset: 10_100, startOrdinal: 101, frameCount: 1, status: "provisional",
    });
  });
});
