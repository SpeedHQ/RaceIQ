import { describe, test, expect } from "bun:test";
import type { TelemetryPacket } from "../shared/types";
import { SectorTracker } from "../server/sector-tracker";

/** Build a minimal telemetry packet for testing. */
function pkt(overrides: Partial<TelemetryPacket>): TelemetryPacket {
  return {
    gameId: "fm-2023",
    IsRaceOn: 1,
    TimestampMS: 0,
    DistanceTraveled: 0,
    CurrentLap: 0,
    LastLap: 0,
    BestLap: 0,
    LapNumber: 1,
    PositionX: 0,
    PositionZ: 0,
    Speed: 50,
    ...overrides,
  } as TelemetryPacket;
}

/** Generate a reference lap: uniform pace over trackLength in lapTime seconds. */
function makeRefPackets(trackLength: number, lapTime: number, count: number, distOffset = 0): TelemetryPacket[] {
  const packets: TelemetryPacket[] = [];
  for (let i = 0; i < count; i++) {
    const frac = i / (count - 1);
    packets.push(pkt({
      DistanceTraveled: distOffset + frac * trackLength,
      CurrentLap: frac * lapTime,
      LapNumber: 1,
    }));
  }
  return packets;
}

describe("SectorTracker estimated lap & delta", () => {
  test("no reference lap → no estimated lap or delta", () => {
    const tracker = new SectorTracker();
    tracker._initForTest({ s1End: 0.33, s2End: 0.66, trackLength: 5000 });

    // First packet initializes
    const r1 = tracker.feed(pkt({ DistanceTraveled: 0, CurrentLap: 0, LapNumber: 1 }));
    expect(r1).not.toBeNull();
    expect(r1!.estimatedLap).toBe(0);
    expect(r1!.deltaToBest).toBe(0);
  });

  test("with reference lap, delta reflects time difference at same distance", () => {
    const tracker = new SectorTracker();
    tracker._initForTest({ s1End: 0.33, s2End: 0.66, trackLength: 5000 });

    // Set reference: uniform 90s lap over 5000m
    const refPackets = makeRefPackets(5000, 90, 200);
    tracker.updateRefLap(refPackets, 90);

    // Initialize tracker with first packet of a new lap
    tracker.feed(pkt({ DistanceTraveled: 10000, CurrentLap: 0, LapNumber: 2 }));

    // At 50% through the lap (2500m), reference time would be 45s
    // If live time is 46s, delta should be +1s, estimated = 90 + 1 = 91
    const r = tracker.feed(pkt({ DistanceTraveled: 12500, CurrentLap: 46, LapNumber: 2 }));
    expect(r).not.toBeNull();
    expect(r!.deltaToBest).toBeCloseTo(1.0, 1);
    expect(r!.estimatedLap).toBeCloseTo(91.0, 1);
  });

  test("faster than reference shows negative delta", () => {
    const tracker = new SectorTracker();
    tracker._initForTest({ s1End: 0.33, s2End: 0.66, trackLength: 5000 });

    const refPackets = makeRefPackets(5000, 90, 200);
    tracker.updateRefLap(refPackets, 90);

    tracker.feed(pkt({ DistanceTraveled: 0, CurrentLap: 0, LapNumber: 1 }));

    // At 50% (2500m), ref time = 45s, live time = 43s → delta = -2s
    const r = tracker.feed(pkt({ DistanceTraveled: 2500, CurrentLap: 43, LapNumber: 1 }));
    expect(r!.deltaToBest).toBeCloseTo(-2.0, 1);
    expect(r!.estimatedLap).toBeCloseTo(88.0, 1);
  });

  test("at exact same pace as reference, delta is ~0", () => {
    const tracker = new SectorTracker();
    tracker._initForTest({ s1End: 0.33, s2End: 0.66, trackLength: 5000 });

    const refPackets = makeRefPackets(5000, 90, 200);
    tracker.updateRefLap(refPackets, 90);

    tracker.feed(pkt({ DistanceTraveled: 0, CurrentLap: 0, LapNumber: 1 }));

    // 75% through: ref time = 67.5s, live = 67.5s
    const r = tracker.feed(pkt({ DistanceTraveled: 3750, CurrentLap: 67.5, LapNumber: 1 }));
    expect(r!.deltaToBest).toBeCloseTo(0, 1);
    expect(r!.estimatedLap).toBeCloseTo(90, 1);
  });

  test("beyond reference distance returns no estimate", () => {
    const tracker = new SectorTracker();
    tracker._initForTest({ s1End: 0.33, s2End: 0.66, trackLength: 5000 });

    const refPackets = makeRefPackets(5000, 90, 200);
    tracker.updateRefLap(refPackets, 90);

    tracker.feed(pkt({ DistanceTraveled: 0, CurrentLap: 0, LapNumber: 1 }));

    // Past the end of the reference lap
    const r = tracker.feed(pkt({ DistanceTraveled: 5100, CurrentLap: 91, LapNumber: 1 }));
    expect(r!.estimatedLap).toBe(0);
    expect(r!.deltaToBest).toBe(0);
  });

  test("updateRefLap only replaces with faster lap", () => {
    const tracker = new SectorTracker();
    tracker._initForTest({ s1End: 0.33, s2End: 0.66, trackLength: 5000 });

    const fast = makeRefPackets(5000, 85, 200);
    const slow = makeRefPackets(5000, 95, 200);

    tracker.updateRefLap(fast, 85);
    tracker.updateRefLap(slow, 95); // should NOT replace

    tracker.feed(pkt({ DistanceTraveled: 0, CurrentLap: 0, LapNumber: 1 }));

    // At 50%, ref time should be from 85s lap (42.5s), not 95s lap
    const r = tracker.feed(pkt({ DistanceTraveled: 2500, CurrentLap: 42.5, LapNumber: 1 }));
    expect(r!.deltaToBest).toBeCloseTo(0, 1);
    expect(r!.estimatedLap).toBeCloseTo(85, 1);
  });

  test("updateRefLap updates bestLapTime", () => {
    const tracker = new SectorTracker();
    tracker._initForTest({ s1End: 0.33, s2End: 0.66, trackLength: 5000 });

    const ref = makeRefPackets(5000, 88, 200);
    tracker.updateRefLap(ref, 88);

    tracker.feed(pkt({ DistanceTraveled: 0, CurrentLap: 0, LapNumber: 1 }));
    const r = tracker.feed(pkt({ DistanceTraveled: 100, CurrentLap: 1, LapNumber: 1 }));
    expect(r!.bestLapTime).toBe(88);
  });

  test("cumulative DistanceTraveled works correctly for later laps", () => {
    const tracker = new SectorTracker();
    tracker._initForTest({ s1End: 0.33, s2End: 0.66, trackLength: 5000 });

    // Reference lap recorded starting from dist 5000
    const refPackets = makeRefPackets(5000, 90, 200, 5000);
    tracker.updateRefLap(refPackets, 90);

    // Live lap starts at dist 15000 (lap 3 of session)
    tracker.feed(pkt({ DistanceTraveled: 15000, CurrentLap: 0, LapNumber: 3 }));

    // At 2500m into the lap (dist 17500), ref time = 45s, live = 44s → delta = -1
    const r = tracker.feed(pkt({ DistanceTraveled: 17500, CurrentLap: 44, LapNumber: 3 }));
    expect(r!.deltaToBest).toBeCloseTo(-1.0, 1);
    expect(r!.estimatedLap).toBeCloseTo(89.0, 1);
  });

  test("non-uniform reference lap interpolates correctly", () => {
    const tracker = new SectorTracker();
    tracker._initForTest({ s1End: 0.33, s2End: 0.66, trackLength: 1000 });

    // Non-uniform pace: first half slow, second half fast
    // 0-500m takes 60s, 500-1000m takes 30s, total 90s
    const refPackets: TelemetryPacket[] = [];
    for (let i = 0; i <= 100; i++) {
      const frac = i / 100;
      const dist = frac * 1000;
      // Slow first half, fast second half
      const time = dist <= 500
        ? (dist / 500) * 60
        : 60 + ((dist - 500) / 500) * 30;
      refPackets.push(pkt({ DistanceTraveled: dist, CurrentLap: time }));
    }
    tracker.updateRefLap(refPackets, 90);

    tracker.feed(pkt({ DistanceTraveled: 0, CurrentLap: 0, LapNumber: 1 }));

    // At 250m (middle of slow section), ref time = 30s
    const r1 = tracker.feed(pkt({ DistanceTraveled: 250, CurrentLap: 31, LapNumber: 1 }));
    expect(r1!.deltaToBest).toBeCloseTo(1.0, 1);

    // At 750m (middle of fast section), ref time = 60 + 15 = 75s
    const r2 = tracker.feed(pkt({ DistanceTraveled: 750, CurrentLap: 73, LapNumber: 1 }));
    expect(r2!.deltaToBest).toBeCloseTo(-2.0, 1);
    expect(r2!.estimatedLap).toBeCloseTo(88.0, 1);
  });
});

