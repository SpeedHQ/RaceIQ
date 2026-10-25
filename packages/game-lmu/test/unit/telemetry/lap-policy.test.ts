import { describe, expect, test } from "bun:test";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import { LMU_LAP_DETECTOR_POLICY } from "@raceiq/telemetry-core/processor/lap-policy";

function packet(overrides: Partial<TelemetryPacket> = {}): TelemetryPacket {
  return {
    gameId: "lmu", LapNumber: 2, LastLap: 0, CurrentLap: 58, DistanceTraveled: 0,
    PositionX: 0, PositionZ: 0, ...overrides,
  } as TelemetryPacket;
}

function completeLap(): TelemetryPacket[] {
  return Array.from({ length: 30 }, (_, index) => packet({ DistanceTraveled: index * 4, CurrentLap: index * 2 }));
}

describe("LMU lap policy", () => {
  test("does not infer out-laps without pit-state evidence", () => {
    const longLmuLap = [...completeLap(), packet({ CurrentLap: 58, DistanceTraveled: 120 })];
    expect(LMU_LAP_DETECTOR_POLICY.resolveLapTime(longLmuLap, packet({ CurrentLap: 0 }))).toBe(58);
    expect(LMU_LAP_DETECTOR_POLICY.resolveLapTime(longLmuLap.slice(0, 30), packet({ CurrentLap: 0 }))).toBe(0);
    expect(LMU_LAP_DETECTOR_POLICY.classifyPitCycle(completeLap(), 0)).toBeNull();
    expect(LMU_LAP_DETECTOR_POLICY.classifyPitCycle(completeLap(), 1)).toBeNull();
  });

  test("treats a pit-started opening segment as incomplete rather than in-lap", () => {
    const packets = completeLap().map((item, index) => ({ ...item, lmu: { inPits: index < 4 || index > 26 } } as TelemetryPacket));
    expect(LMU_LAP_DETECTOR_POLICY.classifyPitCycle(packets, 0)).toBeNull();
    expect(LMU_LAP_DETECTOR_POLICY.invalidReason?.(packets, 0)).toBe("incomplete");
    const laterLap = completeLap().map((item, index) => ({ ...item, lmu: { inPits: index > 26 } } as TelemetryPacket));
    expect(LMU_LAP_DETECTOR_POLICY.classifyPitCycle(laterLap, 1)).toBe("inlap");
    expect(LMU_LAP_DETECTOR_POLICY.invalidReason?.(laterLap, 1)).toBeNull();
  });
});
