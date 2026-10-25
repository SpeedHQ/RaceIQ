import { describe, test, expect } from "bun:test";
import { computeLapSectors } from "@raceiq/telemetry-core/processor/sectors";
import { initGameAdapters } from "@raceiq/game-catalogs/games/init";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";

initGameAdapters();
const TRACK_LENGTH = 5891;
function makeLapPackets(lapTime: number): TelemetryPacket[] {
  return Array.from({ length: 200 }, (_, i) => {
    const frac = i / 199;
    return {
      gameId: "lmu", IsRaceOn: 1, TimestampMS: Math.round(frac * lapTime * 1000),
      DistanceTraveled: frac * TRACK_LENGTH, CurrentLap: frac * lapTime, LastLap: 0, BestLap: 0,
      LapNumber: 1, PositionX: 0, PositionZ: 0, Speed: 50, RacePosition: 1,
      Accel: 200, Brake: 0, Clutch: 0, HandBrake: 0, Gear: 3, Steer: 0,
      NormalizedDrivingLine: 0, NormalizedAIBrakeDifference: 0, Boost: 0, Fuel: 50,
      CurrentRaceTime: frac * lapTime,
    } as unknown as TelemetryPacket;
  });
}

describe("LMU scoring sectors", () => {
  test("converts cumulative scoring splits to individual sector times", async () => {
    const packets = makeLapPackets(100);
    packets.at(-1)!.lmu = { lastSector1: 30, lastSector2: 65 } as TelemetryPacket["lmu"];
    expect(await computeLapSectors("", "lmu", packets, 100)).toEqual([30, 35, 35]);
  });
  test("falls back to distance sectors when cumulative splits are inconsistent", async () => {
    const packets = makeLapPackets(100);
    const fallback = await computeLapSectors("", "lmu", packets, 100);
    expect(fallback).not.toBeNull();
    packets.at(-1)!.lmu = { lastSector1: 30, lastSector2: 20 } as TelemetryPacket["lmu"];
    expect(await computeLapSectors("", "lmu", packets, 100)).toEqual(fallback);
  });
  test("rejects native splits that leave no final sector", async () => {
    const packets = makeLapPackets(100);
    packets[0]!.CurrentLap = 20;
    packets.at(-1)!.lmu = { lastSector1: 30, lastSector2: 100 } as TelemetryPacket["lmu"];
    expect(await computeLapSectors("", "lmu", packets, 100)).toBeNull();
  });
});
