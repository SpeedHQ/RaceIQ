import { describe, test, expect } from "bun:test";
import type { TelemetryPacket } from "../shared/types";
import {
  detectSessionBoundary,
  detectLapBoundary,
  detectLapReset,
  type SessionSnapshot,
} from "../server/lap-detection";

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

const SESSION: SessionSnapshot = { carOrdinal: 100, trackOrdinal: 5 };
const NOW = 10_000_000; // large enough that NOW - 6min > 0

// ── detectSessionBoundary ─────────────────────────────────────────────────────

describe("detectSessionBoundary", () => {
  test("null session → no-session", () => {
    expect(detectSessionBoundary(null, 1, null, 0, pkt(), NOW)).toBe("no-session");
  });

  test("same car/track, no triggers → null (continue)", () => {
    expect(detectSessionBoundary(SESSION, 1, 2000, NOW, pkt(), NOW)).toBeNull();
  });

  test("car changed", () => {
    expect(
      detectSessionBoundary(SESSION, 1, 2000, NOW, pkt({ CarOrdinal: 999 }), NOW)
    ).toBe("car-changed");
  });

  test("track changed", () => {
    expect(
      detectSessionBoundary(SESSION, 1, 2000, NOW, pkt({ TrackOrdinal: 99 }), NOW)
    ).toBe("track-changed");
  });

  test("lap number reset from lap 5 → 1", () => {
    expect(
      detectSessionBoundary(SESSION, 5, 2000, NOW, pkt({ LapNumber: 1 }), NOW)
    ).toBe("lap-number-reset");
  });

  test("lap number reset not triggered when still on lap 1", () => {
    // currentLapNumber must be > 1
    expect(
      detectSessionBoundary(SESSION, 1, 2000, NOW, pkt({ LapNumber: 1 }), NOW)
    ).toBeNull();
  });

  test("distance reset (>1000m → <500m) without sessionUID", () => {
    // LapNumber matches currentLapNumber so lap-number-reset doesn't fire first
    expect(
      detectSessionBoundary(SESSION, 2, 1500, NOW, pkt({ LapNumber: 2, DistanceTraveled: 100 }), NOW)
    ).toBe("distance-reset");
  });

  test("distance reset ignored when session has UID (F1)", () => {
    const f1Session: SessionSnapshot = { ...SESSION, sessionUID: "abc123" };
    expect(
      detectSessionBoundary(f1Session, 2, 1500, NOW, pkt({ LapNumber: 2, DistanceTraveled: 100 }), NOW)
    ).toBeNull();
  });

  test("silence timeout after 5 minutes", () => {
    const lastPacketTime = NOW - 6 * 60_000;
    expect(
      detectSessionBoundary(SESSION, 1, 2000, lastPacketTime, pkt(), NOW)
    ).toBe("silence-timeout");
  });

  test("silence timeout not triggered within 5 minutes", () => {
    const lastPacketTime = NOW - 2 * 60_000;
    expect(
      detectSessionBoundary(SESSION, 1, 2000, lastPacketTime, pkt(), NOW)
    ).toBeNull();
  });

  test("silence timeout not triggered for F1 (has sessionUID)", () => {
    const f1Session: SessionSnapshot = { ...SESSION, sessionUID: "abc" };
    const lastPacketTime = NOW - 10 * 60_000;
    expect(
      detectSessionBoundary(f1Session, 1, 2000, lastPacketTime, pkt(), NOW)
    ).toBeNull();
  });

  test("F1 sessionUID changed", () => {
    const f1Session: SessionSnapshot = { ...SESSION, sessionUID: "old" };
    expect(
      detectSessionBoundary(f1Session, 1, 2000, NOW, pkt({ sessionUID: "new" }), NOW)
    ).toBe("session-uid-changed");
  });
});

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
