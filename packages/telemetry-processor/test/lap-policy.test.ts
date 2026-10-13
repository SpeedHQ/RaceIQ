import { describe, expect, test } from "bun:test";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import { assessLapRecording, DEFAULT_LAP_DETECTOR_POLICY, LMU_LAP_DETECTOR_POLICY } from "@raceiq/telemetry-core/processor/lap-policy";

function packet(overrides: Partial<TelemetryPacket> = {}): TelemetryPacket {
  return {
    gameId: "f1-2025",
    LapNumber: 2,
    LastLap: 0,
    CurrentLap: 58,
    DistanceTraveled: 0,
    PositionX: 0,
    PositionZ: 0,
    ...overrides,
  } as TelemetryPacket;
}

function completeLap(gameId: TelemetryPacket["gameId"] = "f1-2025"): TelemetryPacket[] {
  return Array.from({ length: 30 }, (_, index) => packet({
    gameId,
    DistanceTraveled: index * 4,
    CurrentLap: index * 2,
  }));
}

describe("portable lap policies", () => {
  test("preserves lap-quality validity thresholds and game exceptions", () => {
    const clean = completeLap();
    expect(assessLapRecording(clean, 58)).toEqual({ valid: true, reason: null });
    expect(assessLapRecording(clean.slice(0, 29), 58)).toEqual({ valid: false, reason: "too few telemetry packets" });
    expect(assessLapRecording(clean.map((item) => ({ ...item, DistanceTraveled: 0 })), 58)).toEqual({ valid: false, reason: "telemetry distance too short" });
    expect(assessLapRecording(clean, 55)).toEqual({ valid: false, reason: "telemetry lap time mismatch" });
    expect(assessLapRecording(clean, 59.5)).toEqual({ valid: true, reason: null });

    const far = clean.map((item, index) => ({ ...item, PositionX: index === 29 ? 21 : 0 }));
    expect(assessLapRecording(far, 58)).toEqual({ valid: false, reason: "start/end positions too far apart" });
    expect(assessLapRecording(far.map((item) => ({ ...item, gameId: "acc" as const })), 58)).toEqual({ valid: true, reason: null });

    const exactClosure = clean.map((item, index) => ({ ...item, PositionX: index === 29 ? 20 : 0 }));
    expect(assessLapRecording(exactClosure, 58)).toEqual({ valid: true, reason: null });

    const laterLap = clean.map((item) => ({ ...item, DistanceTraveled: item.DistanceTraveled + 15_000 }));
    expect(assessLapRecording(laterLap, 58)).toEqual({ valid: true, reason: null });

    const startingLap = completeLap("acc").map((item, index) => ({ ...item, LapNumber: 0, CurrentLap: index }));
    expect(assessLapRecording(startingLap, 29)).toEqual({ valid: false, reason: "starting lap" });
  });

  test("keeps default and LMU timing and first-outlap rules", () => {
    expect(DEFAULT_LAP_DETECTOR_POLICY.resolveLapTime([], packet({ LastLap: 92 }))).toBe(92);
    const longLmuLap = [...completeLap("lmu"), packet({ gameId: "lmu", CurrentLap: 58, DistanceTraveled: 120 })];
    expect(LMU_LAP_DETECTOR_POLICY.resolveLapTime(longLmuLap, packet({ gameId: "lmu", CurrentLap: 0 }))).toBe(58);
    expect(LMU_LAP_DETECTOR_POLICY.resolveLapTime(longLmuLap.slice(0, 30), packet({ gameId: "lmu", CurrentLap: 0 }))).toBe(0);
    expect(LMU_LAP_DETECTOR_POLICY.classifyPitCycle(completeLap("lmu"), 0)).toBe("outlap");
    expect(LMU_LAP_DETECTOR_POLICY.classifyPitCycle(completeLap("lmu"), 1)).toBeNull();
  });
});
