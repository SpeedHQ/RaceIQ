import { describe, expect, test } from "bun:test";
import { packet as fixturePacket } from "../support-resolver";
import { OrdinalDetectorEngine, type DetectorOwnershipTransition, type OrdinalEngineState } from "../../src/processor/ordinal-engine";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";

function telemetry(values: Partial<TelemetryPacket> = {}): TelemetryPacket {
  return fixturePacket("fm-2023", {
    carId: "car",
    trackId: "track",
    LapNumber: 1,
    CurrentLap: 1,
    LastLap: 0,
    DistanceTraveled: 100,
    TimestampMS: 1_000,
    ...values,
  });
}

function engineFixture(persistCompleted = true) {
  let now = 1_000;
  const persisted: Array<{ offset: number | null; count: number }> = [];
  let engine: OrdinalDetectorEngine;
  engine = new OrdinalDetectorEngine({
    now: () => now++,
    createSession: async () => ({ carId: "car", trackId: "track", gameId: "fm-2023" }),
    finalizeLap: async (_packet, state) => {
      engine.trimRunningStartPackets();
      if (persistCompleted) persisted.push({ offset: state.lapByteOffset, count: state.lapFrameCount });
      return persistCompleted;
    },
    finalizeIncompleteLap: async (_state: Readonly<OrdinalEngineState>) => undefined,
    finalizeStaleLap: async () => undefined,
    finalizeSession: async () => undefined,
  }, { bypassPacketRateFilter: true });
  return { engine, persisted };
}

function observe(engine: OrdinalDetectorEngine, offset: number, ordinal: number): void {
  engine.observeSourceRecord(offset, offset + 10, ordinal);
}

async function feed(engine: OrdinalDetectorEngine, values: Partial<TelemetryPacket>, offset: number, ordinal: number): Promise<void> {
  observe(engine, offset, ordinal);
  await engine.feed(telemetry(values), offset, ordinal);
}

