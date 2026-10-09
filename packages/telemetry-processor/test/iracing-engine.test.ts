import { describe, expect, test } from "bun:test";
import { IRacingDetectorEngine } from "@raceiq/telemetry-core/processor/iracing-engine";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";

function packet(lap: number, lastLap: number, currentLap: number, sessionUID = "session"): TelemetryPacket {
  return {
    gameId: "iracing", sessionUID, LapNumber: lap, LastLap: lastLap,
    iracing: { sdkCurrentLapTime: currentLap } as TelemetryPacket["iracing"],
  } as TelemetryPacket;
}

function harness() {
  const fed: Array<{ packet: TelemetryPacket; offset?: number }> = [];
  let now = 0;
  let flushes = 0;
  let finalizations = 0;
  const engine = new IRacingDetectorEngine({
    now: () => now,
    feed: async (value, offset) => { fed.push({ packet: value, offset }); },
    flushStaleLap: async () => { flushes++; },
    finalizeCurrentSession: async () => { finalizations++; },
  });
  return {
    engine, fed,
    setNow(value: number) { now = value; },
    get flushes() { return flushes; },
    get finalizations() { return finalizations; },
  };
}

describe("IRacingDetectorEngine", () => {
  test("skips only initial completion and releases next lap in packet order with native timing and offsets", async () => {
    const h = harness();
    await h.engine.feed(packet(1, 0, 8), 10);
    const firstBoundary = packet(2, 71, 0);
    await h.engine.feed(firstBoundary, 20);
    expect(h.fed.map(({ packet: p, offset }) => [p.LapNumber, p.LastLap, offset])).toEqual([
      [1, 0, 10], [2, 0, 20],
    ]);
    expect(firstBoundary.LastLap).toBe(71);

    const deferredBoundary = packet(3, 71, 0);
    await h.engine.feed(deferredBoundary, 30);
    await h.engine.feed(packet(3, 71, 12), 31);
    expect(h.fed.map(({ packet: p }) => p.LapNumber)).toEqual([1, 2]);
    await h.engine.feed(packet(3, 73.25, 0), 32);
    expect(h.fed.map(({ packet: p, offset }) => [p.LapNumber, p.LastLap, offset])).toEqual([
      [1, 0, 10], [2, 0, 20], [3, 73.25, 30], [3, 71, 31], [3, 73.25, 32],
    ]);
    expect(deferredBoundary.LastLap).toBe(71);
  });

  test("requires a confirming packet for unexpected lap jump and drops unconfirmed packet", async () => {
    const h = harness();
    await h.engine.feed(packet(4, 0, 5), 40);
    await h.engine.feed(packet(6, 0, 0), 60);
    expect(h.fed.map(({ offset }) => offset)).toEqual([40]);
    await h.engine.feed(packet(7, 0, 0), 70);
    expect(h.fed.map(({ packet: p, offset }) => [p.LapNumber, offset])).toEqual([[4, 40]]);
    await h.engine.feed(packet(7, 0, 1), 71);
    expect(h.fed.map(({ packet: p, offset }) => [p.LapNumber, offset])).toEqual([[4, 40], [7, 70], [7, 71]]);
  });

  test("flush releases deferred lap only when authoritative timing exists", async () => {
    const valid = harness();
    valid.engine.expectCompleteLapStart();
    await valid.engine.feed(packet(1, 0, 0), 1);
    await valid.engine.feed(packet(2, 81.5, 0), 2);
    await valid.engine.flushIncompleteLap();
    expect(valid.fed.map(({ packet: p, offset }) => [p.LapNumber, p.LastLap, offset])).toEqual([
      [1, 0, 1], [2, 81.5, 2],
    ]);

    const invalid = harness();
    invalid.engine.expectCompleteLapStart();
    await invalid.engine.feed(packet(1, 0, 0), 1);
    await invalid.engine.feed(packet(2, 0, 0), 2);
    await invalid.engine.flushIncompleteLap();
    expect(invalid.fed.map(({ packet: p, offset }) => [p.LapNumber, offset])).toEqual([[1, 1]]);
    expect(invalid.engine.getDebugState().iracingDeferredPackets).toBe(0);
  });

  test("finalizes once after deferred lap becomes stale and resets for a new session", async () => {
    const h = harness();
    h.engine.expectCompleteLapStart();
    await h.engine.feed(packet(1, 0, 0), 1);
    await h.engine.feed(packet(2, 90, 0), 2);
    h.setNow(9_999);
    await h.engine.flushStaleLap();
    expect(h.finalizations).toBe(0);
    h.setNow(10_000);
    await h.engine.flushStaleLap();
    expect(h.finalizations).toBe(1);
    expect(h.engine.getDebugState()).toMatchObject({ iracingPhysicalLap: null, iracingDeferredPackets: 0 });
    await h.engine.flushStaleLap();
    expect(h.finalizations).toBe(1);

    await h.engine.feed(packet(8, 0, 0, "next-session"), 8);
    await h.engine.feed(packet(9, 92, 0, "next-session"), 9);
    expect(h.fed.map(({ packet: p, offset }) => [p.sessionUID, p.LapNumber, p.LastLap, offset])).toEqual([
      ["session", 1, 0, 1], ["next-session", 8, 0, 8], ["next-session", 9, 0, 9],
    ]);
    await h.engine.flushIncompleteLap();
    expect(h.fed.map(({ packet: p, offset }) => [p.sessionUID, p.LapNumber, p.LastLap, offset])).toEqual([
      ["session", 1, 0, 1], ["next-session", 8, 0, 8], ["next-session", 9, 0, 9],
    ]);
  });
});
