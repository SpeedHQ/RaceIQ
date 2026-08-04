import { describe, test, expect } from "bun:test";
import type { TelemetryPacket } from "../../../shared/telemetry/types";
import { detectLapBoundary, detectLapReset } from "../../../server/lap-detection/boundaries";

function pkt(overrides: Partial<TelemetryPacket> = {}): TelemetryPacket {
  return {
    gameId: "fm-2023",
    IsRaceOn: 1,
    TimestampMS: 1000,
    LapNumber: 1,
    CurrentLap: 30,
    LastLap: 0,
    BestLap: 0,
    DistanceTraveled: 2000,
    CarOrdinal: 100,
    TrackOrdinal: 5,
    Speed: 50,
    PositionX: 0,
    PositionZ: 0,
    ...overrides,
  } as TelemetryPacket;
}

// ── detectLapBoundary ─────────────────────────────────────────────────────────

describe("detectLapBoundary", () => {
  test("normal +1 lap increment → complete", () => {
    expect(detectLapBoundary(3, pkt({ LapNumber: 4 }))).toEqual({ action: "complete" });
  });

  test("lap number went backward → reset-rewind", () => {
    expect(detectLapBoundary(5, pkt({ LapNumber: 3 }))).toEqual({ action: "reset-rewind" });
  });

  test("lap skip (+2) → complete-skip with reason", () => {
    const result = detectLapBoundary(3, pkt({ LapNumber: 5 }));
    expect(result.action).toBe("complete-skip");
    if (result.action === "complete-skip") {
      expect(result.invalidReason).toContain("3");
      expect(result.invalidReason).toContain("5");
    }
  });

  test("large lap skip (+5) → complete-skip", () => {
    expect(detectLapBoundary(1, pkt({ LapNumber: 6 }))).toMatchObject({ action: "complete-skip" });
  });
});

// ── detectLapReset ────────────────────────────────────────────────────────────

describe("detectLapReset", () => {
  function last(overrides: Partial<TelemetryPacket> = {}): TelemetryPacket {
    return pkt({ CurrentLap: 60, DistanceTraveled: 3000, ...overrides });
  }

  test("no reset condition → none", () => {
    // Distance must not drop >500m and CurrentLap must not reset to 0
    expect(detectLapReset(last(), 60, pkt({ CurrentLap: 61, DistanceTraveled: 3050 }))).toEqual({ action: "none" });
  });

  test("CurrentLap reset to 0 with LastLap unchanged → reset-restart", () => {
    expect(
      detectLapReset(last({ CurrentLap: 60 }), 0, pkt({ CurrentLap: 0, LastLap: 0 }))
    ).toEqual({ action: "reset-restart" });
  });

  test("CurrentLap reset to 0 with LastLap changed → complete-final-lap", () => {
    expect(
      detectLapReset(last({ CurrentLap: 60 }), 58.5, pkt({ CurrentLap: 0, LastLap: 60.1 }))
    ).toEqual({ action: "complete-final-lap" });
  });

  test("large distance drop with LastLap unchanged → reset-restart", () => {
    expect(
      detectLapReset(last({ DistanceTraveled: 3000 }), 0, pkt({ DistanceTraveled: 100, CurrentLap: 61 }))
    ).toEqual({ action: "reset-restart" });
  });

  test("large distance drop with LastLap changed → complete-final-lap", () => {
    expect(
      detectLapReset(last({ DistanceTraveled: 3000 }), 58.5, pkt({ DistanceTraveled: 100, LastLap: 60.1 }))
    ).toEqual({ action: "complete-final-lap" });
  });

  test("small distance drop (<500m) → none", () => {
    expect(
      detectLapReset(last({ DistanceTraveled: 3000 }), 0, pkt({ DistanceTraveled: 2600 }))
    ).toEqual({ action: "none" });
  });

  test("CurrentLap reset but was < 5s (warmup) → none", () => {
    // lastPkt.CurrentLap must be > 5 to trigger; keep distance stable so only CurrentLap check applies
    expect(
      detectLapReset(last({ CurrentLap: 3 }), 0, pkt({ CurrentLap: 0, DistanceTraveled: 3050 }))
    ).toEqual({ action: "none" });
  });
});