describe("SectorTracker sector detection", () => {
  test("sector transitions at correct fractions", () => {
    const tracker = new SectorTracker();
    tracker._initForTest({ s1End: 0.33, s2End: 0.66, trackLength: 3000 });

    // Init
    tracker.feed(pkt({ DistanceTraveled: 0, CurrentLap: 0, LapNumber: 1 }));

    // In S1
    const r1 = tracker.feed(pkt({ DistanceTraveled: 500, CurrentLap: 15, LapNumber: 1 }));
    expect(r1!.currentSector).toBe(0);

    // Cross into S2 (at 33% = 990m)
    const r2 = tracker.feed(pkt({ DistanceTraveled: 1000, CurrentLap: 30, LapNumber: 1 }));
    expect(r2!.currentSector).toBe(1);

    // Cross into S3 (at 66% = 1980m)
    const r3 = tracker.feed(pkt({ DistanceTraveled: 2000, CurrentLap: 60, LapNumber: 1 }));
    expect(r3!.currentSector).toBe(2);
  });

  test("lap boundary resets sector to 0", () => {
    const tracker = new SectorTracker();
    tracker._initForTest({ s1End: 0.33, s2End: 0.66, trackLength: 3000 });

    tracker.feed(pkt({ DistanceTraveled: 0, CurrentLap: 0, LapNumber: 1 }));
    tracker.feed(pkt({ DistanceTraveled: 2500, CurrentLap: 80, LapNumber: 1 }));

    // Lap boundary via LapNumber increment
    const r = tracker.feed(pkt({ DistanceTraveled: 3000, CurrentLap: 0, LapNumber: 2, LastLap: 90 }));
    expect(r!.currentSector).toBe(0);
  });

  test("CurrentLap reset triggers lap boundary", () => {
    const tracker = new SectorTracker();
    tracker._initForTest({ s1End: 0.33, s2End: 0.66, trackLength: 3000 });

    tracker.feed(pkt({ DistanceTraveled: 0, CurrentLap: 0, LapNumber: 1 }));
    // Drive to S3
    tracker.feed(pkt({ DistanceTraveled: 2500, CurrentLap: 80, LapNumber: 1 }));

    // CurrentLap reset (time trial mode — LapNumber stays same)
    const r = tracker.feed(pkt({ DistanceTraveled: 3000, CurrentLap: 0, LapNumber: 1, LastLap: 85 }));
    expect(r!.currentSector).toBe(0);
  });
});
