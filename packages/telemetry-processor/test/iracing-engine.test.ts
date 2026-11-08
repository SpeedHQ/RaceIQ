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
  let incompleteFinalizations = 0;
  const engine = new IRacingDetectorEngine({
    now: () => now,
    feed: async (value, offset) => { fed.push({ packet: value, offset }); },
    flushStaleLap: async () => { flushes++; },
    finalizeCurrentSession: async () => { finalizations++; },
    finalizeIncompleteLap: async () => { incompleteFinalizations++; },
  });
  return {
    engine, fed,
    setNow(value: number) { now = value; },
    get flushes() { return flushes; },
    get finalizations() { return finalizations; },
    get incompleteFinalizations() { return incompleteFinalizations; },
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
  test("preserves delayed boundary ownership after skipped initial completion and large prelude", async () => {
    const h = harness();
    h.engine.observeSourceRecord(1_000_000, 1_000_080, 0);
    await h.engine.feed(packet(206, 0, 8), 1_000_000, 0);
    h.engine.drainOwnershipTransitions();

    h.engine.observeSourceRecord(1_000_080, 1_000_160, 1);
    const firstCompletion = packet(207, 115.035, 0);
    expect(h.engine.shouldCheckpoint(firstCompletion)).toBe(true);
    h.engine.drainOwnershipTransitions();
    await h.engine.feed(firstCompletion, 1_000_080, 1);
    expect(h.fed.at(-1)?.packet.LastLap).toBe(0);

    h.engine.observeSourceRecord(1_000_160, 1_000_240, 2);
    const boundary = packet(208, 115.035, 0);
    expect(h.engine.shouldCheckpoint(boundary)).toBe(true);
    const candidate = h.engine.drainOwnershipTransitions().find((item) => item.kind === "candidate-start");
    expect(candidate?.window).toMatchObject({
      lapNumber: 208, startOffset: 1_000_160, startOrdinal: 2,
      frameCount: 0, preparationOnly: true, holdForResolution: true,
    });

    await h.engine.feed(boundary, 1_000_160, 2);
    expect(h.engine.getOwnershipState().windows).toContainEqual(expect.objectContaining({
      lapNumber: 208, startOffset: 1_000_160, startOrdinal: 2, status: "provisional",
    }));
    h.engine.drainOwnershipTransitions();
    h.engine.observeSourceRecord(1_000_240, 1_000_320, 3);
    await h.engine.feed(packet(208, 115.035, 12), 1_000_240, 3);
    h.engine.observeSourceRecord(1_000_320, 1_000_400, 4);
    await h.engine.feed(packet(208, 116.2, 0), 1_000_320, 4);
    expect(h.fed.slice(-3).map(({ packet: p, offset }) => [p.LapNumber, p.LastLap, offset])).toEqual([
      [208, 116.2, 1_000_160], [208, 115.035, 1_000_240], [208, 116.2, 1_000_320],
    ]);
  });

  test("requires a confirming packet for unexpected lap jump and drops unconfirmed packet", async () => {
    const h = harness();
    await h.engine.feed(packet(4, 0, 5), 40);
    h.engine.observeSourceRecord(60, 61, 1);
    await h.engine.feed(packet(6, 0, 0), 60, 1);
    expect(h.fed.map(({ offset }) => offset)).toEqual([40]);
    h.engine.observeSourceRecord(70, 71, 2);
    await h.engine.feed(packet(7, 0, 0), 70, 2);
    expect(h.engine.drainOwnershipTransitions().some((item) =>
      item.kind === "window-abandoned" && item.window?.startOffset === 60,
    )).toBe(true);
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
    invalid.engine.observeSourceRecord(1, 2, 0);
    await invalid.engine.feed(packet(1, 0, 0), 1, 0);
    invalid.engine.observeSourceRecord(2, 3, 1);
    await invalid.engine.feed(packet(2, 0, 0), 2, 1);
    await invalid.engine.flushIncompleteLap();
    expect(invalid.fed.map(({ packet: p, offset }) => [p.LapNumber, offset])).toEqual([[1, 1]]);
    expect(invalid.engine.drainOwnershipTransitions().some((item) =>
      item.kind === "window-abandoned" && item.window?.startOffset === 2 && item.window.frameCount === 1,
    )).toBe(true);
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
  test("session stop abandons unresolved suffix despite stale positive native LastLap", async () => {
    const h = harness();
    let abandonedDeferred = false;
    h.engine.subscribeOwnership(item => {
      if (item.kind === "window-abandoned" && item.window?.startOffset === 20) abandonedDeferred = true;
    });
    h.engine.expectCompleteLapStart();
    await h.engine.feed(packet(1, 0, 8), 10);
    await h.engine.feed(packet(2, 60, 0), 20);
    await h.engine.finalizeCurrentSession();
    h.engine.drainOwnershipTransitions();
    expect(h.fed.map(({ packet: value, offset }) => [value.LapNumber, offset])).toEqual([[1, 10]]);
    expect(abandonedDeferred).toBe(true);
    expect(h.incompleteFinalizations).toBe(1);
    expect(h.finalizations).toBe(1);
  });
});
