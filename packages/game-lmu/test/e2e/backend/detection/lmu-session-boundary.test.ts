import { describe, test, expect } from "bun:test";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import { detectSessionBoundary, type SessionSnapshot } from "@raceiq/telemetry-core/processor/boundaries";

function packet(carId: string, trackId: string): TelemetryPacket {
  return {
    gameId: "lmu", IsRaceOn: 1, TimestampMS: 1000, LapNumber: 1, CurrentLap: 30,
    LastLap: 0, BestLap: 0, DistanceTraveled: 2000, Speed: 50,
    PositionX: 0, PositionZ: 0, carId, trackId,
  } as TelemetryPacket;
}

describe("LMU session boundary identity", () => {
  test("string car/track identity detects changes", () => {
    const session: SessionSnapshot = { carId: "Ferrari 499P", trackId: "LeMansWEC" };
    expect(detectSessionBoundary(session, 1, 2000, 10_000_000, packet("Ferrari 499P", "LeMansWEC"), 10_000_000)).toBeNull();
    expect(detectSessionBoundary(session, 1, 2000, 10_000_000, packet("Peugeot 9x8", "LeMansWEC"), 10_000_000)).toBe("car-changed");
    expect(detectSessionBoundary(session, 1, 2000, 10_000_000, packet("Ferrari 499P", "SpaWEC"), 10_000_000)).toBe("track-changed");
  });
});
