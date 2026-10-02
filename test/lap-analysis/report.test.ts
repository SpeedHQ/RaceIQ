import { describe, expect, test } from "bun:test";
import { generateExport } from "../../server/lap-analysis/report";
import { initGameAdapters } from "../../shared/games/init";
import type { TelemetryPacket } from "../../shared/telemetry/types";

initGameAdapters();

const lap = {
  lapNumber: 1,
  lapTime: 90,
  isValid: true,
  phase: "flying" as const,
  conditions: [],
  paceEligibility: "eligible" as const,
};

const basePacket = {
  gameId: "acc",
  CarClass: 0,
  CarOrdinal: 0,
  CarPerformanceIndex: 0,
  DrivetrainType: 0,
  VelocityX: 10,
  VelocityY: 0,
  VelocityZ: 0,
  CurrentEngineRpm: 4000,
  Accel: 128,
  Brake: 0,
  TireTempFL: 80,
  TireTempFR: 81,
  TireTempRL: 82,
  TireTempRR: 83,
  SuspensionTravelMFL: 0.05,
  SuspensionTravelMFR: 0.05,
  SuspensionTravelMRL: 0.06,
  SuspensionTravelMRR: 0.06,
  Gear: 3,
  DistanceTraveled: 100,
  TireWearFL: 0,
  TireWearFR: 0,
  TireWearRL: 0,
  TireWearRR: 0,
} as TelemetryPacket;

describe("lap report tire wear", () => {
  test("hides legacy zero-filled ACC tire wear", () => {
    const output = generateExport(lap, [basePacket]);

    expect(output).toContain(
      "--- Tire Wear ---\nUnavailable from simulator telemetry.",
    );
    expect(output).not.toContain("FL: 0.00  FR: 0.00");
  });

  test("keeps supported tire wear readings", () => {
    const output = generateExport(lap, [
      {
        ...basePacket,
        gameId: "ac-evo",
        TireWearFL: 0.1,
        TireWearFR: 0.2,
        TireWearRL: 0.3,
        TireWearRR: 0.4,
      },
    ]);

    expect(output).toContain(
      "FL: 0.10  FR: 0.20  RL: 0.30  RR: 0.40",
    );
  });
});
