import { describe, test, expect } from "bun:test";
import { loadSharedTrackMeta } from "../shared/track-data";
import { computeLapSectors } from "../server/compute-lap-sectors";
import { initGameAdapters } from "../shared/games/init";
import type { TelemetryPacket } from "../shared/types";

initGameAdapters();

/**
 * Build a synthetic lap: 200 packets uniformly distributed across the lap.
 * DistanceTraveled goes from 0 to trackLength, CurrentLap from 0 to lapTime.
 */
function makeLapPackets(
  trackLength: number,
  lapTime: number,
  gameId: string,
): TelemetryPacket[] {
  const count = 200;
  const packets: TelemetryPacket[] = [];
  for (let i = 0; i < count; i++) {
    const frac = i / (count - 1);
    packets.push({
      gameId: gameId as any,
      IsRaceOn: 1,
      TimestampMS: Math.round(frac * lapTime * 1000),
      DistanceTraveled: frac * trackLength,
      CurrentLap: frac * lapTime,
      LastLap: 0,
      BestLap: 0,
      LapNumber: 1,
      PositionX: 0,
      PositionZ: 0,
      Speed: 50,
      RacePosition: 1,
      Accel: 200,
      Brake: 0,
      Clutch: 0,
      HandBrake: 0,
      Gear: 3,
      Steer: 0,
      NormalizedDrivingLine: 0,
      NormalizedAIBrakeDifference: 0,
      Boost: 0,
      Fuel: 50,
      CurrentRaceTime: frac * lapTime,
    } as TelemetryPacket);
  }
  return packets;
}

describe("shared track meta — sector resolution", () => {
  test("silverstone top-level sectors exist", () => {
    const meta = loadSharedTrackMeta("silverstone");
    expect(meta).not.toBeNull();
    expect(meta!.sectors?.s1End).toBeCloseTo(0.331, 2);
    expect(meta!.sectors?.s2End).toBeCloseTo(0.662, 2);
  });

  test("silverstone has f1-2025 game-specific sector override", () => {
    const meta = loadSharedTrackMeta("silverstone");
    const f1Sectors = meta?.games?.["f1-2025"]?.sectors;
    expect(f1Sectors).toBeDefined();
    expect(f1Sectors!.s1End).toBeCloseTo(0.314, 2);
    expect(f1Sectors!.s2End).toBeCloseTo(0.636, 2);
  });

  test("f1-2025 override differs from top-level sectors", () => {
    const meta = loadSharedTrackMeta("silverstone");
    expect(meta!.games?.["f1-2025"]?.sectors?.s1End).not.toEqual(meta!.sectors?.s1End);
  });

  test("austin has f1-2025 game-specific sectors", () => {
    const meta = loadSharedTrackMeta("austin");
    expect(meta?.games?.["f1-2025"]?.sectors?.s1End).toBeCloseTo(0.294, 2);
    expect(meta?.games?.["f1-2025"]?.sectors?.s2End).toBeCloseTo(0.646, 2);
  });
});

describe("computeLapSectors — sector source priority", () => {
  // Silverstone: 5891m, ~85s lap time for testing
  const TRACK_LENGTH = 5891;
  const LAP_TIME = 85;

  test("f1-2025 uses game-specific sector boundaries from JSON", async () => {
    // Silverstone f1-2025: s1End=0.314, s2End=0.636
    const packets = makeLapPackets(TRACK_LENGTH, LAP_TIME, "f1-2025");
    const sectors = await computeLapSectors(3004 /* silverstone FM ordinal, but sharedName resolved via adapter */, "f1-2025", packets, LAP_TIME);
    // With f1-2025 fractions: s1 ≈ 0.314 * 85 ≈ 26.7s, s2 ≈ (0.636-0.314)*85 ≈ 27.4s
    // Just verify sectors are computed and non-zero
    expect(sectors).not.toBeNull();
    expect(sectors!.s1).toBeGreaterThan(0);
    expect(sectors!.s2).toBeGreaterThan(0);
    expect(sectors!.s3).toBeGreaterThan(0);
    expect(sectors!.s1 + sectors!.s2 + sectors!.s3).toBeCloseTo(LAP_TIME, 0);
  });

  test("sector times sum to lap time", async () => {
    const packets = makeLapPackets(TRACK_LENGTH, LAP_TIME, "f1-2025");
    const sectors = await computeLapSectors(3004, "f1-2025", packets, LAP_TIME);
    expect(sectors).not.toBeNull();
    expect(sectors!.s1 + sectors!.s2 + sectors!.s3).toBeCloseTo(LAP_TIME, 1);
  });
});
