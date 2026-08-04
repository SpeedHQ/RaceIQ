import { describe, expect, spyOn, test } from "bun:test";
import { computeIRacingSectorTimeline } from "../../server/lap-analysis/sectors"
import { normalizeIRacingFrame } from "../../server/games/iracing/normalizer";
import type { IRacingSourceFrameV2 } from "../../server/games/iracing/source-frame";
import { SectorTracker } from "../../server/live-strategy/sector-tracker";
import { initGameAdapters } from "../../shared/games/init";
import type { TelemetryPacket } from "../../shared/telemetry/types";

initGameAdapters();

function sourceFrame(sectorStarts: number[]): IRacingSourceFrameV2 {
  return {
    schemaVersion: 2,
    session: {
      sessionId: 1,
      subSessionId: 2,
      sessionNum: 0,
      driverCarIdx: 0,
      trackId: 99,
      trackName: "Test Track",
      trackLengthM: 2350,
      sectorStarts,
      carId: 42,
      carName: "Test Car",
      carClassId: 8,
      carClassName: "Test Class",
      engineIdleRpm: 900,
      engineRedlineRpm: 8500,
      engineCylinderCount: 8,
    },
    values: {
      Lap: 1,
      LapDist: 100,
      LapDistPct: 0.05,
      SessionTime: 1,
      LapCurrentLapTime: 1,
    },
  };
}

function lapPackets(sectorStarts: number[]): TelemetryPacket[] {
  return Array.from({ length: 101 }, (_, index) => {
    const fraction = index / 100;
    return {
      gameId: "iracing",
      CurrentLap: fraction * 32,
      DistanceTraveled: fraction * 2350,
      iracing: {
        trackLengthM: 2350,
        lapDistancePct: fraction,
        sectorStarts,
      },
    } as TelemetryPacket;
  });
}

describe("iRacing native sector layouts", () => {
  test("accepts a sector origin within floating-point epsilon everywhere", async () => {
    const sectorStarts = [0.0000005, 0.5];
    expect(
      normalizeIRacingFrame(sourceFrame(sectorStarts)).iracing?.sectorStarts,
    ).toEqual(sectorStarts);

    const packets = lapPackets(sectorStarts);
    expect(computeIRacingSectorTimeline(packets, 32)?.times).toEqual([16, 16]);

    const liveTracker = new SectorTracker();
    await liveTracker.reset(99, "iracing", 42);
    let live: ReturnType<SectorTracker["feed"]> = null;
    for (const packet of packets) live = liveTracker.feed(packet);
    expect(live?.sectorCount).toBe(2);
    expect(live?.currentSector).toBe(1);
  });

  test("preserves a six-sector session layout through replay and live tracking", async () => {
    const sectorStarts = [0, 0.1, 0.25, 0.45, 0.7, 0.85];
    expect(
      normalizeIRacingFrame(sourceFrame(sectorStarts)).iracing?.sectorStarts,
    ).toEqual(sectorStarts);

    const packets = lapPackets(sectorStarts);
    const timeline = computeIRacingSectorTimeline(packets, 32);
    expect(timeline?.sectorCount).toBe(6);
    expect(timeline?.sectorStarts).toEqual(sectorStarts);
    expect(timeline?.times).toHaveLength(6);
    expect(timeline!.times.reduce((sum, time) => sum + time, 0)).toBeCloseTo(32, 6);

    const liveTracker = new SectorTracker();
    await liveTracker.reset(99, "iracing", 42);
    let live: ReturnType<SectorTracker["feed"]> = null;
    for (const packet of packets) live = liveTracker.feed(packet);
    expect(live?.sectorCount).toBe(6);
    expect(live?.currentTimes).toHaveLength(6);
  });

  test("logs a malformed layout once instead of dropping it silently", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const malformed = [0, 0.5, 0.5];
      expect(
        normalizeIRacingFrame(sourceFrame(malformed)).iracing?.sectorStarts,
      ).toEqual([]);
      expect(
        normalizeIRacingFrame(sourceFrame(malformed)).iracing?.sectorStarts,
      ).toEqual([]);

      expect(
        computeIRacingSectorTimeline(lapPackets(malformed), 32),
      ).toBeNull();

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toContain(
        "Ignoring malformed native sector layout",
      );
    } finally {
      warn.mockRestore();
    }
  });
});
