import { describe, expect, test } from "bun:test";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import { OrdinalDetectorEngine } from "@raceiq/telemetry-core/processor/ordinal-engine";

function packet(overrides: Partial<TelemetryPacket> = {}): TelemetryPacket {
  return {
    gameId: "lmu",
    sessionUID: "session-1",
    LapNumber: 1,
    LastLap: 0,
    CurrentLap: 12,
    TimestampMS: 1,
    DistanceTraveled: 100,
    Fuel: -1,
    TireWearFL: -1,
    TireWearFR: -1,
    TireWearRL: -1,
    TireWearRR: -1,
    CarOrdinal: 1,
    TrackOrdinal: 1,
    ...overrides,
  } as TelemetryPacket;
}

function makeEngine(finalized: (packet: TelemetryPacket) => boolean, incomplete: number[][] = []) {
  return new OrdinalDetectorEngine({
    now: () => 1,
    createSession: async (p) => ({
      carOrdinal: 1,
      trackOrdinal: 1,
      gameId: p.gameId,
      sessionUID: p.sessionUID,
    }),
    finalizeLap: async (p) => finalized(p),
    finalizeIncompleteLap: async (state) => {
      incomplete.push(state.lapBuffer.map((item) => item.CurrentLap));
    },
    finalizeStaleLap: async () => {},
    finalizeSession: async () => {},
  });
}

describe("OrdinalDetectorEngine migration regressions", () => {
  test("short skipped fragments do not consume LMU first-outlap classification", async () => {
    let completion = 0;
    const engine = makeEngine(() => ++completion > 1);

    await engine.feed(packet({ LapNumber: 1 }));
    await engine.feed(packet({ LapNumber: 2, CurrentLap: 1 }));
    expect(engine.state.completedLapCount).toBe(0);

    await engine.feed(packet({ LapNumber: 3, CurrentLap: 1 }));
    expect(engine.state.completedLapCount).toBe(1);
  });

  test("session rollover trims running-start fragments before incomplete-lap eligibility", async () => {
    const persisted: number[][] = [];
    const engine = makeEngine(() => true, persisted);

    await engine.feed(packet({ CurrentLap: 6 }));
    await engine.feed(packet({ CurrentLap: 0, TimestampMS: 2 }));
    await engine.feed(packet({ CurrentLap: 12, TimestampMS: 3 }));
    await engine.feed(packet({ sessionUID: "session-2", TimestampMS: 4 }));

    expect(persisted).toEqual([[0, 12]]);
  });
});
