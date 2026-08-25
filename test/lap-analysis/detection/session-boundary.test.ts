import { describe, test, expect } from "bun:test";
import type { TelemetryPacket } from "../../../shared/telemetry/types";
import { detectSessionBoundary, type SessionSnapshot } from "../../../server/lap-detection/boundaries";

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

  test("distance reset at a normal lap boundary stays in the session", () => {
    expect(
      detectSessionBoundary(
        SESSION,
        2,
        1500,
        NOW,
        pkt({ LapNumber: 3, DistanceTraveled: 100 }),
        NOW,
      ),
    ).toBeNull();
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


