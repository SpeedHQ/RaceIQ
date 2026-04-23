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
  opts: { f1Sectors?: { s1: number; s2: number } } = {},
): TelemetryPacket[] {
  const count = 200;
  const packets: TelemetryPacket[] = [];
  for (let i = 0; i < count; i++) {
    const frac = i / (count - 1);
    const isLast = i === count - 1;
    const f1 = gameId === "f1-2025" && opts.f1Sectors
      ? {
          // SessionHistory exposes per-lap sector entries; the computation
          // code looks up lapSectors[LapNumber]. Stamp the final packet
          // with a populated entry.
          lastS1: isLast ? opts.f1Sectors.s1 : 0,
          lastS2: isLast ? opts.f1Sectors.s2 : 0,
          lastS3: isLast ? lapTime - opts.f1Sectors.s1 - opts.f1Sectors.s2 : 0,
          lapSectors: isLast
            ? {
                1: {
                  s1: opts.f1Sectors.s1,
                  s2: opts.f1Sectors.s2,
                  s3: lapTime - opts.f1Sectors.s1 - opts.f1Sectors.s2,
                  lapTime,
                },
              }
            : undefined,
        }
      : undefined;
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
      ...(f1 ? { f1 } : {}),
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

  test("f1-2025 uses sector times from F1 SessionHistory packet", async () => {
    const f1Sectors = { s1: 26.7, s2: 27.4 };
    const packets = makeLapPackets(TRACK_LENGTH, LAP_TIME, "f1-2025", { f1Sectors });
    const sectors = await computeLapSectors(3004, "f1-2025", packets, LAP_TIME);
    expect(sectors).not.toBeNull();
    expect(sectors!.s1).toBeCloseTo(f1Sectors.s1, 3);
    expect(sectors!.s2).toBeCloseTo(f1Sectors.s2, 3);
    expect(sectors!.s3).toBeCloseTo(LAP_TIME - f1Sectors.s1 - f1Sectors.s2, 3);
  });

  test("f1-2025 sector times sum to lap time", async () => {
    const f1Sectors = { s1: 27.123, s2: 28.456 };
    const packets = makeLapPackets(TRACK_LENGTH, LAP_TIME, "f1-2025", { f1Sectors });
    const sectors = await computeLapSectors(3004, "f1-2025", packets, LAP_TIME);
    expect(sectors).not.toBeNull();
    expect(sectors!.s1 + sectors!.s2 + sectors!.s3).toBeCloseTo(LAP_TIME, 3);
  });

  test("f1-2025 returns null when F1 packets don't carry sector times", async () => {
    // No opts.f1Sectors → no f1 sub-object. F1 must never fall back to
    // distance-fraction — the game is the authority on its own splits.
    const packets = makeLapPackets(TRACK_LENGTH, LAP_TIME, "f1-2025");
    const sectors = await computeLapSectors(3004, "f1-2025", packets, LAP_TIME);
    expect(sectors).toBeNull();
  });
});
