import { describe, expect, test } from "bun:test";
import { computeIRacingSectorTimeline,
computeLapSectors, } from "../../../server/lap-analysis/sectors"
import { initServerGameAdapters } from "../../../server/games/init";
import {
  createIRacingParserState,
  normalizeIRacingFrame,
} from "../../../server/games/iracing/normalizer";
import { LapDetectorIRacing } from "../../../server/games/iracing/lap-detector";
import { CapturingDbAdapter } from "../../../server/telemetry/pipeline-ports"
import { SectorTracker } from "../../../server/live-strategy/sector-tracker";
import { initGameAdapters } from "../../../shared/games/init";
import type { TelemetryPacket } from "../../../shared/telemetry/types";

initGameAdapters();
initServerGameAdapters();
import { sampleFrame, } from "../../support/games/iracing-sdk";

describe("iRacing lap timing and native sectors", () => {
  test("resets normalized elapsed time at the physical Lap transition", () => {
    const state = createIRacingParserState();
    const before = sampleFrame();
    before.values = {
      ...before.values,
      SessionTime: 100,
      Lap: 28,
      LapCurrentLapTime: 31.7,
      LapLastLapTime: 32.1,
    };
    const atLine = sampleFrame();
    atLine.values = {
      ...atLine.values,
      SessionTime: 100.02,
      Lap: 29,
      LapCurrentLapTime: 31.72,
      LapLastLapTime: 32.1,
    };
    const afterSdkRollover = sampleFrame();
    afterSdkRollover.values = {
      ...afterSdkRollover.values,
      SessionTime: 101.82,
      Lap: 29,
      LapCurrentLapTime: 1.8,
      LapLastLapTime: 31.7559,
    };

    expect(normalizeIRacingFrame(before, state).CurrentLap).toBeCloseTo(31.7);
    const linePacket = normalizeIRacingFrame(atLine, state);
    const rolloverPacket = normalizeIRacingFrame(afterSdkRollover, state);

    expect(linePacket.LapNumber).toBe(29);
    expect(linePacket.CurrentLap).toBeCloseTo(0);
    expect(linePacket.iracing?.sdkCurrentLapTime).toBeCloseTo(31.72);
    expect(rolloverPacket.CurrentLap).toBeCloseTo(1.8);
    expect(rolloverPacket.LastLap).toBeCloseTo(31.7559);
  });

  test("supports an explicitly two-sector native layout", async () => {
    const twoSectorTrackOrdinal = 1_000_099;
    const packets = Array.from({ length: 101 }, (_, index) => {
      const fraction = index / 100;
      return {
        gameId: "iracing",
        CurrentLap: fraction * 32,
        DistanceTraveled: fraction * 2350,
        iracing: {
          trackLengthM: 2350,
          lapDistancePct: fraction,
          sectorStarts: [0, 0.5],
        },
      } as TelemetryPacket;
    });

    const timeline = computeIRacingSectorTimeline(packets, 32);
    expect(timeline?.sectorCount).toBe(2);
    expect(timeline?.times).toEqual([16, 16]);
    expect(timeline?.boundaryIndices).toHaveLength(1);
    expect(
      await computeLapSectors(
        twoSectorTrackOrdinal,
        "iracing",
        packets,
        32,
      ),
    ).toEqual([16, 16]);

    const liveTracker = new SectorTracker();
    await liveTracker.reset(twoSectorTrackOrdinal, "iracing", 42);
    let live: ReturnType<SectorTracker["feed"]> = null;
    for (const packet of packets) live = liveTracker.feed(packet);
    expect(live?.sectorCount).toBe(2);
    expect(live?.currentSector).toBe(1);
  });

  test("does not invent iRacing sectors when native metadata is absent", async () => {
    const packets = Array.from({ length: 60 }, (_, index) => {
      const fraction = index / 59;
      return {
        gameId: "iracing",
        CurrentLap: fraction * 32,
        DistanceTraveled: fraction * 2350,
        iracing: { lapDistancePct: fraction },
      } as TelemetryPacket;
    });

    expect(computeIRacingSectorTimeline(packets, 32)).toBeNull();
    expect(await computeLapSectors(99, "iracing", packets, 32)).toBeNull();
  });

  test("keeps native sector fractions when the source attaches mid-lap", async () => {
    const tracker = new SectorTracker();
    await tracker.reset(99, "iracing", 42);

    const packet = (
      lapNumber: number,
      distance: number,
      fraction: number,
      currentLap: number,
    ): TelemetryPacket =>
      ({
        gameId: "iracing",
        LapNumber: lapNumber,
        LastLap: 40,
        CurrentLap: currentLap,
        DistanceTraveled: distance,
        iracing: {
          trackLengthM: 1000,
          lapDistancePct: fraction,
          sectorStarts: [0, 0.34, 0.67],
        },
      }) as TelemetryPacket;

    tracker.feed(packet(5, 5750, 0.75, 30));
    tracker.feed(packet(6, 6000, 0, 0));
    const live = tracker.feed(packet(6, 6300, 0.3, 10));

    expect(tracker.getTrackLength()).toBe(1000);
    expect(live?.currentSector).toBe(0);
  });

  test("attaches delayed LastLap to the physical lap and native lap number", async () => {
    const db = new CapturingDbAdapter();
    const detector = new LapDetectorIRacing({
      db,
      bypassPacketRateFilter: true,
    });
    const trackLength = 2350;
    let offset = 0;

    const packet = (
      lapNumber: number,
      currentLap: number,
      sdkCurrentLapTime: number,
      lastLap: number,
      fraction: number,
    ): TelemetryPacket =>
      ({
        gameId: "iracing",
        sessionUID: "456:123:2",
        CarOrdinal: 42,
        TrackOrdinal: 99,
        CarPerformanceIndex: 0,
        CarClass: 8,
        LapNumber: lapNumber,
        CurrentLap: currentLap,
        LastLap: lastLap,
        BestLap: 0,
        CurrentRaceTime: 100 + lapNumber * 40 + currentLap,
        DistanceTraveled:
          lapNumber * trackLength + Math.min(fraction, 0.999) * trackLength,
        PositionX: 0,
        PositionY: 0,
        PositionZ: 0,
        Speed: 70,
        TimestampMS: Math.round(
          (100 + lapNumber * 40 + currentLap) * 1000,
        ),
        Fuel: 40,
        TireWearFL: 0,
        TireWearFR: 0,
        TireWearRL: 0,
        TireWearRR: 0,
        iracing: {
          sdkCurrentLapTime,
          lapDistancePct: fraction,
          sectorStarts: [0, 0.5],
          carName: "GT3 Test Car",
          trackName: "Road America",
        },
      }) as TelemetryPacket;

    const feed = async (value: TelemetryPacket) => {
      await detector.feed(value, offset);
      offset += 100;
    };

    // Initial fragment is deliberately discarded.
    await feed(packet(0, 20, 20, 0, 0.5));
    await feed(packet(1, 0, 20.01, 20, 0));

    for (let i = 1; i <= 64; i++) {
      const elapsed = (31.917 * i) / 64;
      await feed(packet(1, elapsed, elapsed, 20, i / 65));
    }

    // Physical line crossing happens first; SDK timing rolls 1.8s later.
    await feed(packet(2, 0, 31.917, 20, 0));
    await feed(packet(2, 1.8, 1.8, 31.917, 1.8 / 32.045));

    for (let i = 5; i <= 64; i++) {
      const elapsed = (32.045 * i) / 64;
      await feed(packet(2, elapsed, elapsed, 31.917, i / 65));
    }

    await feed(packet(3, 0, 32.045, 31.917, 0));
    await feed(packet(3, 1.8, 1.8, 32.045, 1.8 / 33));

    expect(db.laps).toHaveLength(2);
    expect(db.laps.map((lap) => lap.lapNumber)).toEqual([1, 2]);
    expect(db.laps[0].lapTime).toBeCloseTo(31.917, 3);
    expect(db.laps[1].lapTime).toBeCloseTo(32.045, 3);
    expect(db.laps[0].rawFrameCount).toBe(65);
    expect(db.laps[0].sectors).toHaveLength(2);
    expect(db.sessions[0]).toMatchObject({
      carOrdinal: 42,
      trackOrdinal: 99,
    });
    expect(db.sessions[0]).not.toHaveProperty("carName");
    expect(db.sessions[0]).not.toHaveProperty("trackName");

    // A native timer rollover without a valid LastLap discards that lap and
    // leaves the following valid lap aligned with its own timing.
    await feed(packet(4, 0, 33, 32.045, 0));
    await feed(packet(4, 1.8, 1.8, 0, 1.8 / 33));
    for (let i = 5; i <= 64; i++) {
      const elapsed = (33 * i) / 64;
      await feed(packet(4, elapsed, elapsed, 0, i / 65));
    }
    await feed(packet(5, 0, 33, 0, 0));
    await feed(packet(5, 1.8, 1.8, 33, 1.8 / 33));

    expect(db.laps.map((lap) => lap.lapNumber)).toEqual([1, 2, 4]);

    // iRacing can emit one zeroed SDK frame after a session. It must not turn
    // the following valid lap number into an invalid "0 → N" ghost lap.
    await feed(packet(0, 0, 0, 33, 0));
    await feed(packet(5, 2, 2, 33, 0.05));
    expect(db.laps.map((lap) => lap.lapNumber)).toEqual([1, 2, 4]);

    // A persistent unexpected transition still reaches the shared detector.
    await feed(packet(2, 0, 0, 33, 0));
    expect(detector.getDebugState()).toMatchObject({
      iracingPhysicalLap: 5,
      iracingPendingUnexpectedLap: 2,
    });
    await feed(packet(2, 0.1, 0.1, 33, 0.001));
    expect(detector.getDebugState()).toMatchObject({
      iracingPhysicalLap: 2,
      iracingPendingUnexpectedLap: null,
    });
    expect(db.laps[2].lapTime).toBe(33);
  });
});