describe("ordinal detector source ownership", () => {
  test("explicitly abandons a rejected completed window before starting the next lap", async () => {
    const { engine, persisted } = engineFixture(false);
    await feed(engine, {}, 1_000, 10);
    engine.drainOwnershipTransitions();
    observe(engine, 1_010, 11);
    observe(engine, 1_020, 12);
    await feed(engine, { LapNumber: 2, CurrentLap: 0 }, 1_030, 13);
    const transitions = engine.drainOwnershipTransitions();
    expect(persisted).toEqual([]);
    expect(transitions.filter((item) => item.kind === "window-abandoned").map((item) => item.window)).toMatchObject([
      { startOffset: 1_000, startOrdinal: 10, frameCount: 3, status: "incomplete" },
    ]);
    expect(transitions.some((item) => item.kind === "window-finalized")).toBe(false);
    expect(transitions.find((item) => item.kind === "window-start")?.window).toMatchObject({ startOffset: 1_030, startOrdinal: 13 });
  });

  test("short incomplete flush disposes its candidate explicitly", async () => {
    const { engine } = engineFixture();
    await feed(engine, { CurrentLap: 0.5 }, 2_000, 20);
    engine.drainOwnershipTransitions();
    await engine.flushIncompleteLap();
    const transitions = engine.drainOwnershipTransitions();
    expect(transitions.filter((item) => item.kind === "window-abandoned").map((item) => item.window)).toMatchObject([
      { startOffset: 2_000, startOrdinal: 20, frameCount: 1, status: "incomplete" },
    ]);
    expect(transitions.some((item) => item.kind === "final-incomplete")).toBe(false);
  });

  test("counts raw records observed between parsed frames but excludes next-lap trigger", async () => {
    const { engine, persisted } = engineFixture();
    const transitions: DetectorOwnershipTransition[] = [];
    engine.subscribeOwnership((transition) => transitions.push(transition));

    await feed(engine, {}, 1_000, 10);
    engine.drainOwnershipTransitions();
    engine.setBypassPacketRateFilter(false);
    await feed(engine, { CurrentLap: 1 }, 1_010, 11); // dropped by the production packet-rate guard
    observe(engine, 1_020, 12); // parser-null source record
    observe(engine, 1_030, 13);
    engine.setBypassPacketRateFilter(true);
    await feed(engine, { LapNumber: 2, CurrentLap: 0 }, 1_040, 14);
    engine.drainOwnershipTransitions();

    expect(persisted.at(-1)).toEqual({ offset: 1_000, count: 4 });
    expect(transitions.find((item) => item.kind === "window-finalized")?.window).toMatchObject({ startOrdinal: 10, frameCount: 4, status: "final" });
  });

  test("running-start trim moves persisted and authoritative window start/count together", async () => {
    const { engine, persisted } = engineFixture();
    const transitions: DetectorOwnershipTransition[] = [];
    engine.subscribeOwnership((transition) => transitions.push(transition));

    await feed(engine, { CurrentLap: 1 }, 2_000, 20);
    engine.drainOwnershipTransitions();
    await feed(engine, { CurrentLap: 6 }, 2_010, 21);
    await feed(engine, { CurrentLap: 0.2 }, 2_020, 22);
    await feed(engine, { CurrentLap: 1 }, 2_030, 23);
    await feed(engine, { CurrentLap: 2 }, 2_040, 24);
    await feed(engine, { CurrentLap: 3 }, 2_050, 25);
    await feed(engine, { LapNumber: 2, CurrentLap: 0 }, 2_060, 26);
    engine.drainOwnershipTransitions();

    expect(persisted.at(-1)).toEqual({ offset: 2_020, count: 4 });
    expect(transitions.find((item) => item.kind === "window-finalized")?.window).toMatchObject({ startOffset: 2_020, startOrdinal: 22, frameCount: 4 });
  });

  test("rebases active ownership ordinals across capture epoch rotation", async () => {
    const { engine, persisted } = engineFixture();
    const transitions: DetectorOwnershipTransition[] = [];
    engine.subscribeOwnership((transition) => transitions.push(transition));
    await feed(engine, {}, 5_000, 100);
    engine.setCurrentLapByteOffset(10, 0);
    engine.drainOwnershipTransitions();
    await feed(engine, { CurrentLap: 2 }, 20, 1);
    await feed(engine, { LapNumber: 2, CurrentLap: 0 }, 30, 2);
    engine.drainOwnershipTransitions();
    expect(persisted.at(-1)).toEqual({ offset: 10, count: 2 });
    expect(transitions.find((item) => item.kind === "window-start")?.window).toMatchObject({ startOffset: 10, startOrdinal: 0, frameCount: 1 });
    expect(transitions.find((item) => item.kind === "window-finalized")?.window).toMatchObject({ startOffset: 10, startOrdinal: 0, frameCount: 2 });
  });

  test("delays start publication until epoch offset repair and keeps snapshots provisional", async () => {
    const { engine } = engineFixture();
    await feed(engine, {}, 3_000, 30);
    engine.setCurrentLapByteOffset(3_100);
    const drained = engine.drainOwnershipTransitions();
    expect(drained.find((item) => item.kind === "window-start")?.window?.startOffset).toBe(3_100);
    engine.markProvisionalSnapshot();
    const snapshot = engine.drainOwnershipTransitions().find((item) => item.kind === "snapshot");
    expect(snapshot?.window).toMatchObject({ status: "provisional", startOffset: 3_100 });
  });

  test("emits bounded preparation-only candidates without adding ownership history", async () => {
    const { engine } = engineFixture();
    await feed(engine, { CurrentLap: 6 }, 4_000, 40);
    await feed(engine, { CurrentLap: 0.2 }, 4_010, 41);
    await feed(engine, { CurrentLap: 6 }, 4_020, 42);
    await feed(engine, { CurrentLap: 0.2 }, 4_030, 43);
    const transitions = engine.drainOwnershipTransitions();
    const candidates = transitions.filter((item) => item.kind === "candidate-start");
    expect(candidates).toHaveLength(2);
    expect(candidates.every((item) => item.window?.preparationOnly === true && item.window.frameCount === 0)).toBe(true);
    expect(engine.getOwnershipState().windows.length).toBeLessThanOrEqual(2);
    expect(engine.getOwnershipState().windows.some((item) => item.preparationOnly)).toBe(false);
  });
});
